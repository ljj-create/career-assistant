/**
 * @file
 * 全局共享的数据类型定义。
 *
 * @remarks
 * 本文件只声明类型，不包含任何运行时逻辑，供 `connect-browser`、
 * `observe-page`、`fill-field` 三个模块共同引用。
 *
 * 其中 `RawField`（定义在 `observe-page`）用于浏览器上下文与 Node 上下文之间的数据交换，
 * 必须保持扁平、可 JSON 序列化；`FieldInfo` 则是在此之上补充 frame 归属后的完整字段信息。
 */

import type { Browser, Page } from 'playwright-core';

/**
 * 页面摘要，对应验收项「输出当前网页的网址和标题」。
 */
export interface PageSummary {
  /** 页面地址。页面已关闭或尚未完成导航时为空字符串。 */
  url: string;
  /** 页面标题。读取失败时返回占位说明文本，不向外抛出异常。 */
  title: string;
  /** 页面是否已关闭。 */
  isClosed: boolean;
}

/**
 * 候选标签页条目，用于列出当前可操作的标签页清单供人工选择。
 */
export interface PageCandidate {
  /** 标签页序号，从 0 开始，与命令行传入的序号一致。 */
  index: number;
  /** 页面地址。 */
  url: string;
  /** 页面标题。 */
  title: string;
  /** 该标签页是否已关闭。 */
  isClosed: boolean;
}

/**
 * 一次 CDP 会话持有的对象：浏览器实例与当前选中的标签页。
 */
export interface BrowserSession {
  /** 通过 `connectOverCDP` 获取，代表用户正在使用的浏览器。禁止对其调用 `close()`。 */
  browser: Browser;
  /** 当前操作的标签页。 */
  page: Page;
}

/**
 * 控件大类。
 *
 * @remarks
 * 该分类用于决定后续处理策略，而非描述 DOM 标签本身：
 * - 可直接写入：`text`、`textarea`
 * - 需要点选交互：`select`、`combobox`、`checkbox`、`radio`
 * - 应跳过：`file`、`hidden`、`button`、`password`
 */
export type FieldKind =
  /** 原生单行文本框（`text` / `tel` / `email` / `search` / `number`） */
  | 'text'
  /** 密码框 */
  | 'password'
  /** 多行文本框 */
  | 'textarea'
  /** 原生下拉选择框 */
  | 'select'
  /** 自定义下拉、日期选择器等复合控件：可输入也可点选，直接写入未必生效 */
  | 'combobox'
  /** 复选框 */
  | 'checkbox'
  /** 单选按钮 */
  | 'radio'
  /** 附件上传 */
  | 'file'
  /** 按钮类（button / submit / reset） */
  | 'button'
  /** 隐藏字段 */
  | 'hidden'
  /** 未能归类 */
  | 'other';

/**
 * 字段标签的推断来源，按可信度从高到低排列。
 *
 * @remarks
 * 该值随字段一并输出。当标签识别有误时，可据此快速定位是哪一级推断失效，
 * 从而决定应补充针对具体站点的适配规则，而非调整通用逻辑。
 */
export type LabelSource =
  /** `aria-label` 或 `aria-labelledby` */
  | 'aria'
  /** `<label for="id">` 显式关联 */
  | 'label-for'
  /** 被 `<label>` 整体包裹 */
  | 'label-wrap'
  /** 由容器结构推断（前置兄弟节点或容器内的标签节点） */
  | 'nearby'
  /** 回退到 `placeholder` 属性 */
  | 'placeholder'
  /** 回退到 `name` / `id` 属性 */
  | 'name'
  /** 未识别 */
  | 'none';

/**
 * 单个表单控件的完整信息。
 */
export interface FieldInfo {
  /** 全页序号，跨 frame 连续递增，仅用于展示与人工定位。 */
  index: number;
  /** 所属 frame 的下标，0 为主 frame。 */
  frameIndex: number;
  /** 在该 frame 内 `input, textarea, select` 的下标，功能 C 据此重新定位控件；`-1` 表示无对应原生控件（`tag` 为 `other`）。 */
  localIndex: number;
  /** 所属 frame 的地址。 */
  frameUrl: string;
  /** DOM 标签名；div 模拟的自定义控件（无对应原生控件）为 `other`。 */
  tag: 'input' | 'textarea' | 'select' | 'other';
  /** 控件大类，决定处理策略。 */
  kind: FieldKind;
  /** 原始 `type` 属性；`textarea` / `select` 取标签名本身。 */
  inputType: string;
  /** `name` 属性，未设置为空字符串。 */
  name: string;
  /** `id` 属性，未设置为空字符串。 */
  id: string;
  /** 推断出的标签文字。 */
  label: string;
  /** 标签的推断来源。 */
  labelSource: LabelSource;
  /** 推断过程中采集到的其他候选文本，用于人工核对标签识别结果。 */
  labelCandidates: string[];
  /** 外层自定义组件的类名（如 `mtd-select`）；空字符串表示为原生控件。 */
  component: string;
  /** `placeholder` 属性，未设置为空字符串。 */
  placeholder: string;
  /** 当前值；复选框与单选按钮为 `checked` / `unchecked`。 */
  value: string;
  /** 是否在页面中可见。 */
  visible: boolean;
  /** 是否可交互（未被 `disabled`）。 */
  enabled: boolean;
  /** 是否只读。 */
  readonly: boolean;
  /** 是否必填。 */
  required: boolean;
}

/**
 * 一次填写操作的结果，包含三段回读验证的中间值。
 */
export interface FillResult {
  /** 是否定位到目标输入框。 */
  found: boolean;
  /** 命中的字段；未命中时为 `null`。 */
  field: FieldInfo | null;
  /** 期望写入的内容。 */
  expected: string;
  /** 写入后立即读回的值。 */
  valueAfterFill: string;
  /** 失焦后再次读回的值，用于检出受控组件回滚的情况。 */
  valueAfterBlur: string;
  /** 是否启用了原生 setter 兜底写入。 */
  usedFallback: boolean;
  /** 最终值是否与期望值一致。 */
  ok: boolean;
}
