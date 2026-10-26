/**
 * @file
 * 功能 C：填写输入框。
 *
 * @remarks
 * 流程为：重新扫描页面 → 依据标签与属性匹配目标字段 → 写入测试内容 → 回读验证。
 *
 * 每次运行均重新扫描页面。因程序不持有跨运行状态，且控件定位依赖于 DOM 顺序，
 * 页面在扫描后若发生重渲染会导致定位失效，因此不缓存任何定位信息。
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
import { scanFields } from './observe-page.ts';
import type { FieldInfo, FillResult } from './types.ts';

/**
 * 写入的测试内容。
 *
 * @remarks
 * 取值简短且不含特殊字符，以降低触发目标站点输入校验规则的概率。
 */
const TEST_VALUE = '张三';

/**
 * 明确不属于姓名字段的关键词。
 *
 * @remarks
 * 用于排除「用户名」「紧急联系人姓名」等包含姓名字样但语义不同的字段。
 * 该列表需随实测站点补充，无法穷举。
 */
const EXCLUDE_PATTERN = /拼音|英文名|用户名|账号|昵称|密码|电话|手机|邮箱|学校|公司|项目|父|母|紧急联系人/;

/**
 * 对字段与「姓名」的匹配程度打分，分值越高越可能是目标字段。
 *
 * @remarks
 * 评分顺序保证精确匹配优先于模糊匹配：先判「真实姓名」，再判「姓名」，
 * 其次依据 `name` 属性的常用命名，最后才使用包含匹配作为兜底。
 *
 * 这里不排除 `disabled` 字段：部分站点将个别字段置于其他页面维护，导致当前页呈现为禁用，
 * 该现象属于站点差异而非字段属性，不应作为通用过滤条件。
 * 确实无法写入时由 {@link fillAndVerify} 捕获并转换为可操作的提示。
 *
 * @param field - 待评分的字段。
 * @returns 匹配分值，0 表示不匹配。
 */
function scoreNameField(field: FieldInfo): number {
  if (field.kind !== 'text' && field.kind !== 'textarea') return 0;
  if (!field.visible || field.readonly) return 0;

  const text = `${field.label} ${field.placeholder} ${field.name} ${field.id}`;
  if (EXCLUDE_PATTERN.test(text)) return 0;

  if (/真实姓名/.test(field.label)) return 100;
  if (/姓名/.test(field.label)) return 90;
  if (/^(real_?name|full_?name|true_?name|name)$/i.test(field.name)) return 70;
  if (/姓名|name/i.test(text)) return 40;
  return 0;
}

/**
 * 功能 C：在扫描结果中选出得分最高的姓名字段。
 *
 * @param fields - 扫描得到的全部字段。
 * @returns 命中的字段；无匹配时返回 `null`。
 */
function pickNameField(fields: FieldInfo[]): FieldInfo | null {
  let best: FieldInfo | null = null;
  let bestScore = 0;

  for (const field of fields) {
    const score = scoreNameField(field);
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }

  return best;
}

/**
 * 功能 C：写入目标字段并回读验证。
 *
 * @remarks
 * 验证分三段，缺一不可：
 * 1. 写入后立即读回，确认值已进入控件；
 * 2. 若值未生效，改用原生 value setter 并派发 `input` / `change` 事件重试（受控组件常见需求）；
 * 3. 触发失焦后再次读回，检出受控组件在 blur 时回滚取值的情况。
 *
 * 控件定位采用「frame 下标 + frame 内控件下标」，并在定位前校验 frame 数量与控件数量，
 * 页面结构发生变化时直接报错，避免写入错误控件。
 *
 * @param page - 目标标签页。
 * @param field - 待填写的字段，须来源于本次扫描结果。
 * @param value - 待写入的内容。
 * @returns 填写结果，含三次读取的中间值。
 * @throws {@link AppError} 目标 frame 缺失、控件数量变化、控件不可见或处于禁用状态。
 */
