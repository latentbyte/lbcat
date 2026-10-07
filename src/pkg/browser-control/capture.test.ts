import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeTab } from "./capture";

describe("原生标签截图区域", () => {
  const captureTab = vi.fn();
  const executeScript = vi.fn();

  beforeEach(() => {
    captureTab.mockReset().mockResolvedValue("data:image/png;base64,test");
    executeScript.mockReset().mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);
    vi.stubGlobal("chrome", {
      tabs: { captureTab },
      scripting: { executeScript },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("小数元素边界应向外取整以匹配 CLI 整数尺寸", async () => {
    const element = document.createElement("div");
    element.id = "target";
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 1.4,
      y: 2.7,
      width: 100.2,
      height: 50.2,
      left: 1.4,
      top: 2.7,
      right: 101.6,
      bottom: 52.9,
      toJSON: () => ({}),
    });

    await expect(captureNativeTab(101, { selector: "#target" })).resolves.toMatchObject({ width: 101, height: 51 });
    expect(captureTab).toHaveBeenCalledWith(101, { format: "png", rect: { x: 1, y: 2, width: 101, height: 51 } });
  });

  it("空元素应报错且不调用截图 API", async () => {
    const element = document.createElement("div");
    element.id = "target";
    document.body.append(element);
    await expect(captureNativeTab(101, { selector: "#target" })).rejects.toThrow("no visible area");
    expect(captureTab).not.toHaveBeenCalled();
  });

  it.each([new Error("permission denied"), { message: "permission denied" }, "permission denied"])(
    "Firefox 注入错误应保留具体原因: %j",
    async (error) => {
      executeScript.mockResolvedValue([{ error }]);
      await expect(captureNativeTab(101, { selector: "#target" })).rejects.toThrow("permission denied");
      expect(captureTab).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["#missing", "element not found: #missing"],
    ["[", "not a valid selector"],
    ["#target", "no visible area"],
  ])("Firefox 不可克隆异常时仍应区分目标错误: %s", async (selector, message) => {
    const element = document.createElement("div");
    element.id = "target";
    document.body.append(element);
    executeScript.mockImplementation(async ({ func, args }) => {
      try {
        return [{ result: await func(...args) }];
      } catch {
        throw new Error("Script result is non-structured-clonable data");
      }
    });
    await expect(captureNativeTab(101, { selector })).rejects.toThrow(message);
  });
});

describe("前台截图回退契约", () => {
  const captureVisibleTab = vi.fn();
  const toDataURL = vi.fn();
  const drawImage = vi.fn();
  const listeners = new Set<(info: { tabId: number; windowId: number }) => void>();
  let activeTab = 102;
  let scrollX = 75;
  let scrollY = 230;
  let canvas: HTMLCanvasElement;
  let elementRect = { x: 50, y: 150, width: 200, height: 100 };

  beforeEach(() => {
    vi.useFakeTimers();
    activeTab = 102;
    scrollX = 75;
    scrollY = 230;
    elementRect = { x: 50, y: 150, width: 200, height: 100 };
    listeners.clear();
    captureVisibleTab.mockReset().mockResolvedValue("data:image/png;base64,test");
    toDataURL.mockReset().mockReturnValue("data:image/png;base64,canvas");
    drawImage.mockReset();
    canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockImplementation(toDataURL);
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => (tag === "canvas" ? canvas : createElement(tag)));
    vi.spyOn(document.documentElement, "scrollWidth", "get").mockReturnValue(1200);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1100);
    const element = createElement("div");
    element.id = "target";
    element.scrollIntoView = vi.fn();
    element.getBoundingClientRect = () => ({
      ...elementRect,
      left: elementRect.x,
      top: elementRect.y,
      right: elementRect.x + elementRect.width,
      bottom: elementRect.y + elementRect.height,
      toJSON: () => ({}),
    });
    document.body.append(element);
    vi.stubGlobal("window", {
      innerWidth: 600,
      innerHeight: 400,
      devicePixelRatio: 2,
      get scrollX() {
        return scrollX;
      },
      get scrollY() {
        return scrollY;
      },
      scrollTo(x: number, y: number) {
        scrollX = Math.max(0, Math.min(600, x));
        scrollY = Math.max(0, Math.min(700, y));
      },
    });
    vi.stubGlobal(
      "Image",
      class {
        width = 1200;
        height = 800;
        onload?: () => void;
        set src(_value: string) {
          Promise.resolve().then(() => this.onload?.());
        }
      }
    );
    vi.stubGlobal("chrome", {
      tabs: {
        get: async (id: number) => ({ id, windowId: 7, active: activeTab === id }),
        update: async (id: number) => {
          activeTab = id;
        },
        captureVisibleTab,
        onActivated: {
          addListener: (listener: (info: { tabId: number; windowId: number }) => void) => listeners.add(listener),
          removeListener: (listener: (info: { tabId: number; windowId: number }) => void) => listeners.delete(listener),
        },
      },
      scripting: {
        executeScript: async ({ func, args = [] }: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
          { result: await func(...args) },
        ],
      },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function finish<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  }

  it("整页截图应包含水平溢出和底部钳制后的全部区域", async () => {
    await expect(finish(captureNativeTab(101, { fullPage: true, allowForeground: true }))).resolves.toMatchObject({
      width: 1200,
      height: 1100,
    });
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(2200);
    expect(captureVisibleTab).toHaveBeenCalledTimes(6);
    expect(drawImage.mock.calls.some((call) => call[5] === 1200)).toBe(true);
    expect({ scrollX, scrollY }).toEqual({ scrollX: 75, scrollY: 230 });
    expect(listeners.size).toBe(0);
  });

  it.each([0, 95])("整页 JPEG 最终编码应保留质量 %i", async (quality) => {
    await finish(captureNativeTab(101, { fullPage: true, allowForeground: true, format: "jpeg", quality }));
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", quality / 100);
  });

  it.each([0, 95])("元素 JPEG 最终编码应保留质量 %i", async (quality) => {
    await finish(captureNativeTab(101, { selector: "#target", allowForeground: true, format: "jpeg", quality }));
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", quality / 100);
  });

  it("超出视口的元素应明确报错而非输出缺失像素的图片", async () => {
    elementRect = { x: -250, y: -250, width: 1100, height: 900 };
    const assertion = expect(captureNativeTab(101, { selector: "#target", allowForeground: true })).rejects.toThrow(
      "cannot capture an element outside the viewport"
    );
    await finish(assertion);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect({ scrollX, scrollY }).toEqual({ scrollX: 75, scrollY: 230 });
  });

  it.each([
    ["#missing", "element not found: #missing"],
    ["[", "not a valid selector"],
    ["#target", "no visible area"],
  ])("回退截图应区分目标错误并恢复滚动: %s", async (selector, message) => {
    elementRect.width = 0;
    await finish(expect(captureNativeTab(101, { selector, allowForeground: true })).rejects.toThrow(message));
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect({ scrollX, scrollY }).toEqual({ scrollX: 75, scrollY: 230 });
  });

  it("外部切换标签时应拒绝截图并清理监听器", async () => {
    captureVisibleTab.mockImplementation(async () => {
      activeTab = 102;
      for (const listener of listeners) listener({ tabId: 102, windowId: 7 });
      return "data:image/png;base64,test";
    });
    await finish(
      expect(captureNativeTab(101, { fullPage: true, allowForeground: true })).rejects.toThrow("focus changed")
    );
    expect(listeners.size).toBe(0);
    expect({ scrollX, scrollY }).toEqual({ scrollX: 75, scrollY: 230 });
    expect(activeTab).toBe(102);
  });
});
