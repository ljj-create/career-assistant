/**
 * @file
 * 功能 A（连接 Chrome）与功能 D（错误处理）的公共实现。
 *
 * @remarks
 * 本模块是所有命令的公共入口，负责：
 * 1. 通过 CDP 连接到以远程调试端口启动的 Chrome；
 * 2. 列出候选标签页并按序号选中目标页；
 * 3. 统一错误表示、错误输出与进程退出。
 *
 * 关键约束：CDP 模式下的 `Browser` 实例代表用户正在使用的浏览器，
 * 调用 `browser.close()` 会直接关闭该浏览器。因此本模块全程不关闭浏览器，
 * 仅在流程结束后断开连接并显式退出进程。
 */

import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { BrowserSession, PageCandidate, PageSummary } from './types.ts';

/**
 * 测试 Chrome 的默认调试地址。
 *
 * @remarks
 * 使用 `127.0.0.1` 而非 `localhost`，避免系统解析出 IPv6 地址（`::1`）导致连接失败。
 */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';

/**
 * 供使用者参考的 Chrome 启动命令，在连接失败提示中原样输出。
 *
 * @remarks
 * 命令中指定了独立的用户数据目录，原因有二：
 * - Chrome 136 起禁止对默认用户数据目录开启远程调试；
 * - 与用户日常使用的 Chrome 隔离，避免相互干扰。
 */
export const CHROME_START_COMMAND =
  '& "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe" ' +
  '--remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\\chrome-cdp-profile"';

/**
 * 面向使用者的可操作错误。
 *
 * @remarks
 * 将「发生了什么」与「接下来怎么办」分离：`message` 描述事实，`hint` 给出处置步骤。
 * 由 {@link reportError} 统一消费，保证任何错误路径都有可执行的下一步指引。
 */
export class AppError extends Error {
  /** 处置建议，通常为分步骤的操作清单。 */
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'AppError';
    this.hint = hint;
  }
}

/**
 * 统一输出错误信息，保证程序不会无提示地退出。
 *
 * @remarks
 * - {@link AppError} 按「事实 + 处置步骤」的格式输出；
 * - 其余错误归类为未预期错误，补充常见成因提示并附带调用栈，便于定位。
 *
 * @param err - 捕获到的任意异常对象。
 */
export function reportError(err: unknown): void {
  if (err instanceof AppError) {
    console.error('');
    console.error(`[失败] ${err.message}`);
    console.error('[可以这样排查]');
    console.error(err.hint);
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error(`[未预期的错误] ${message}`);

  if (/timeout/i.test(message)) {
    console.error('提示：页面可能仍在加载，或目标控件不可交互（被遮挡、未渲染完成）。');
  }

  if (err instanceof Error && err.stack !== undefined) {
    console.error(err.stack);
  }
}

/**
 * 冲刷输出流后结束进程。
 *
 * @remarks
 * 必须显式退出的原因：`connectOverCDP` 建立的 WebSocket 会持续占用事件循环，
 * 而 `browser.close()` 又不可调用，导致 `main` 执行完毕后进程不会自行结束。
 *
 * 必须冲刷两个流的原因：当输出被重定向到管道时，`stdout` 与 `stderr` 的写入均为异步。
 * 直接调用 `process.exit()` 会截断尚未写出的数据。由于错误信息走 `stderr`，
 * 仅冲刷 `stdout` 会在 `cmd 2>&1 | ...` 这类用法下丢失错误内容。
 *
 * @param code - 进程退出码，0 表示成功，1 表示失败。
 */
export function flushAndExit(code: number): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

/**
 * 功能 A：通过 CDP 连接到已启动的测试 Chrome。
 *
 * @remarks
 * 不做浏览器生命周期管理，调用方不得对返回的实例执行 `close()`。
 *
 * @param endpoint - 调试地址，默认 {@link DEFAULT_ENDPOINT}。
 * @returns 已连接的浏览器实例。
 * @throws {@link AppError} 浏览器未启动或 CDP 握手失败时抛出，并附带处置步骤。
 */
export async function connectBrowser(endpoint: string = DEFAULT_ENDPOINT): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(endpoint);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const looksLikeNotRunning = /ECONNREFUSED|ECONNRESET|connect|timed? ?out/i.test(raw);

    if (looksLikeNotRunning) {
      throw new AppError(
        `无法连接到 ${endpoint}：${raw}`,
        [
          '测试 Chrome 可能未启动，或启动时未附加 --remote-debugging-port 参数。',
          '1) 先关闭所有测试 Chrome 窗口（同一用户数据目录仅允许一个实例）',
          `2) 执行：${CHROME_START_COMMAND}`,
          `3) 访问 ${endpoint}/json/version，能返回 JSON 方表示启动成功`,
          '4) 在该 Chrome 中手动登录目标招聘网站，然后重新运行本程序',
        ].join('\n'),
      );
    }

    throw new AppError(
      `CDP 握手失败：${raw}`,
      [
        '调试端口可能被其他程序占用，或 Chrome 版本与 playwright-core 不兼容。',
        `可访问 ${endpoint}/json/version 确认端点是否正常响应；`,
        '必要时更换端口，并同步修改启动命令与程序中的 endpoint。',
      ].join('\n'),
    );
  }
}

