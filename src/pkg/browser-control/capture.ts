import { withDebugger } from "@App/app/service/agent/service_worker/dom_cdp";

export type NativeScreenshotOptions = {
  selector?: string;
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
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

export function withNativeTabOperation<T>(tabId: number, action: () => Promise<T>): Promise<T> {
  return withOperation("tab-" + tabId, action);
}

export function withNativeWindowOperation<T>(windowId: number, action: () => Promise<T>): Promise<T> {
  return withOperation("window-" + windowId, action);
}

async function captureArea(tabId: number, options: NativeScreenshotOptions): Promise<CaptureArea> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector: string | null, fullPage: boolean) => {
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
    },
    args: [options.selector ?? null, Boolean(options.fullPage)],
  });
  if (!result?.result || result.result.width <= 0 || result.result.height <= 0) {
    throw new Error("screenshot target has no visible area");
  }
  return result.result;
}

export function captureNativeTab(tabId: number, options: NativeScreenshotOptions): Promise<NativeScreenshot> {
  return withNativeTabOperation(tabId, async () => {
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
    if (
      typeof chrome.debugger?.attach === "function" &&
      (await chrome.permissions.contains({ permissions: ["debugger"] }))
    ) {
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
    const tab = await chrome.tabs.get(tabId);
    return withNativeWindowOperation(tab.windowId, () => captureVisibleScreenshot(tabId, options));
  });
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
    scroll = position.result;
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
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        }),
      });
      const dims = dimsResult.result as {
        scrollWidth: number;
        scrollHeight: number;
        viewportWidth: number;
        viewportHeight: number;
        dpr: number;
      };

      if (dims.scrollHeight <= dims.viewportHeight) {
        const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
        return { dataUrl, width: dims.viewportWidth, height: dims.viewportHeight };
      }

      const captures: { y: number; dataUrl: string }[] = [];
      for (let y = 0; y < dims.scrollHeight; y += dims.viewportHeight) {
        const [scrollResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (scrollY: number) => {
            window.scrollTo(0, scrollY);
            return window.scrollY;
          },
          args: [y],
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const actualY = scrollResult.result ?? y;
        if (captures.at(-1)?.y === actualY) break;
        const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
        captures.push({ y: actualY, dataUrl });
      }

      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const [stitchResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          capturesList: { y: number; dataUrl: string }[],
          totalHeight: number,
          vpWidth: number,
          vpHeight: number,
          dpr: number,
          mime: string
        ) => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(vpWidth * dpr);
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
            ctx.drawImage(
              img,
              0,
              0,
              Math.round(vpWidth * dpr),
              Math.round(sliceH * dpr),
              0,
              Math.round(capture.y * dpr),
              Math.round(vpWidth * dpr),
              Math.round(sliceH * dpr)
            );
          }
          return canvas.toDataURL(mime);
        },
        args: [captures, dims.scrollHeight, dims.viewportWidth, dims.viewportHeight, dims.dpr, mimeType],
      });
      if (!stitchResult.result) throw new Error("could not stitch screenshot");
      return { dataUrl: stitchResult.result, width: dims.viewportWidth, height: dims.scrollHeight };
    }

    if (selector) {
      const [rectResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
            dpr: window.devicePixelRatio || 1,
          };
        },
        args: [selector],
      });
      if (!rectResult.result) throw new Error(`element not found: ${selector}`);
      const rect = rectResult.result as { x: number; y: number; width: number; height: number; dpr: number };

      await new Promise((resolve) => setTimeout(resolve, 150));
      const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

      const [cropResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (src: string, rx: number, ry: number, rw: number, rh: number, dpr: number, mime: string) => {
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
          return canvas.toDataURL(mime);
        },
        args: [dataUrl, rect.x, rect.y, rect.width, rect.height, rect.dpr, mimeType],
      });
      if (!cropResult.result) throw new Error("could not crop screenshot");
      return { dataUrl: cropResult.result, width: rect.width, height: rect.height };
    }

    // 捕获当前可见视口
    const dataUrl = await captureVisible(tabId, tab.windowId!, captureOpts);
    const [vpResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    const vp = vpResult.result as { width: number; height: number } | null;
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
