// 页面视口尺寸：Chrome 以 CDP 按标签模拟视口（不受最小窗口尺寸限制）；
// Firefox 没有 debugger API，改为调整代理窗口外框，并加标题前缀供 bctl 在窗口管理器中找到该窗口
import { acquireDebugger, debuggerAvailable } from "@App/app/service/agent/service_worker/dom_cdp";
import { withNativeWindowOperation } from "./capture";

export type ViewportSize = { width: number; height: number };
export type ViewportTarget = { width?: number; height?: number };
export type ViewportResult = ViewportSize & {
  scope: "tab" | "window";
  exact?: boolean;
  // 窗口已改尺寸但页面未重新布局（Firefox 在隐藏的窗口中暂停布局），窗口显示后生效
  deferred?: boolean;
  titleMarker?: string;
};

type WindowBounds = Pick<chrome.windows.Window, "state" | "left" | "top" | "width" | "height">;

// 首次调整前的窗口外框，重置时恢复；Firefox 事件页会被卸载，所以存在 session 存储
const SAVED_BOUNDS_KEY = "browserControl.viewportBounds";

// 正在模拟尺寸的标签及其调试连接的释放函数
const emulatedTabs = new Map<number, () => Promise<void>>();
let watchingDetach = false;

type PageSize = ViewportSize & { outerWidth: number; outerHeight: number };

async function measurePage(tabId: number): Promise<PageSize> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    }),
  });
  const size = results?.[0]?.result;
  if (!size) throw new Error("viewport measurement produced no result");
  return size;
}

export async function measureViewport(tabId: number): Promise<ViewportSize> {
  const { width, height } = await measurePage(tabId);
  return { width, height };
}

// 页面看到的窗口外框（CSS 像素）与浏览器报告的不符，说明页面还停留在旧布局
async function layoutDeferred(tabId: number, windowId: number): Promise<boolean> {
  const [win, page, zoom] = await Promise.all([
    chrome.windows.get(windowId),
    measurePage(tabId),
    chrome.tabs.getZoom(tabId),
  ]);
  const off = (actual: number | undefined, css: number) =>
    actual !== undefined && Math.abs(actual - Math.round(css * zoom)) > 1;
  return off(win.width, page.outerWidth) || off(win.height, page.outerHeight);
}

function withDeferred<T extends object>(result: T, deferred: boolean): T & { deferred?: true } {
  return deferred ? { ...result, deferred: true } : result;
}

export function agentWindowTitleMarker(windowId: number): string {
  return `[bctl ${windowId}] `;
}

function matches(size: ViewportSize, target: ViewportTarget): boolean {
  return (
    (target.width === undefined || size.width === target.width) &&
    (target.height === undefined || size.height === target.height)
  );
}

// 尺寸变化异步生效；最小窗口尺寸可能使结果偏离目标
async function settledViewport(tabId: number, target: ViewportTarget): Promise<ViewportSize & { exact: boolean }> {
  let size = await measureViewport(tabId);
  for (let attempt = 0; attempt < 10 && !matches(size, target); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    size = await measureViewport(tabId);
  }
  return { ...size, exact: matches(size, target) };
}

export async function readViewport(tabId: number): Promise<ViewportResult> {
  return { ...(await measureViewport(tabId)), scope: (await debuggerAvailable()) ? "tab" : "window" };
}

export async function setViewport(tabId: number, windowId: number, target: ViewportTarget): Promise<ViewportResult> {
  return (await debuggerAvailable()) ? emulateViewport(tabId, target) : resizeAgentWindow(tabId, windowId, target);
}

export async function resetViewport(tabId: number, windowId: number): Promise<ViewportResult> {
  if (await debuggerAvailable()) {
    const release = emulatedTabs.get(tabId);
    if (release) {
      emulatedTabs.delete(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
      } finally {
        await release();
      }
    }
    return { ...(await measureViewport(tabId)), scope: "tab" };
  }
  await withNativeWindowOperation(windowId, async () => {
    const saved = await savedBounds();
    const bounds = saved[windowId];
    if (!bounds) return;
    await chrome.windows.update(
      windowId,
      bounds.state === "normal" || bounds.state === undefined
        ? { state: "normal", left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
        : { state: bounds.state }
    );
    delete saved[windowId];
    await chrome.storage.session.set({ [SAVED_BOUNDS_KEY]: saved });
  });
  return withDeferred(
    { ...(await measureViewport(tabId)), scope: "window" as const, titleMarker: agentWindowTitleMarker(windowId) },
    await layoutDeferred(tabId, windowId)
  );
}

// 只改视口尺寸：保留设备像素比，不开启移动端视口、触摸或 UA，与窗口方式的效果一致
async function emulateViewport(tabId: number, target: ViewportTarget): Promise<ViewportResult> {
  const current = await measureViewport(tabId);
  // 模拟尺寸以设备无关像素计，页面缩放后的 CSS 视口要乘回缩放比例
  const zoom = await chrome.tabs.getZoom(tabId);
  const size = {
    width: Math.round((target.width ?? current.width) * zoom),
    height: Math.round((target.height ?? current.height) * zoom),
  };
  if (!watchingDetach) {
    watchingDetach = true;
    // 用户取消调试横幅或标签关闭时模拟随会话结束
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) emulatedTabs.delete(source.tabId);
    });
  }
  const held = emulatedTabs.get(tabId);
  const release = held ?? (await acquireDebugger(tabId));
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      ...size,
      deviceScaleFactor: 0,
      mobile: false,
    });
  } catch (error) {
    if (!held) await release();
    throw error;
  }
  emulatedTabs.set(tabId, release);
  return { ...(await settledViewport(tabId, target)), scope: "tab" };
}

async function savedBounds(): Promise<Record<number, WindowBounds>> {
  const stored = await chrome.storage.session.get(SAVED_BOUNDS_KEY);
  return (stored[SAVED_BOUNDS_KEY] as Record<number, WindowBounds> | undefined) ?? {};
}

async function resizeAgentWindow(tabId: number, windowId: number, target: ViewportTarget): Promise<ViewportResult> {
  const titleMarker = agentWindowTitleMarker(windowId);
  return withNativeWindowOperation(windowId, async () => {
    const original = await chrome.windows.get(windowId);
    const saved = await savedBounds();
    if (!saved[windowId]) {
      const { state, left, top, width, height } = original;
      saved[windowId] = { state, left, top, width, height };
      await chrome.storage.session.set({ [SAVED_BOUNDS_KEY]: saved });
    }
    // titlePreface 仅 Firefox 支持（Chrome 走 CDP 分支）
    const prepare: chrome.windows.UpdateInfo & { titlePreface: string } = { titlePreface: titleMarker };
    if (original.state !== "normal") prepare.state = "normal";
    await chrome.windows.update(windowId, prepare);
    // 外框按页面自身的 outer/inner 差值换算：隐藏的窗口里页面布局可能落后于 windows.get 报告的尺寸。
    // 窗口尺寸以屏幕像素计，视口以 CSS 像素计，二者相差页面缩放
    const page = await measurePage(tabId);
    const zoom = await chrome.tabs.getZoom(tabId);
    const outer = (size: number | undefined, frame: number) =>
      size === undefined ? undefined : Math.round((size + frame) * zoom);
    await chrome.windows.update(windowId, {
      width: outer(target.width, page.outerWidth - page.width),
      height: outer(target.height, page.outerHeight - page.height),
    });
    const settled = await settledViewport(tabId, target);
    return withDeferred(
      { ...settled, scope: "window" as const, titleMarker },
      !settled.exact && (await layoutDeferred(tabId, windowId))
    );
  });
}