/**
 * 收集所有浏览器上下文中的标签页。
 *
 * @remarks
 * CDP 连接下 `browser.pages()` 不可用，必须遍历各上下文再汇总。
 *
 * @param browser - 已连接的浏览器实例。
 * @returns 全部标签页，顺序与上下文遍历顺序一致。
 */
function collectPages(browser: Browser): Page[] {
  const pages: Page[] = [];
  for (const context of browser.contexts()) {
    pages.push(...context.pages());
  }
  return pages;
}

/**
 * 功能 A：读取单个页面的摘要信息。
 *
 * @remarks
 * 标题获取失败时降级为占位文本而非抛出异常：页面处于导航中间态时标题暂时不可读，
 * 这属于正常现象，不应中断整个流程。
 *
 * @param page - 目标标签页。
 * @returns 页面摘要。
 */
export async function summarize(page: Page): Promise<PageSummary> {
  if (page.isClosed()) {
    return { url: '', title: '(页面已关闭)', isClosed: true };
  }

  const url = page.url();
  try {
    const title = await page.title();
    return { url, title, isClosed: false };
  } catch {
    return { url, title: '(标题读取失败)', isClosed: false };
  }
}

/**
 * 功能 A：列出全部候选标签页，供使用者确认目标页面。
 *
 * @param browser - 已连接的浏览器实例。
 * @returns 候选标签页清单。
 */
export async function listPageCandidates(browser: Browser): Promise<PageCandidate[]> {
  const pages = collectPages(browser);
  const candidates: PageCandidate[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page === undefined) continue;
    const summary = await summarize(page);
    candidates.push({ index, url: summary.url, title: summary.title, isClosed: summary.isClosed });
  }

  return candidates;
}

/**
 * 判断是否为空白页或浏览器内部页面。
 *
 * @remarks
 * 内部页面（`chrome://`、`devtools://`）不含业务表单，默认不作为操作目标。
 *
 * @param page - 待判断的标签页。
 * @returns 属于空白页或内部页时返回 `true`。
 */
function isBlankPage(page: Page): boolean {
  const url = page.url();
  return (
    url === '' || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('devtools://')
  );
}

/**
 * 选取待操作的标签页。
 *
 * @remarks
 * - 指定序号时严格按序号选取，序号越界按功能 D 的要求给出明确报错；
 * - 未指定序号时采用「最后一个非空白页」策略，该页通常是用户最后打开的业务页面。
 *
 * 注意：序号基于本程序的候选列表，与浏览器自身的标签页排列不一定一致，
 * 且会随标签页增删而变化，因此每次运行前应先执行 `npm run connect` 确认。
 *
 * @param browser - 已连接的浏览器实例。
 * @param pageIndex - 标签页序号，从 0 开始；缺省时自动选取。
 * @returns 选中的标签页。
 * @throws {@link AppError} 无可用标签页，或指定序号不存在、已关闭。
 */
