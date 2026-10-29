/**
 * @file
 * 功能 B：读取网页表单。
 *
 * @remarks
 * 扫描当前页面（含全部 frame）中的 `input` / `textarea` / `select`，
 * 以及容器内不含原生控件的 div 模拟自定义下拉（仅识别，不可填写），
 * 输出类型、标签、当前值及交互状态，作为功能 C 与后续字段匹配的数据源。
 *
 * 模块划分为两层：
 * - {@link readFieldsInDom}：运行在浏览器上下文，纯 DOM 实现，不依赖 Playwright；
 * - {@link scanFields}：运行在 Node 上下文，负责遍历 frame 并补充 frame 归属信息。
 *
 * 该划分使得浏览器侧的识别逻辑可整体迁移至 Phase 2 的 content script 中复用。
 */

import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import {
  AppError,
  DEFAULT_ENDPOINT,
  flushAndExit,
  openSession,
  parsePageIndex,
  reportError,
  summarize,
} from './connect-browser.ts';
import type { FieldInfo, FieldKind, LabelSource } from './types.ts';

/**
 * 浏览器上下文中采集到的原始控件数据，尚未附加 frame 归属信息。
 *
 * @remarks
 * 该结构需经 JSON 序列化跨越上下文边界，因此保持扁平且不含方法。
 * 控件大类不在此存储，由 {@link toKindOf} 在 Node 侧统一计算，以保持结构精简。
 */
interface RawField {
  /** DOM 标签名；div 模拟的自定义控件（无对应原生控件）为 `other`。 */
  tag: 'input' | 'textarea' | 'select' | 'other';
  /** 在该 frame 内 `input, textarea, select` 中的序号；自定义控件为 -1。 */
  localIndex: number;
  /** 原始 `type` 属性；`textarea` / `select` 取标签名本身。 */
  type: string;
  /** `name` 属性。 */
  name: string;
  /** `id` 属性。 */
  id: string;
  /** 推断出的标签文字。 */
  label: string;
  /** 标签的推断来源。 */
  labelSource: LabelSource;
  /** 推断过程中采集到的其他候选文本。 */
  candidates: string[];
  /** 外层自定义组件的类名，空字符串表示为原生控件。 */
  component: string;
  /** `placeholder` 属性。 */
  placeholder: string;
  /** 当前值。 */
  value: string;
  /** 是否可见。 */
  visible: boolean;
  /** 是否可交互。 */
  enabled: boolean;
  /** 是否只读。 */
  readonly: boolean;
  /** 是否必填。 */
  required: boolean;
}

/**
 * 在浏览器上下文中采集全部控件的原始信息。
 *
 * @remarks
 * 该函数会被序列化为字符串后在页面内执行，因此必须完全自包含：
 * 不得引用外部作用域的变量、函数或类型，也不得依赖任何构建期注入的辅助函数
 * （例如 esbuild `keepNames` 产生的 `__name` 包装）。
 *
 * 标签推断的分级策略与站点结构假设详见 {@link findLabel}。
 *
 * @returns 页面内全部控件的原始信息，顺序与 DOM 顺序一致。
 */
