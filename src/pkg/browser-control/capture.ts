import { debuggerAvailable, withDebugger } from "@App/app/service/agent/service_worker/dom_cdp";
import { BrowserControlScopeError } from "./agent-window";
import { withNativeTabOperation } from "./tab-operation";

export { withNativeTabOperation } from "./tab-operation";

export type NativeScreenshotOptions = {
  selector?: string;
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
  allowForeground?: boolean;
  timeoutMs?: number;
};

export type NativeScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
};

type CaptureArea = { x: number; y: number; width: number; height: number };
type CaptureTabs = typeof chrome.tabs & {
  captureTab?: (tabId: number, options: chrome.extensionTypes.ImageDetails & { rect?: CaptureArea }) => Promise<string>;
};

const operations = new Map<string, Promise<void>>();
let nextVisibleCapture = 0;

// 不同标签可并发，同一标签或窗口的复合操作保持顺序
async function withOperation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(key);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  operations.set(key, pending);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (operations.get(key) === pending) operations.delete(key);
  }
}

export function withNativeWindowOperation<T>(windowId: number, action: () => Promise<T>): Promise<T> {
  return withOperation("window-" + windowId, action);
}

function readCaptureResult<T>(
  injection: { result?: T | { error: string } | null; error?: unknown } | undefined
): T | undefined {
  const result = injection?.result;
  const error =
    injection?.error ?? (result && typeof result === "object" && "error" in result ? result.error : undefined);
  if (error !== undefined) {
    if (error instanceof Error) throw error;
    const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
    throw new Error(message);
  }
  return result == null ? undefined : (result as T);
}

async function captureArea(tabId: number, options: NativeScreenshotOptions): Promise<CaptureArea> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector: string | null, fullPage: boolean) => {
      try {
        if (selector) {
          const element = document.querySelector(selector);
          if (!element) throw new Error("element not found: " + selector);
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) throw new Error("screenshot target has no visible area");
          const x = Math.floor(rect.left + window.scrollX);
          const y = Math.floor(rect.top + window.scrollY);
          return {
            x,
            y,
            width: Math.ceil(rect.right + window.scrollX) - x,
            height: Math.ceil(rect.bottom + window.scrollY) - y,
          };
        }
        const root = document.documentElement;
        const body = document.body;
        return {
          x: fullPage ? 0 : window.scrollX,
          y: fullPage ? 0 : window.scrollY,
          width: fullPage ? Math.max(root.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth) : window.innerWidth,
          height: fullPage
            ? Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight)
            : window.innerHeight,
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [options.selector ?? null, Boolean(options.fullPage)],
  });
  const area = readCaptureResult<CaptureArea>(result);
  if (!area || area.width <= 0 || area.height <= 0) {
    throw new Error("screenshot target has no visible area");
  }
  return area;
}

export function captureNativeTab(
  tabId: number,
  options: NativeScreenshotOptions,
  validateAccess?: () => Promise<void>
): Promise<NativeScreenshot> {
  return withNativeTabOperation(
    tabId,
    async () => {
      await validateAccess?.();
      const tabs = chrome.tabs as CaptureTabs;
      const format = options.format ?? "png";
      const quality = options.quality ?? 80;
      const captureOpts: chrome.extensionTypes.ImageDetails = { format, ...(format === "jpeg" ? { quality } : {}) };
      if (typeof tabs.captureTab === "function") {
        const area = await captureArea(tabId, options);
        const dataUrl = await tabs.captureTab(tabId, {
          ...captureOpts,
          ...(options.selector || options.fullPage ? { rect: area } : {}),
        });
        return { dataUrl, width: area.width, height: area.height };
      }
      // Chrome 有 debugger 权限时直接按标签捕获，不抢焦点也不滚动页面
      if (await debuggerAvailable()) {
        const area = await captureArea(tabId, options);
        const target = { tabId };
        return withDebugger(tabId, async () => {
          const result = (await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
            ...captureOpts,
            fromSurface: true,
            captureBeyondViewport: Boolean(options.selector || options.fullPage),
            ...(options.selector || options.fullPage ? { clip: { ...area, scale: 1 } } : {}),
          })) as { data: string };
          return { dataUrl: "data:image/" + format + ";base64," + result.data, width: area.width, height: area.height };
        });
      }
      if (!options.allowForeground) {
        throw new BrowserControlScopeError(
          "BACKGROUND_CAPTURE_UNAVAILABLE",
          "Background screenshot unavailable; foreground capture requires explicit permission"
        );
      }
      const tab = await chrome.tabs.get(tabId);
      return withNativeWindowOperation(tab.windowId, async () => {
        await validateAccess?.();
        return captureVisibleScreenshot(tabId, options);
      });
    },
    { timeoutMs: options.timeoutMs, label: "page.screenshot" }
  );
}