async function fillAndVerify(page: Page, field: FieldInfo, value: string): Promise<FillResult> {
  const frames = page.frames();
  const frame = frames[field.frameIndex];
  if (frame === undefined) {
    throw new AppError(
      `找不到第 ${field.frameIndex} 个 frame，页面可能已经刷新。`,
      '重新运行本命令即可：每次运行都会重新扫描一遍页面。',
    );
  }

  const candidates = frame.locator('input, textarea, select');
  const total = await candidates.count();
  if (field.localIndex >= total) {
    throw new AppError(
      `第 ${field.frameIndex} 个 frame 里的控件数量变了（期望下标 ${field.localIndex}，实际只有 ${total} 个）。`,
      '页面结构可能在扫描后被重新渲染，请重新运行。',
    );
  }

  const locator = candidates.nth(field.localIndex);

  if (!(await locator.isVisible())) {
    throw new AppError(
      '目标输入框当前不可见，可能被折叠面板、弹窗或滚动区域遮挡。',
      '在浏览器中将该区域展开或滚动至可见位置，然后重新运行。',
    );
  }

  await locator.scrollIntoViewIfNeeded();
  // 部分自定义组件需获得焦点后才进入可输入状态；此处点击失败不影响后续写入。
  await locator.click({ timeout: 3000 }).catch(() => undefined);

  // 字段可能被站点设置为禁用，此时 fill 会抛出异常。
  // 将其转换为可操作的提示，而非直接输出 Playwright 原始错误信息。
  try {
    await locator.fill(value, { timeout: 5000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not enabled|disabled|not editable|readonly/i.test(message)) {
      throw new AppError(
        `目标输入框处于禁用状态，无法写入（标签="${field.label}"）。`,
        [
          '这是站点自身的设置，并非程序缺陷：',
          '1) 部分招聘站将个别字段置于其他页面维护（例如美团手机号在账号设置页），当前页仅作展示',
          '2) 请在对应页面启用或填写该字段后重新运行',
          '3) 或改以其他可编辑的姓名字段作为验证目标',
        ].join('\n'),
      );
    }
    throw err;
  }

  let valueAfterFill = await locator.inputValue();
  let usedFallback = false;

  // 受控组件可能不响应 fill()，此时改用原生 value setter 并手动派发事件。
  if (valueAfterFill !== value) {
    usedFallback = true;
    await locator.evaluate((el, next: string) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input) as object,
        'value',
      );
      if (descriptor !== undefined && typeof descriptor.set === 'function') {
        descriptor.set.call(input, next);
      } else {
        input.value = next;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    valueAfterFill = await locator.inputValue();
  }

  await locator.blur();
  const valueAfterBlur = await locator.inputValue();

  return {
    found: true,
    field,
    expected: value,
    valueAfterFill,
    valueAfterBlur,
    usedFallback,
    ok: valueAfterBlur === value,
  };
}

/**
 * 输出填写结果。
 *
 * @param result - 填写结果。
 */
function printResult(result: FillResult): void {
  console.log('');
  console.log('=== 功能 C：填写结果 ===');

  if (result.field === null) {
    console.log('未找到"姓名"输入框。');
    return;
  }

  const field = result.field;
  console.log(
    `命中字段：[${field.index}] frame${field.frameIndex} 标签="${field.label}"` +
      `(${field.labelSource}) name=${field.name === '' ? '-' : field.name}`,
  );
  console.log(`写入内容：${result.expected}`);
  console.log(`fill 后读回：${result.valueAfterFill === '' ? '(空)' : result.valueAfterFill}`);
  console.log(`失焦后读回：${result.valueAfterBlur === '' ? '(空)' : result.valueAfterBlur}`);
  if (result.usedFallback) {
    console.log('说明：fill() 未生效，已改用原生 setter 兜底（受控组件常见现象）。');
  }
  console.log(`结论：${result.ok ? '通过 ✅' : '未通过 ❌'}`);
}

/**
 * 未命中姓名字段时，列出页面中语义相近的字段，供扩充匹配规则参考。
 *
 * @param fields - 扫描得到的全部字段。
 */
function printRelatedFields(fields: FieldInfo[]): void {
  const related = fields.filter((field) => /姓名|name/i.test(`${field.label} ${field.name} ${field.id} ${field.placeholder}`));

  if (related.length === 0) {
    console.log('页面里没有出现任何带 "姓名 / name" 字样的字段。');
    return;
  }

  console.log('页面里带 "姓名 / name" 字样的字段：');
  for (const field of related) {
    console.log(
      `  [${field.index}] ${field.tag}/${field.kind} 标签="${field.label}"` +
        ` name=${field.name === '' ? '-' : field.name} 可见=${field.visible ? '是' : '否'}`,
    );
  }
}

/**
 * 功能 C 入口：定位姓名字段 → 写入测试内容 → 回读验证。
 *
 * @returns 进程退出码，验证通过为 0，未通过为 1。
 * @throws {@link AppError} 未找到可填写的姓名字段。
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
  console.log(`扫描到 ${fields.length} 个控件。`);

  const target = pickNameField(fields);
  if (target === null) {
    console.log('');
    printRelatedFields(fields);
    throw new AppError(
      '没有找到可填写的"姓名"输入框，功能 C 无法执行。',
      [
        '1) 确认当前标签页是表单页（npm run observe 可以查看全部字段）',
        '2) 若字段标签不是"姓名"，可在 fill-field.ts 的 scoreNameField 中补充关键词',
        '3) 若字段位于折叠面板或 iframe 中尚未渲染，请先在页面上展开',
      ].join('\n'),
    );
  }

  const result = await fillAndVerify(session.page, target, TEST_VALUE);
  printResult(result);

  // 不调用 browser.close()：CDP 模式下该操作会关闭用户正在使用的浏览器。
  if (result.ok) return 0;

  console.log('');
  console.log('验收要求"确认页面显示的值正确"，当前值不一致，请将现象记录到测试记录中。');
  console.log('常见原因：字段存在输入校验、值被前端框架回滚，或该输入框实为只读展示框。');
  return 1;
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