function readFieldsInDom(): RawField[] {
  /** 归一化文本：折叠空白并去除首尾空格。 */
  const normalize = (text: string | null | undefined): string =>
    (text ?? '').replace(/\s+/g, ' ').trim();

  /** 读取元素及其后代的全部文本。 */
  const textOf = (el: Element | null): string => normalize(el?.textContent);

  /**
   * 读取元素的文本，但剔除嵌套控件的内容。
   *
   * @remarks
   * 直接读取 `textContent` 会把下拉选中值、输入框现值一并带入，
   * 产生「手机号码*86」这类粘连标签。本函数克隆节点后移除其中的控件类后代，
   * 仅保留纯文本部分。
   */
  const textOfClean = (el: Element | null): string => {
    if (el === null) return '';
    const clone = el.cloneNode(true) as Element;
    clone
      .querySelectorAll('input, textarea, select, [class*="input"], [class*="select"], [class*="control"]')
      .forEach((node) => node.remove());
    return normalize(clone.textContent);
  };

  /**
   * 剥离标签文本中的提示前缀。
   *
   * @remarks
   * 例如「请选择证件类型」转换为「证件类型」。
   * 剥离后长度不足 2 时保留原文，避免将短标签截断为空。
   */
  const stripPrompt = (text: string): string => {
    const stripped = text.replace(/^(请选择|请输入)/, '').trim();
    return stripped.length >= 2 ? stripped : text;
  };

  /**
   * 清理标签文字：去除首尾的必填星号与冒号。
   *
   * @remarks
   * 例如「*专业名称:」转换为「专业名称」，「姓名*」转换为「姓名」。
   * 仅作用于最终输出的标签；候选列表保留原始文本，便于人工核对。
   */
  const cleanLabel = (text: string): string =>
    normalize(text)
      .replace(/^[\*＊※\s]+/, '')
      .replace(/[\s\*＊:：]+$/, '');

  /** 组件内部的占位提示词，不应作为字段标签。 */
  const PLACEHOLDER_WORDS =
    /^(请选择|请输入|请选择或输入|请选择日期|请选择时间|搜索|未选择|全部|不限)$/;

  /**
   * 组件类名关键词。
   *
   * @remarks
   * 祖先元素的类名中包含这些词时，说明当前仍位于自定义组件内部
   * （下拉、日期选择器、级联选择等）。这类层级的文本均为组件自身的占位提示，
   * 必须跳出组件后才能取得真实字段标签。
   */
  const COMPONENT_KEYWORDS = [
    'select', 'picker', 'dropdown', 'combobox', 'cascader', 'calendar', 'date', 'autocomplete', 'time',
  ];

  /** 读取元素的类名字符串；SVG 等元素的 className 非字符串，此时返回空串。 */
  const classOf = (el: Element): string => (typeof el.className === 'string' ? el.className : '');

  /** 在类名中匹配组件关键词，返回命中的类名片段；未命中返回空串。 */
  const matchComponent = (cls: string): string => {
    const hit = cls
      .split(/\s+/)
      .find((token) => token.split('-').some((part) => COMPONENT_KEYWORDS.includes(part)));
    return hit ?? '';
  };

  /**
   * 向上查找包裹该控件的自定义组件类名。
   *
   * @remarks
   * 找到即表示控件属于自定义组件（可点选且可输入），直接写入未必生效；
   * 未找到则视为原生控件。
   *
   * @param el - 目标控件元素。
   * @returns 组件类名；原生控件返回空字符串。
   */
  const findComponent = (el: Element): string => {
    let node: Element | null = el.parentElement;
    for (let depth = 0; depth < 8 && node !== null; depth += 1) {
      const hit = matchComponent(classOf(node));
      if (hit !== '') return hit;
      node = node.parentElement;
    }
    return '';
  };

  /**
   * 判断文本是否可作为字段标签。
   *
   * @remarks
   * 需同时满足：非空、长度不超过 30、不属于占位提示词。
   * 此外，不含中文且短于 4 个字符的文本（如区号「86」）亦判定为不可用，
   * 交由上层继续向更外层查找。
   */
  const usable = (text: string): boolean => {
    const clean = normalize(text);
    if (clean === '' || clean.length > 30 || PLACEHOLDER_WORDS.test(clean)) return false;
    const hasChinese = /[\u4e00-\u9fa5]/.test(clean);
    return hasChinese || clean.length >= 4;
  };

  /**
   * 在容器内部查找标签型节点并返回其文本。
   *
   * @param container - 待查找的容器元素。
   * @param el - 目标控件元素。
   * @param isChoice - 控件是否为单选/复选；为真时跳过选项标签。
   * @returns 标签文本；未找到返回空字符串。
   */
  const labelInContainer = (container: Element, el: Element, isChoice: boolean): string => {
    const hits = container.querySelectorAll('label, .label, [class*="label"], [class*="title"], .name, .title');
    for (const hit of hits) {
      // 组件内部的类 label 节点（如 mtd-select-filter-label，实为选中值/占位提示的展示位）
      // 不是字段标签：控件未选中时其文本是占位词，选中后则是选中值本身
      if (matchComponent(classOf(hit)) !== '') continue;
      // 单选/复选的选项通常也是 label 结构（如「<label><input type="radio">是</label>」），
      // 其文本是选项文字而非字段标签，命中时跳过并继续向后查找。
      if (
        isChoice &&
        (hit.contains(el) ||
          (hit.tagName.toLowerCase() === 'label' &&
            hit.querySelector('input[type="radio"], input[type="checkbox"]') !== null))
      ) {
        continue;
      }
      const text = stripPrompt(textOfClean(hit));
      return text.length <= 30 ? text : '';
    }
    return '';
  };

  /**
   * 在前置兄弟节点中查找标签型节点。
   *
   * @remarks
   * 国内招聘系统常见结构为「标签节点与控件容器并列」，
   * 即标签位于控件容器的前置兄弟位置，而非容器内部。
   * 因此该查找优先于容器内部查找执行。
   *
   * @param node - 起始节点，从其前置兄弟开始查找。
   * @param el - 目标控件元素。
   * @param isChoice - 控件是否为单选/复选；为真时跳过选项标签。
   * @returns 标签文本；未找到返回空字符串。
   */
  const labelInPrevSibling = (node: Element, el: Element, isChoice: boolean): string => {
    let prev: Element | null = node.previousElementSibling;
    for (let i = 0; i < 3 && prev !== null; i += 1) {
      // 组件内部节点（类名含组件关键词）不可能是字段标签
      const isLabelLike =
        (prev.tagName.toLowerCase() === 'label' || /label|title|name/i.test(classOf(prev))) &&
        matchComponent(classOf(prev)) === '';
      // 相邻的同组选项也是 label 结构，其文本（如「是」）不是字段标签
      const isOptionLabel =
        isChoice &&
        prev.tagName.toLowerCase() === 'label' &&
        (prev.contains(el) ||
          prev.querySelector('input[type="radio"], input[type="checkbox"]') !== null);
      if (isLabelLike && !isOptionLabel) {
        const text = stripPrompt(textOfClean(prev));
        if (text !== '' && text.length <= 30 && usable(text)) return text;
      }
      prev = prev.previousElementSibling;
    }
    return '';
  };

  /**
   * 推断控件标签，按可信度从高到低依次尝试。
   *
   * @remarks
   * 普通控件（文本框、下拉等）的推断顺序：
   * 1. `aria-label` / `aria-labelledby`；
   * 2. `<label for>` 显式关联；
   * 3. `<label>` 整体包裹；
   * 4. 容器结构推断（向上遍历至多 8 层，跳过自定义组件内部层级）；
   * 5. `placeholder` 属性；
   * 6. `name` / `id` 属性。
   *
   * 单选/复选控件的顺序不同：`label[for]` 与包裹 `<label>` 命中的通常是
   * 选项文字（如「是」「否」「同意」）而非字段标签，因此容器结构推断优先，
   * 关联标签仅作回退。
   *
   * 各级尝试中采集到的文本均记入候选列表，供人工核对标签识别结果。
   *
   * @param el - 目标控件元素。
   * @returns 标签文字、推断来源与候选文本列表。
   */
  const findLabel = (
    el: Element,
  ): { label: string; labelSource: LabelSource; candidates: string[] } => {
    const candidates: string[] = [];
    const note = (text: string): void => {
      const clean = normalize(text);
      if (clean !== '' && clean.length <= 30 && !candidates.includes(clean)) candidates.push(clean);
    };

    const isChoice =
      el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox');

    const fromLabelFor = (): string => {
      const id = el.getAttribute('id');
      if (id === null || id === '') return '';
      return textOf(document.querySelector(`label[for="${CSS.escape(id)}"]`));
    };

    const fromWrap = (): string => textOf(el.closest('label'));

    const fromNearby = (): { label: string; labelSource: LabelSource } | null => {
      // 向上遍历至多 8 层；仍位于自定义组件内部的层级一律跳过。
      let node: Element | null = el.parentElement;
      for (let depth = 0; depth < 8 && node !== null; depth += 1) {
        if (matchComponent(classOf(node)) === '') {
          const fromPrev = labelInPrevSibling(node, el, isChoice);
          note(fromPrev);
          if (usable(fromPrev)) return { label: fromPrev, labelSource: 'nearby' };

          const fromContainer = labelInContainer(node, el, isChoice);
          note(fromContainer);
          if (usable(fromContainer)) return { label: fromContainer, labelSource: 'nearby' };
        }
        node = node.parentElement;
      }
      return null;
    };

    const ariaLabel = normalize(el.getAttribute('aria-label'));
    note(ariaLabel);
    if (usable(ariaLabel)) return { label: ariaLabel, labelSource: 'aria', candidates };

    const labelledBy = normalize(el.getAttribute('aria-labelledby'));
    if (labelledBy !== '') {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter((part) => part !== '')
        .join(' ');
      note(text);
      if (usable(text)) return { label: text, labelSource: 'aria', candidates };
    }

    if (isChoice) {
      const nearby = fromNearby();
      if (nearby !== null) return { ...nearby, candidates };

      const labelText = fromLabelFor();
      note(labelText);
      if (usable(labelText)) return { label: labelText, labelSource: 'label-for', candidates };

      const wrapText = fromWrap();
      note(wrapText);
      if (usable(wrapText)) return { label: wrapText, labelSource: 'label-wrap', candidates };
    } else {
      const labelText = fromLabelFor();
      note(labelText);
      if (usable(labelText)) return { label: labelText, labelSource: 'label-for', candidates };

      const wrapText = fromWrap();
      note(wrapText);
      if (usable(wrapText)) return { label: wrapText, labelSource: 'label-wrap', candidates };

      const nearby = fromNearby();
      if (nearby !== null) return { ...nearby, candidates };
    }

    const placeholder = normalize(el.getAttribute('placeholder'));
    note(placeholder);
    if (usable(placeholder)) return { label: placeholder, labelSource: 'placeholder', candidates };

    const attrName = normalize(el.getAttribute('name')) || normalize(el.getAttribute('id'));
    note(attrName);
    if (usable(attrName)) return { label: attrName, labelSource: 'name', candidates };

    return { label: '', labelSource: 'none', candidates };
  };

  /**
   * 读取控件当前值。
   *
   * @remarks
   * 复选框与单选按钮取勾选状态，其余取 `value` 属性。
   */
  const readValue = (el: Element): string => {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') {
        return el.checked ? 'checked' : 'unchecked';
      }
      return el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value;
    if (el instanceof HTMLSelectElement) return el.value;
    return '';
  };

  /**
   * 读取组件类控件的显示值。
   *
   * @remarks
   * mtd-select-filter 一类的筛选组件，其 `input` 不承载选中值（`value` 恒为空），
   * 选中值渲染在组件的展示节点中。此函数向上找到 8 层内最外层的组件祖先，
   * 克隆后剔除原生控件与占位/提示节点，取剩余文本作为显示值。
   *
   * 仅在原生值为空且控件可见时调用。
   *
   * @param el - 目标控件元素。
   * @returns 显示值；无法取得（如仍为占位提示）返回空字符串。
   */
  const readComponentValue = (el: Element): string => {
    let outermost: Element | null = null;
    let node: Element | null = el.parentElement;
    for (let depth = 0; depth < 8 && node !== null; depth += 1) {
      if (matchComponent(classOf(node)) !== '') outermost = node;
      node = node.parentElement;
    }
    if (outermost === null) return '';

    const clone = outermost.cloneNode(true) as Element;
    clone
      .querySelectorAll(
        'input, textarea, select, [class*="dropdown"], [class*="popup"], [class*="overlay"], [class*="option"], [class*="menu"], [class*="list"]',
      )
      .forEach((item) => item.remove());
    clone
      .querySelectorAll('[class*="placeholder"], [class*="hint"]')
      .forEach((item) => item.remove());
    const text = normalize(clone.textContent);
    if (text === '' || text.length > 50) return '';
    if (PLACEHOLDER_WORDS.test(text) || /^(请选择|请输入)/.test(text)) return '';
    const placeholder = normalize(el.getAttribute('placeholder'));
    if (placeholder !== '' && text === placeholder) return '';
    return text;
  };

  const nodes = Array.from(document.querySelectorAll('input, textarea, select'));
  const result: RawField[] = [];
  // 与 result 一一对应的节点引用，仅用于最终按 DOM 顺序排序，不随返回值序列化
  const order: Element[] = [];

  for (const el of nodes) {
    const tagName = el.tagName.toLowerCase();
    const tag: 'input' | 'textarea' | 'select' =
      tagName === 'textarea' ? 'textarea' : tagName === 'select' ? 'select' : 'input';

    const type = tag === 'input' ? (el as HTMLInputElement).type.toLowerCase() : tag;
    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      computed.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0;

    const found = findLabel(el);
    const component = findComponent(el);
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    const readonly =
      el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true';
    const rawValue = readValue(el);
    // 组件类控件（如 mtd-select-filter）的 input 不承载选中值，原生 value 为空时
    // 改读组件的展示文本，否则已选中的下拉会显示为「当前值=(空)」
    const value = rawValue === '' && component !== '' && visible ? readComponentValue(el) : rawValue;

    result.push({
      tag,
      type,
      localIndex: order.length,
      name: normalize(el.getAttribute('name')),
      id: normalize(el.getAttribute('id')),
      label: cleanLabel(found.label),
      labelSource: found.labelSource,
      candidates: found.candidates,
      component,
      placeholder: normalize(el.getAttribute('placeholder')),
      value,
      visible,
      enabled: !disabled,
      readonly,
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    });
    order.push(el);
  }

  /**
   * 读取自定义控件的显示文本，剔除组件内部的占位提示文本。
   *
   * @remarks
   * 下拉组件通常同时保留「占位提示」与「当前选中值」两个节点，
   * 直接读取 textContent 会得到「请选择学习形式全日制」这类拼接结果。
   */
  const textOfWidget = (el: Element): string => {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[class*="placeholder"]').forEach((node) => node.remove());
    return normalize(clone.textContent);
  };

  // —— div 模拟的自定义下拉（容器内不含任何原生控件）——
  // 此类控件不产生 input/textarea/select 节点，上面的循环扫描不到（京东站点的
  // 「学习形式」「专业成绩排名」即属此类）。按组件类名关键词识别，
  // 记为 tag=other / kind=combobox，仅作识别，不可自动填写。
  const utilityTokens = new Set(['select-none', 'select-text', 'select-all', 'select-auto']);
  /** 类名中的结构噪声词：下拉菜单项、链接、箭头等，不是可选择的控件本体。 */
  const NOISE_PARTS = ['link', 'menu', 'item', 'option', 'list', 'panel', 'trigger', 'icon', 'arrow'];

  for (const el of document.querySelectorAll(
    '[class*="select"], [class*="picker"], [class*="dropdown"], [class*="cascader"], [class*="combobox"]',
  )) {
    // 须命中组件类名关键词；再排除 CSS 工具类（如 tailwind 的 select-none）造成的子串误命中
    const tokens = classOf(el)
      .split(/\s+/)
      .filter((token) => token.split('-').some((part) => COMPONENT_KEYWORDS.includes(part)))
      // 排除下拉菜单项一类结构（如 ant-dropdown-link），它们不是字段本体
      .filter((token) => !token.split('-').some((part) => NOISE_PARTS.includes(part)));
    if (tokens.length === 0) continue;
    const component = tokens.find((token) => !utilityTokens.has(token));
    if (component === undefined) continue;

    // 容器内已有原生控件的组件（如 mtd-select），已在原生循环中按控件报告，避免重复
    if (el.querySelector('input, textarea, select') !== null) continue;

    // 嵌套组件只报最外层
    let ancestor: Element | null = el.parentElement;
    let nested = false;
    for (let depth = 0; depth < 8 && ancestor !== null; depth += 1) {
      if (matchComponent(classOf(ancestor)) !== '') {
        nested = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nested) continue;

    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      computed.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0;
    if (!visible) continue;

    const rawText = normalize(el.textContent);
    // 过长文本通常是误命中的普通区域，而非下拉的当前值
    if (rawText === '' || rawText.length > 50) continue;

    const found = findLabel(el);
    result.push({
      tag: 'other',
      type: 'custom-select',
      localIndex: -1,
      name: normalize(el.getAttribute('name')) || normalize(el.getAttribute('id')),
      id: normalize(el.getAttribute('id')),
      label: cleanLabel(found.label),
      labelSource: found.labelSource,
      candidates: found.candidates,
      component,
      placeholder: '',
      // 未选中时占位提示被剔除，值为空，此时输出「当前值=(空)」而非跳过该字段
      value: textOfWidget(el),
      visible: true,
      enabled: true,
      readonly: false,
      required: el.getAttribute('aria-required') === 'true',
    });
    order.push(el);
  }

  // 自定义控件是分两轮采集的，直接拼接会让它们全部排在原生控件之后，与页面位置不符。
  // 这里按 DOM 先后位置合并排序，使输出顺序与页面顺序一致。
  const entries = result.map((field, i) => ({ field, node: order[i] }));
  entries.sort((a, b) => {
    const left = a.node;
    const right = b.node;
    if (left === undefined || right === undefined) return 0;
    const position = left.compareDocumentPosition(right);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
    if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
    return 0;
  });

  return entries.map((entry) => entry.field);
}