async function captureVisible(
  tabId: number,
  windowId: number,
  options: chrome.extensionTypes.ImageDetails
): Promise<string> {
  // captureVisibleTab 的额度属于整个扩展，而非某个窗口
  return withOperation("visible-capture", async () => {
    const delay = nextVisibleCapture - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    let focusChanged = false;
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId && info.tabId !== tabId) focusChanged = true;
    };
    chrome.tabs.onActivated.addListener(onActivated);
    try {
      const before = await chrome.tabs.get(tabId);
      if (!before.active || before.windowId !== windowId) throw new Error("tab focus changed during screenshot");
      nextVisibleCapture = Date.now() + 510;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      const after = await chrome.tabs.get(tabId);
      if (focusChanged || !after.active || after.windowId !== windowId) {
        throw new Error("tab focus changed during screenshot");
      }
      return dataUrl;
    } finally {
      chrome.tabs.onActivated.removeListener(onActivated);
    }
  });
}

async function captureVisibleScreenshot(tabId: number, options: NativeScreenshotOptions): Promise<NativeScreenshot> {
  const selector = options.selector || null;
  const format = options.format ?? "png";
  const quality = options.quality ?? 80;
  const fullPage = Boolean(options.fullPage);
  const tab = await chrome.tabs.get(tabId);
  let scroll: { x: number; y: number } | undefined;
  if (selector || fullPage) {
    const [position] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ x: window.scrollX, y: window.scrollY }),
    });
    scroll = readCaptureResult<{ x: number; y: number }>(position);
  }
  try {
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const captureOpts: chrome.extensionTypes.ImageDetails = {
      format,
      quality: format === "jpeg" ? quality : undefined,
    };

    if (fullPage && !selector) {
      const [dimsResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          scrollWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
            window.innerWidth
          ),
          scrollHeight: Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
            window.innerHeight
          ),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        }),
      });
      const dims = readCaptureResult<{
        scrollWidth: number;
        scrollHeight: number;
        viewportWidth: number;
        viewportHeight: number;
        dpr: number;
      }>(dimsResult);
      if (!dims) throw new Error("could not determine screenshot dimensions");

      if (dims.scrollHeight <= dims.viewportHeight && dims.scrollWidth <= dims.viewportWidth) {
        const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
        return { dataUrl, width: dims.viewportWidth, height: dims.viewportHeight };
      }

      const captures: { x: number; y: number; dataUrl: string }[] = [];
      for (let y = 0; y < dims.scrollHeight; y += dims.viewportHeight) {
        for (let x = 0; x < dims.scrollWidth; x += dims.viewportWidth) {
          const [scrollResult] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (scrollX: number, scrollY: number) => {
              window.scrollTo(scrollX, scrollY);
              return { x: window.scrollX, y: window.scrollY };
            },
            args: [x, y],
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const position = readCaptureResult<{ x: number; y: number }>(scrollResult);
          if (!position) throw new Error("could not determine screenshot scroll position");
          if (
            position.x > x ||
            position.x + dims.viewportWidth < Math.min(x + dims.viewportWidth, dims.scrollWidth) ||
            position.y > y ||
            position.y + dims.viewportHeight < Math.min(y + dims.viewportHeight, dims.scrollHeight)
          ) {
            throw new Error("could not scroll to the full screenshot area");
          }
          const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
          captures.push({ ...position, dataUrl });
        }
      }

      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const [stitchResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          capturesList: { x: number; y: number; dataUrl: string }[],
          totalWidth: number,
          totalHeight: number,
          vpWidth: number,
          vpHeight: number,
          dpr: number,
          mime: string,
          encodeQuality: number
        ) => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(totalWidth * dpr);
          canvas.height = Math.round(totalHeight * dpr);
          const ctx = canvas.getContext("2d")!;
          for (const capture of capturesList) {
            const img = new Image();
            img.src = capture.dataUrl;
            await new Promise((res, rej) => {
              img.onload = res;
              img.onerror = rej;
            });
            const sliceH = Math.min(vpHeight, totalHeight - capture.y);
            const sliceW = Math.min(vpWidth, totalWidth - capture.x);
            ctx.drawImage(
              img,
              0,
              0,
              Math.round(sliceW * dpr),
              Math.round(sliceH * dpr),
              Math.round(capture.x * dpr),
              Math.round(capture.y * dpr),
              Math.round(sliceW * dpr),
              Math.round(sliceH * dpr)
            );
          }
          return canvas.toDataURL(mime, mime === "image/jpeg" ? encodeQuality / 100 : undefined);
        },
        args: [
          captures,
          dims.scrollWidth,
          dims.scrollHeight,
          dims.viewportWidth,
          dims.viewportHeight,
          dims.dpr,
          mimeType,
          quality,
        ],
      });
      const dataUrl = readCaptureResult<string>(stitchResult);
      if (!dataUrl) throw new Error("could not stitch screenshot");
      return { dataUrl, width: dims.scrollWidth, height: dims.scrollHeight };
    }

    if (selector) {
      const [rectResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string) => {
          try {
            const el = document.querySelector(sel);
            if (!el) return null;
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) throw new Error("screenshot target has no visible area");
            const x = Math.floor(r.x);
            const y = Math.floor(r.y);
            const width = Math.ceil(r.right) - x;
            const height = Math.ceil(r.bottom) - y;
            if (x < 0 || y < 0 || x + width > window.innerWidth || y + height > window.innerHeight) {
              throw new Error(
                "foreground screenshot cannot capture an element outside the viewport; use background capture"
              );
            }
            return {
              x,
              y,
              width,
              height,
              dpr: window.devicePixelRatio || 1,
            };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
        args: [selector],
      });
      const rect = readCaptureResult<{ x: number; y: number; width: number; height: number; dpr: number }>(rectResult);
      if (!rect) throw new Error(`element not found: ${selector}`);

      await new Promise((resolve) => setTimeout(resolve, 150));
      const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

      const [cropResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          src: string,
          rx: number,
          ry: number,
          rw: number,
          rh: number,
          dpr: number,
          mime: string,
          encodeQuality: number
        ) => {
          const img = new Image();
          img.src = src;
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
          });
          const canvas = document.createElement("canvas");
          canvas.width = rw * dpr;
          canvas.height = rh * dpr;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, rx * dpr, ry * dpr, rw * dpr, rh * dpr, 0, 0, rw * dpr, rh * dpr);
          return canvas.toDataURL(mime, mime === "image/jpeg" ? encodeQuality / 100 : undefined);
        },
        args: [dataUrl, rect.x, rect.y, rect.width, rect.height, rect.dpr, mimeType, quality],
      });
      const cropped = readCaptureResult<string>(cropResult);
      if (!cropped) throw new Error("could not crop screenshot");
      return { dataUrl: cropped, width: rect.width, height: rect.height };
    }

    // 捕获当前可见视口
    const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
    const [vpResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    const vp = readCaptureResult<{ width: number; height: number }>(vpResult);
    return { dataUrl, width: vp?.width || 0, height: vp?.height || 0 };
  } finally {
    if (scroll) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x: number, y: number) => window.scrollTo(x, y),
        args: [scroll.x, scroll.y],
      });
    }
  }
}
