import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserIdentityFromUserAgent,
  disconnect,
  initNativeMessaging,
  focusNativeTab,
  limitNativeResponse,
  normalizeNativeTabEvent,
  tabToBrowserControlTab,
} from "./native-messaging";
import type { ScriptService } from "./script";
import { withNativeWindowOperation } from "@App/pkg/browser-control/capture";

describe("原生消息大小限制", () => {
  it("超限响应返回错误并保留请求 ID", () => {
    const response = {
      id: "request-1",
      type: "response" as const,
      payload: { cmd: "page.content", data: "é".repeat(30) },
    };

    expect(limitNativeResponse(response, 90)).toMatchObject({
      id: "request-1",
      type: "response",
      payload: { cmd: "error", error: { code: "RESPONSE_TOO_LARGE" } },
    });
  });

  it("保留未超限响应", () => {
    const response = { id: "request-2", type: "response" as const, payload: { cmd: "tabs.list", data: [] } };

    expect(limitNativeResponse(response, 90)).toBe(response);
  });
});

describe("focusNativeTab", () => {
  const tabsUpdate = vi.fn();
  const windowsUpdate = vi.fn();

  beforeEach(() => {
    tabsUpdate.mockReset();
    windowsUpdate.mockReset();
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123, windowId: 42 }),
        update: tabsUpdate,
      },
      windows: {
        update: windowsUpdate,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("activates the tab and focuses its window", async () => {
    tabsUpdate.mockResolvedValue({ windowId: 42 });
    windowsUpdate.mockResolvedValue({ id: 42, focused: true });

    await expect(focusNativeTab(123)).resolves.toEqual({ tabId: 123, windowId: 42 });

    expect(tabsUpdate).toHaveBeenCalledWith(123, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(42, { focused: true });
  });

  it("uses requested window when provided", async () => {
    tabsUpdate.mockResolvedValue({ windowId: 42 });
    windowsUpdate.mockResolvedValue({ id: 7, focused: true });

    await expect(focusNativeTab(123, 7)).resolves.toEqual({ tabId: 123, windowId: 7 });

    expect(windowsUpdate).toHaveBeenCalledWith(7, { focused: true });
  });
});

describe("normalizeNativeTabEvent", () => {
  it("maps created events into public event shape", async () => {
    const tab = {
      id: 123,
      windowId: 7,
      index: 2,
      title: "Example",
      url: "https://example.com/",
      active: true,
      incognito: false,
      audible: true,
    } as chrome.tabs.Tab;

    await expect(normalizeNativeTabEvent("onCreated", [tab])).resolves.toMatchObject({
      type: "tab-created",
      browserId: "",
      tabId: { browser: "", windowId: 7, tabId: 123 },
      tab: { id: 123, windowId: 7, browserName: expect.any(String), appName: expect.any(String) },
    });
  });

  it("falls back to tab ID when updated event lacks tab details", async () => {
    await expect(normalizeNativeTabEvent("onUpdated", [123])).resolves.toEqual({
      type: "tab-updated",
      browserId: "",
      tabId: { browser: "", windowId: -1, tabId: 123 },
    });
  });

  it("fetches tab details for activated events", async () => {
    const tabsGet = vi.fn().mockResolvedValue({
      id: 123,
      windowId: 7,
      index: 2,
      title: "Example",
      url: "https://example.com/",
      active: true,
      incognito: false,
      audible: false,
    });
    vi.stubGlobal("chrome", { tabs: { get: tabsGet } });

    await expect(normalizeNativeTabEvent("onActivated", [{ tabId: 123, windowId: 7 }])).resolves.toMatchObject({
      type: "tab-focused",
      tabId: { browser: "", windowId: 7, tabId: 123 },
      tab: { id: 123, title: "Example" },
    });
  });
});

describe("tabToBrowserControlTab", () => {
  it("保留 Firefox 的摄像头、麦克风和屏幕共享状态", () => {
    const tab = {
      id: 123,
      index: 0,
      windowId: 7,
      pinned: false,
      highlighted: false,
      active: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      frozen: false,
      sharingState: { camera: true, microphone: true, screen: "Window" },
    };

    expect(tabToBrowserControlTab(tab)).toMatchObject({ sharingState: tab.sharingState });
  });

  it("保留停止共享后的状态", async () => {
    const tab = {
      id: 123,
      windowId: 7,
      sharingState: { camera: false, microphone: false },
    };

    await expect(
      normalizeNativeTabEvent("onUpdated", [123, { sharingState: tab.sharingState }, tab])
    ).resolves.toMatchObject({
      type: "tab-updated",
      tab: { sharingState: { camera: false, microphone: false } },
    });
  });

  it("maps Chrome tabs into the public tab shape", () => {
    const tab = {
      id: 123,
      windowId: 7,
      index: 2,
      title: "Example",
      url: "https://example.com/",
      active: true,
      incognito: false,
      audible: true,
    } as chrome.tabs.Tab;

    expect(tabToBrowserControlTab(tab, { browserName: "chrome", appName: "Google Chrome" })).toEqual({
      browserId: "",
      browserName: "chrome",
      appName: "Google Chrome",
      id: 123,
      windowId: 7,
      index: 2,
      title: "Example",
      url: "https://example.com/",
      active: true,
      incognito: false,
      audible: true,
    });
  });

  it("derives common browser names from user agent", () => {
    expect(browserIdentityFromUserAgent("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36")).toEqual({
      browserName: "chrome",
      appName: "Google Chrome",
    });
    expect(browserIdentityFromUserAgent("Mozilla/5.0 Firefox/123.0")).toEqual({
      browserName: "firefox",
      appName: "Firefox",
    });
  });
});

describe("原生消息并发控制", () => {
  const postMessage = vi.fn();
  const tabsGet = vi.fn();
  const tabsUpdate = vi.fn();
  const tabsCreate = vi.fn();
  const activations = new Set<(info: { tabId: number; windowId: number }) => void>();
  const windowsUpdate = vi.fn();
  const captureTab = vi.fn();
  const captureVisibleTab = vi.fn();
  const executeScript = vi.fn();
  const eventAdd = vi.fn();
  const eventRemove = vi.fn();
  let dispatch: (message: {
    id: string;
    type: string;
    payload: { cmd: string; args: Record<string, unknown> };
  }) => Promise<void>;
  let activeTab: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    activeTab = 99;
    activations.clear();
    tabsCreate.mockImplementation(async ({ active }: { active: boolean }) => {
      if (active) activeTab = 103;
      return { id: 103, windowId: 7 };
    });
    tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 7, active: activeTab === id }));
    tabsUpdate.mockImplementation(async (id: number) => {
      activeTab = id;
      return { id, windowId: 7, active: true };
    });
    captureTab.mockImplementation(async (id: number) => "captured-tab-" + id);
    captureVisibleTab.mockImplementation(async () => "captured-tab-" + activeTab);
    executeScript.mockResolvedValue([
      { result: { width: 100, height: 100, viewportWidth: 100, viewportHeight: 100, x: 0, y: 0, dpr: 1 } },
    ]);
    vi.stubGlobal("chrome", {
      storage: {
        local: (() => {
          let state: unknown = {
            registration: {
              windowId: 7,
              markerTabId: 900,
              markerUrl: "chrome-extension://test/src/agent-window.html?registration=test",
            },
            sessions: [{ sessionId: "task", expiresAt: Date.now() + 900000, ttlMs: 900000, paused: false, tabIds: [] }],
          };
          return {
            get: vi.fn(async (key: string, callback?: (value: Record<string, unknown>) => void) => {
              const result =
                key === "browserControl.agentWindow" ? { "browserControl.agentWindow": structuredClone(state) } : {};
              callback?.(result);
              return result;
            }),
            set: vi.fn(async (value: Record<string, unknown>) => {
              state = structuredClone(value["browserControl.agentWindow"]);
            }),
          };
        })(),
      },
      runtime: {
        connectNative: () => ({
          postMessage,
          disconnect: vi.fn(),
          onMessage: {
            addListener: (listener: typeof dispatch) => {
              dispatch = listener;
            },
          },
          onDisconnect: { addListener: vi.fn() },
        }),
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        get: async (id: number) =>
          id === 900
            ? { id: 900, windowId: 7, url: "chrome-extension://test/src/agent-window.html?registration=test" }
            : tabsGet(id),
        update: tabsUpdate,
        captureTab,
        captureVisibleTab,
        create: tabsCreate,
        onActivated: {
          addListener: (fn: (info: { tabId: number; windowId: number }) => void) => activations.add(fn),
          removeListener: (fn: (info: { tabId: number; windowId: number }) => void) => activations.delete(fn),
        },
        onCreated: { addListener: eventAdd, removeListener: eventRemove },
        onRemoved: { addListener: eventAdd, removeListener: eventRemove },
      },
      windows: { update: windowsUpdate, getCurrent: vi.fn().mockResolvedValue({ id: 7 }) },
      scripting: { executeScript },
    });
    initNativeMessaging({} as ScriptService);
  });

  afterEach(() => {
    disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function request(id: string, cmd: string, args: Record<string, unknown>): Promise<void> {
    return dispatch({ id, type: "request", payload: { cmd, args: { sessionId: "task", ...args } } });
  }

  it("新工作标签默认后台创建且限定专用窗口", async () => {
    await request("create", "tabs.create", { url: "https://example.com" });
    expect(tabsCreate).toHaveBeenCalledWith({ url: "https://example.com", windowId: 7, active: false });
    expect(windowsUpdate).not.toHaveBeenCalled();
  });

  it("默认截图不允许可见捕获降级抢占标签", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    const done = request("strict", "page.screenshot", { tabId: 101 });
    await vi.runAllTimersAsync();
    await done;
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "strict", payload: expect.objectContaining({ cmd: "error" }) })
    );
  });

  it("个人窗口标签应拒绝执行且不泄露页面内容", async () => {
    tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
    await request("personal", "page.content", { tabId: 101 });
    expect(executeScript).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "personal",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "PERSONAL_TAB_DENIED" }) }),
      })
    );
  });

  it("Zen 并发截图应捕获各自的后台标签且不改变焦点", async () => {
    const done = Promise.all([
      request("a", "page.screenshot", { tabId: 101 }),
      request("b", "page.screenshot", { tabId: 102 }),
    ]);
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-101" }) }),
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "b",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-102" }) }),
      })
    );
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(windowsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("Zen 完整页面截图应使用文档矩形且不滚动页面", async () => {
    executeScript.mockResolvedValue([{ result: { x: 0, y: 0, width: 600, height: 1200 } }]);
    const done = request("full", "page.screenshot", { tabId: 101, fullPage: true });
    await vi.runAllTimersAsync();
    await done;
    expect(captureTab).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ rect: { x: 0, y: 0, width: 600, height: 1200 } })
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it.each(["tabs.focus", "page.screenshot"])("窗口队列等待期间暂停任务后 %s 不应抢占焦点", async (command) => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    let release!: () => void;
    const held = withNativeWindowOperation(
      7,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(0);
    const pending = request("queued", command, { tabId: 101, allowFocus: true, allowForeground: true });
    await vi.advanceTimersByTimeAsync(0);
    await request("pause", "sessions.pause", {});
    release();
    await held;
    await vi.runAllTimersAsync();
    await pending;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "queued",
        payload: expect.objectContaining({ cmd: "error", error: expect.objectContaining({ code: "SESSION_PAUSED" }) }),
      })
    );
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(windowsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("不支持按标签截图时应串行捕获同一窗口的不同标签", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    const done = Promise.all([
      request("a", "page.screenshot", { tabId: 101, allowForeground: true, personalTabId: 101 }),
      request("b", "page.screenshot", { tabId: 102, allowForeground: true, personalTabId: 102 }),
    ]);
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-101" }) }),
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "b",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-102" }) }),
      })
    );
  });

  it("截图期间外部焦点改变应报错而非返回错误标签图像", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    captureVisibleTab.mockImplementation(async () => {
      activeTab = 102;
      return "captured-tab-102";
    });
    const done = request("a", "page.screenshot", { tabId: 101, allowForeground: true, personalTabId: 101 });
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", payload: expect.objectContaining({ cmd: "error" }) })
    );
  });

  it("截图请求失败不应隐式激活标签或改用当前可见标签", async () => {
    captureTab.mockRejectedValueOnce(new Error("capture permission denied"));
    const done = request("a", "page.screenshot", { tabId: 101 });
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a",
        payload: expect.objectContaining({
          cmd: "error",
          error: expect.objectContaining({ message: "capture permission denied" }),
        }),
      })
    );
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("多个订阅者应保留事件并集且重复订阅不增加监听器", async () => {
    await request("a", "tabs.subscribe", { events: ["onCreated"] });
    await request("b", "tabs.subscribe", { events: ["onRemoved"] });
    await request("c", "tabs.subscribe", { events: ["onCreated"] });
    expect(eventAdd).toHaveBeenCalledTimes(2);
    expect(eventRemove).not.toHaveBeenCalled();
  });

  it("动态脚本应默认在页面世界执行", async () => {
    await request("a", "page.exec", { tabId: 101, code: "document.title" });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: "MAIN", target: { tabId: 101 } }));
  });

  it("MV3 隔离世界动态执行应明确报错而非静默切换世界", async () => {
    await request("a", "page.exec", { tabId: 101, code: "document.title", world: "ISOLATED" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "a",
        payload: expect.objectContaining({
          cmd: "error",
          error: expect.objectContaining({ message: expect.stringContaining("ISOLATED") }),
        }),
      })
    );
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("截图失败后应释放标签队列并允许后续请求", async () => {
    captureTab.mockRejectedValueOnce(new Error("failed"));
    const done = Promise.all([
      request("a", "page.screenshot", { tabId: 101 }),
      request("b", "page.screenshot", { tabId: 101 }),
    ]);
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", payload: expect.objectContaining({ cmd: "error" }) })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "b",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-101" }) }),
      })
    );
  });

  it("排队期间超时的脚本不得在截图结束后执行", async () => {
    let release!: () => void;
    captureTab.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("captured-tab-101");
        })
    );
    const screenshot = request("shot", "page.screenshot", { tabId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    const exec = request("exec", "page.exec", { tabId: 101, code: "document.title", timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(6);
    await exec;
    release();
    await screenshot;
    await vi.runAllTimersAsync();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "exec", payload: expect.objectContaining({ cmd: "error" }) })
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("Chrome 应通过 CDP 按标签截图且保持焦点", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    const attach = vi.fn().mockResolvedValue(undefined);
    const detach = vi.fn().mockResolvedValue(undefined);
    const sendCommand = vi
      .fn()
      .mockImplementation(async (target: { tabId: number }) => ({ data: "tab-" + target.tabId }));
    Object.assign(chrome, {
      debugger: { attach, detach, sendCommand },
      permissions: { contains: vi.fn().mockResolvedValue(true) },
    });
    const done = Promise.all([
      request("a", "page.screenshot", { tabId: 101 }),
      request("b", "page.screenshot", { tabId: 102, format: "jpeg", quality: 0, fullPage: true }),
    ]);
    await vi.runAllTimersAsync();
    await done;
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 101 },
      "Page.captureScreenshot",
      expect.objectContaining({ format: "png", captureBeyondViewport: false })
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 102 },
      "Page.captureScreenshot",
      expect.objectContaining({ format: "jpeg", quality: 0, captureBeyondViewport: true })
    );
    expect(detach).toHaveBeenCalledTimes(2);
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("Zen 元素截图应传递文档坐标并保留零质量设置", async () => {
    executeScript.mockResolvedValue([{ result: { x: 40, y: 900, width: 100, height: 200 } }]);
    const done = request("region", "page.screenshot", { tabId: 101, selector: "#target", format: "jpeg", quality: 0 });
    await vi.runAllTimersAsync();
    await done;
    expect(captureTab).toHaveBeenCalledWith(101, {
      format: "jpeg",
      quality: 0,
      rect: { x: 40, y: 900, width: 100, height: 200 },
    });
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("可见标签截图应跨窗口共享捕获速率限制", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    const active = new Map<number, number>();
    tabsGet.mockImplementation(async (id: number) => ({ id, windowId: id, active: active.get(id) === id }));
    tabsUpdate.mockImplementation(async (id: number) => {
      active.set(id, id);
      return { id, windowId: id, active: true };
    });
    const times: number[] = [];
    captureVisibleTab.mockImplementation(async (windowId: number) => {
      times.push(Date.now());
      return "captured-tab-" + windowId;
    });
    const done = Promise.all([
      request("a", "page.screenshot", { tabId: 101, allowForeground: true, personalTabId: 101 }),
      request("b", "page.screenshot", { tabId: 102, allowForeground: true, personalTabId: 102 }),
    ]);
    await vi.runAllTimersAsync();
    await done;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(500);
  });

  it("可见截图期间创建前台标签应等待截图结束", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    const screenshot = request("shot", "page.screenshot", { tabId: 101, allowForeground: true, personalTabId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    const create = request("create", "tabs.create", { url: "https://example.com", active: true, allowFocus: true });
    await vi.runAllTimersAsync();
    await Promise.all([screenshot, create]);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "shot",
        payload: expect.objectContaining({ data: expect.objectContaining({ dataUrl: "captured-tab-101" }) }),
      })
    );
    expect(activeTab).toBe(103);
  });

  it("捕获中焦点切换后恢复也应拒绝错误标签图像", async () => {
    Reflect.deleteProperty(chrome.tabs, "captureTab");
    captureVisibleTab.mockImplementation(async () => {
      for (const listener of activations) listener({ tabId: 102, windowId: 7 });
      for (const listener of activations) listener({ tabId: 101, windowId: 7 });
      return "captured-tab-102";
    });
    const done = request("shot", "page.screenshot", { tabId: 101, allowForeground: true, personalTabId: 101 });
    await vi.runAllTimersAsync();
    await done;
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shot", payload: expect.objectContaining({ cmd: "error" }) })
    );
    expect(activations.size).toBe(0);
  });

  it("Firefox 注入错误应返回失败而非成功空结果", async () => {
    executeScript.mockResolvedValueOnce([{ frameId: 0, error: { message: "CSP blocked eval" } }]);
    await request("exec-error", "page.exec", { tabId: 101, code: "1 + 1" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exec-error",
        payload: expect.objectContaining({
          cmd: "error",
          error: expect.objectContaining({ message: "CSP blocked eval" }),
        }),
      })
    );
  });

  it("脚本异常应在浏览器丢弃注入异常之前传回调用方", async () => {
    executeScript.mockImplementationOnce(
      async ({ func, args }: { func: (code: string) => unknown; args: [string] }) => {
        try {
          return [{ frameId: 0, result: await func(...args) }];
        } catch {
          return [{ frameId: 0 }];
        }
      }
    );
    await request("exec-error", "page.exec", { tabId: 101, code: "throw new Error('script failed')" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exec-error",
        payload: expect.objectContaining({
          cmd: "error",
          error: expect.objectContaining({ message: "script failed" }),
        }),
      })
    );
  });

  it("脚本返回空值应保持成功并区别于注入失败", async () => {
    executeScript.mockImplementationOnce(
      async ({ func, args }: { func: (code: string) => unknown; args: [string] }) => [
        { frameId: 0, result: await func(...args) },
      ]
    );
    await request("exec-null", "page.exec", { tabId: 101, code: "null" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exec-null",
        payload: expect.objectContaining({ cmd: "page.exec", data: { result: null } }),
      })
    );
  });
});