/**
 * 功能 B：扫描页面全部 frame 中的表单控件。
 *
 * @remarks
 * 必须遍历 `page.frames()`：企业招聘系统的表单常置于 iframe 中，
 * 仅扫描主 frame 会得到空结果。
 *
 * 单个 frame 读取失败时（例如被 CSP 拦截或正处于导航过程）仅记录警告并继续，
 * 不中断整体扫描，以保证部分可用结果仍可输出。
 *
 * @param page - 目标标签页。
 * @returns 全部字段信息，序号跨 frame 连续递增。
 */
export async function scanFields(page: Page): Promise<FieldInfo[]> {
  const fields: FieldInfo[] = [];
  const frames = page.frames();

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    if (frame === undefined) continue;

    let rawFields: RawField[];
    try {
      rawFields = await frame.evaluate(readFieldsInDom);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[跳过] frame ${frameIndex} 读取失败：${message}`);
      continue;
    }

    for (let localIndex = 0; localIndex < rawFields.length; localIndex += 1) {
      const raw = rawFields[localIndex];
      if (raw === undefined) continue;

      fields.push({
        index: fields.length,
        frameIndex,
        localIndex: raw.localIndex,
        frameUrl: frame.url(),
        tag: raw.tag,
        kind: toKindOf(raw),
        inputType: raw.type,
        name: raw.name,
        id: raw.id,
        label: raw.label,
        labelSource: raw.labelSource,
        labelCandidates: raw.candidates,
        component: raw.component,
        placeholder: raw.placeholder,
        value: raw.value,
        visible: raw.visible,
        enabled: raw.enabled,
        readonly: raw.readonly,
        required: raw.required,
      });
    }
  }

  return fields;
}

/**
 * 依据原始控件数据判定控件大类。
 *
 * @remarks
 * 被自定义组件包裹的控件归类为 `combobox`，以区别于可直接写入的原生文本框。
 *
 * @param raw - 浏览器侧采集到的原始控件数据。
 * @returns 控件大类。
 */
function toKindOf(raw: RawField): FieldKind {
  if (raw.tag === 'textarea') return 'textarea';
  if (raw.tag === 'select') return 'select';
  if (raw.tag === 'other') return 'combobox';
  if (raw.type === 'file') return 'file';
  if (raw.type === 'hidden') return 'hidden';
  if (raw.type === 'checkbox') return 'checkbox';
  if (raw.type === 'radio') return 'radio';
  if (raw.type === 'password') return 'password';
  if (raw.type === 'button' || raw.type === 'submit' || raw.type === 'reset') return 'button';
  if (raw.component !== '') return 'combobox';
  if (['text', 'tel', 'email', 'search', 'number'].includes(raw.type)) return 'text';
  return 'other';
}

/**
 * 将字段信息格式化为单行输出。
 *
 * @remarks
 * 当标签来源为 `placeholder`、`name` 或未识别时，附加输出候选文本，
 * 便于人工判断真实标签。
 *
 * @param field - 字段信息。
 * @returns 单行输出文本。
 */
function formatField(field: FieldInfo): string {
  const flags: string[] = [];
  if (!field.visible) flags.push('不可见');
  if (!field.enabled) flags.push('禁用');
  if (field.readonly) flags.push('只读');
  if (field.required) flags.push('必填');
  const flagText = flags.length > 0 ? ` [${flags.join(' / ')}]` : '';

  const label = field.label === '' ? '(无标签)' : field.label;
  const value = field.value === '' ? '(空)' : field.value;

  const weak =
    field.labelSource === 'placeholder' || field.labelSource === 'name' || field.labelSource === 'none';
  const candidateText =
    weak && field.labelCandidates.length > 0
      ? ` 候选=[${field.labelCandidates.slice(0, 3).join(' | ')}]`
      : '';

  return [
    `[${String(field.index).padStart(2, '0')}]`,
    `frame${field.frameIndex}`,
    `${field.tag}/${field.kind}`,
    `标签="${label}"(${field.labelSource})`,
    `组件=${field.component === '' ? '-' : field.component}`,
    `name=${field.name === '' ? '-' : field.name}`,
    `placeholder=${field.placeholder === '' ? '-' : field.placeholder}`,
    `当前值=${value}`,
    flagText,
    candidateText,
  ].join(' ');
}

/**
 * 功能 B 入口：输出页面信息与全部表单控件。
 *
 * @returns 进程退出码，正常为 0。
 * @throws {@link AppError} 页面内未发现任何可扫描控件。
 */
async function main(): Promise<number> {
  const pageIndex = parsePageIndex(process.argv[2]);
  const session = await openSession(DEFAULT_ENDPOINT, pageIndex);

  const summary = await summarize(session.page);
  console.log('=== 当前页面 ===');
  console.log(`网址：${summary.url}`);
  console.log(`标题：${summary.title}`);
  console.log('');

  const fields = await scanFields(session.page);
  console.log(`=== 表单字段（共 ${fields.length} 个）===`);

  if (fields.length === 0) {
    throw new AppError(
      '当前页面没有找到任何 input / textarea / select。',
      [
        '1) 确认选中的标签页就是表单页面（npm run connect 可以查看候选列表）',
        '2) 若表单为异步渲染，请等待页面加载完成后重新运行',
        '3) 部分站点使用 div 模拟输入框，此类控件不在本阶段扫描范围内',
      ].join('\n'),
    );
  }

  for (const field of fields) {
    console.log(formatField(field));
  }

  const counts = new Map<string, number>();
  for (const field of fields) {
    counts.set(field.kind, (counts.get(field.kind) ?? 0) + 1);
  }
  const summaryText = [...counts.entries()].map(([kind, count]) => `${kind}=${count}`).join('，');

  console.log('');
  console.log(`按类型统计：${summaryText}`);
  console.log(`可填写的文本类：${fields.filter((f) => f.kind === 'text' || f.kind === 'textarea').length} 个`);

  // 不调用 browser.close()：CDP 模式下该操作会关闭用户正在使用的浏览器。
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().then(
    (code) => flushAndExit(code),
    (err: unknown) => {
      reportError(err);
      flushAndExit(1);
    },
  );
}