export async function openPage(browser: Browser, pageIndex?: number): Promise<Page> {
  const pages = collectPages(browser);

  if (pages.length === 0) {
    throw new AppError(
      '已连上 Chrome，但当前没有任何标签页。',
      '在测试 Chrome 中打开目标招聘网站页面（登录后进入表单页），然后重新运行本程序。',
    );
  }

  if (pageIndex !== undefined) {
    const picked = pages[pageIndex];
    if (picked === undefined || picked.isClosed()) {
      throw new AppError(
        `第 ${pageIndex} 个标签页不存在或已关闭（当前共 ${pages.length} 个，序号从 0 开始）。`,
        '先运行 npm run connect 查看候选列表，再用 npm run observe -- <序号> 指定。',
      );
    }
    return picked;
  }

  const usable = pages.filter((page) => !page.isClosed() && !isBlankPage(page));
  const fallback = usable.length > 0 ? usable[usable.length - 1] : pages.find((page) => !page.isClosed());

  if (fallback === undefined) {
    throw new AppError(
      '所有标签页均已关闭。',
      '在测试 Chrome 中重新打开目标招聘网站页面后重试。',
    );
  }

  return fallback;
}

/**
 * 建立连接并选取标签页，为三个功能模块提供统一入口。
 *
 * @param endpoint - 调试地址，默认 {@link DEFAULT_ENDPOINT}。
 * @param pageIndex - 标签页序号，从 0 开始；缺省时自动选取。
 * @returns 会话对象。
 */
export async function openSession(
  endpoint: string = DEFAULT_ENDPOINT,
  pageIndex?: number,
): Promise<BrowserSession> {
  const browser = await connectBrowser(endpoint);
  const page = await openPage(browser, pageIndex);
  return { browser, page };
}

/**
 * 解析命令行传入的标签页序号。
 *
 * @remarks
 * 支持 `npm run observe -- 2` 形式的调用；参数缺省视为未指定，交由 {@link openPage} 自动选取。
 *
 * @param raw - 原始参数字符串。
 * @returns 解析出的序号，缺省时返回 `undefined`。
 * @throws {@link AppError} 参数不是非负整数。
 */
export function parsePageIndex(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new AppError(
      `标签页序号不合法：${raw}`,
      '序号为从 0 开始的整数。先运行 npm run connect 查看候选列表。',
    );
  }
  return parsed;
}

/**
 * 输出候选标签页清单。
 *
 * @param candidates - 候选列表。
 */
function printCandidates(candidates: PageCandidate[]): void {
  console.log(`=== 候选标签页（共 ${candidates.length} 个）===`);
  for (const candidate of candidates) {
    const state = candidate.isClosed ? ' [已关闭]' : '';
    console.log(`  [${candidate.index}] ${candidate.title}${state}`);
    console.log(`      ${candidate.url}`);
  }
}

/**
 * 功能 A 入口：输出候选标签页与当前页面的网址、标题。
 *
 * @returns 进程退出码，正常为 0。
 */
async function main(): Promise<number> {
  const pageIndex = parsePageIndex(process.argv[2]);
  const session = await openSession(DEFAULT_ENDPOINT, pageIndex);

  const candidates = await listPageCandidates(session.browser);
  printCandidates(candidates);

  const summary = await summarize(session.page);
  console.log('');
  console.log('=== 功能 A：当前页面 ===');
  console.log(`调试端口：${DEFAULT_ENDPOINT}`);
  console.log(`网址：${summary.url}`);
  console.log(`标题：${summary.title}`);

  if (summary.url === '' || summary.url === 'about:blank') {
    console.log('');
    console.log('提示：当前选中的是空白页，请在测试 Chrome 中切换至招聘网站页面后重新运行。');
  }

  // 不调用 browser.close()：CDP 模式下该操作会关闭用户正在使用的浏览器。
  // 进程退出后连接自动断开，浏览器不受影响。
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
