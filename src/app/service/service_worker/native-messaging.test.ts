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
import { agentNotesService } from "@App/pkg/browser-control/agent-notes";
import { guideService } from "@App/pkg/browser-control/guide";

describe("原生消息大小限制", () => {
  it.each([1n, { nested: 1n }])("JSON 不兼容结果应返回结构化错误", (data) => {
    expect(limitNativeResponse({ id: "bigint", type: "response", payload: { data } })).toMatchObject({
      id: "bigint",
      payload: { cmd: "error", error: { code: "RESPONSE_NOT_SERIALIZABLE" } },
    });
  });
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

  it("passes favicon URLs through and drops oversized ones", () => {
    const tab = { id: 1, windowId: 2, favIconUrl: "https://example.com/favicon.ico" } as chrome.tabs.Tab;
    expect(tabToBrowserControlTab(tab)).toMatchObject({ favIconUrl: "https://example.com/favicon.ico" });

    const huge = {
      id: 1,
      windowId: 2,
      favIconUrl: "data:image/png;base64," + "A".repeat(64 * 1024),
    } as chrome.tabs.Tab;
    expect(tabToBrowserControlTab(huge)).not.toHaveProperty("favIconUrl");
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
  const tabsQuery = vi.fn();
  const tabsReload = vi.fn();
  const tabsRemove = vi.fn();
  const commits = new Set<(info: { tabId: number; frameId: number }) => void>();
  const requestEvents = {
    onCompleted: new Set<(details: object) => void>(),
    onErrorOccurred: new Set<(details: object) => void>(),
  };
  const tabUpdates = new Set<(tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>();
  const activations = new Set<(info: { tabId: number; windowId: number }) => void>();
  const windowsUpdate = vi.fn();
  const windowsGet = vi.fn();
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
    tabsQuery.mockResolvedValue([
      { id: 101, windowId: 7 },
      { id: 102, windowId: 8 },
    ]);
    activations.clear();
    commits.clear();
    tabUpdates.clear();
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
          const values: Record<string, unknown> = {
            "browserControl.agentWindow": {
              registration: {
                windowId: 7,
                markerTabId: 900,
                markerUrl: "chrome-extension://test/src/agent-window.html?registration=test",
                eligibleTabIds: [101, 102],
              },
              sessions: [
                { sessionId: "task", expiresAt: Date.now() + 900000, ttlMs: 900000, paused: false, tabIds: [] },
              ],
            },
          };
          return {
            get: vi.fn(async (key: unknown, callback?: (value: Record<string, unknown>) => void) => {
              if (typeof key === "function") {
                const all = structuredClone(values);
                key(all);
                return all;
              }
              const result = typeof key === "string" && key in values ? { [key]: structuredClone(values[key]) } : {};
              callback?.(result);
              return result;
            }),
            set: vi.fn(async (value: Record<string, unknown>) => {
              Object.assign(values, structuredClone(value));
            }),
          };
        })(),
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      },
      runtime: {
        getManifest: () => ({ version: "4.2.1", manifest_version: 3 }),
        getURL: (path: string) => "chrome-extension://test/" + path,
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
        query: tabsQuery,
        get: async (id: number) =>
          id === 900
            ? { id: 900, windowId: 7, url: "chrome-extension://test/src/agent-window.html?registration=test" }
            : tabsGet(id),
        update: tabsUpdate,
        reload: tabsReload,
        remove: tabsRemove,
        captureTab,
        captureVisibleTab,
        create: tabsCreate,
        onActivated: {
          addListener: (fn: (info: { tabId: number; windowId: number }) => void) => activations.add(fn),
          removeListener: (fn: (info: { tabId: number; windowId: number }) => void) => activations.delete(fn),
        },
        onCreated: { addListener: eventAdd, removeListener: eventRemove },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: {
          addListener: (fn: Parameters<typeof tabUpdates.add>[0]) => tabUpdates.add(fn),
          removeListener: (fn: Parameters<typeof tabUpdates.add>[0]) => tabUpdates.delete(fn),
        },
        getZoom: vi.fn(async () => 1),
        goBack: vi.fn(async () => {}),
        goForward: vi.fn(async () => {}),
      },
      windows: { get: windowsGet, update: windowsUpdate, getCurrent: vi.fn().mockResolvedValue({ id: 7 }) },
      scripting: { executeScript },
      webRequest: Object.fromEntries(
        Object.entries(requestEvents).map(([name, listeners]) => [
          name,
          {
            addListener: (listener: (details: object) => void) => listeners.add(listener),
            removeListener: (listener: (details: object) => void) => listeners.delete(listener),
          },
        ])
      ),
      webNavigation: {
        onCommitted: {
          addListener: (listener: (info: { tabId: number; frameId: number }) => void) => commits.add(listener),
          removeListener: (listener: (info: { tabId: number; frameId: number }) => void) => commits.delete(listener),
        },
      },
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

  it("开启任务时保存标签供列表与标识显示", async () => {
    await request("open-labeled", "sessions.open", { label: "claude: fix login" });
    await request("list-labeled", "sessions.list", {});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "list-labeled",
        payload: expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({ label: "claude: fix login" })]),
        }),
      })
    );
  });

  it("代理在可访问标签留下页面便签并读取人工回复", async () => {
    tabsGet.mockImplementation(async (id: number) => ({
      id,
      windowId: 7,
      url: "https://example.com/pay#card",
      title: "Pay",
    }));
    await request("note-add", "notes.add", { tabId: 101, kind: "needs-human", text: "Solve the captcha" });
    const added = postMessage.mock.calls.find(([message]) => message.id === "note-add")![0];
    expect(added.payload.data).toMatchObject({
      url: "https://example.com/pay",
      title: "Pay",
      sessionId: "task",
      kind: "needs-human",
      status: "open",
    });
    await agentNotesService.reply(added.payload.data.id, "done");
    await request("note-get", "notes.get", { id: added.payload.data.id });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-get",
        payload: { cmd: "notes.get", data: expect.objectContaining({ status: "acknowledged", reply: "done" }) },
      })
    );
    await request("note-resolve", "notes.resolve", { id: added.payload.data.id });
    await request("note-list", "notes.list", { status: "resolved" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-list",
        payload: { cmd: "notes.list", data: [expect.objectContaining({ id: added.payload.data.id })] },
      })
    );
  });

  it("代理不能在无权访问的标签留下便签", async () => {
    tabsGet.mockResolvedValue({ id: 101, windowId: 8, url: "https://bank.example/" });
    await request("note-denied", "notes.add", { tabId: 101, kind: "info", text: "hi" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "note-denied",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "PERSONAL_TAB_DENIED" }) }),
      })
    );
  });

  it("内容注入错误应保留原因且不存在元素返回明确错误", async () => {
    executeScript.mockResolvedValueOnce([{ error: { message: "Missing host permission" } }]);
    await request("content-error", "page.content", { tabId: 101 });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "content-error",
        payload: expect.objectContaining({
          cmd: "error",
          error: expect.objectContaining({ message: "Missing host permission" }),
        }),
      })
    );
    executeScript.mockImplementationOnce(async ({ func, args }) => [{ result: await func(...args) }]);
    await request("content-absent", "page.content", { tabId: 101, selector: "#absent" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "content-absent",
        payload: {
          cmd: "error",
          error: { code: "SELECTOR_NOT_FOUND", message: "no element matches selector: #absent" },
        },
      })
    );
  });

  function tabUpdated(tabId: number, change: Partial<chrome.tabs.OnUpdatedInfo>) {
    for (const listener of [...tabUpdates])
      listener(tabId, change as chrome.tabs.OnUpdatedInfo, { id: tabId, ...change } as chrome.tabs.Tab);
  }

  function responseOf(id: string) {
    return postMessage.mock.calls.find(([message]) => message.id === id)?.[0].payload;
  }

  describe("页面动作与导航", () => {
    beforeEach(() => {
      (Element.prototype as Element & { checkVisibility?: () => boolean }).checkVisibility = () => true;
      document.body.innerHTML = "";
      executeScript.mockImplementation(async ({ func, args }) => [{ result: await func(...args) }]);
    });
    afterEach(() => {
      delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
    });

    it("点击按文本定位并返回匹配元素与当前页面", async () => {
      document.body.innerHTML = `<button id="save">Save</button>`;
      const clicked = vi.fn();
      document.getElementById("save")!.addEventListener("click", clicked);
      tabsGet.mockResolvedValue({ id: 101, windowId: 7, url: "https://a.test/", title: "A", status: "complete" });
      await request("click", "page.click", { tabId: 101, text: "Save" });
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(responseOf("click")).toEqual({
        cmd: "page.click",
        data: {
          matched: { tag: "button", id: "save", text: "Save" },
          navigated: false,
          url: "https://a.test/",
          title: "A",
        },
      });
    });

    it("点击触发导航时等待新页面加载完成", async () => {
      document.body.innerHTML = `<a id="next">Next</a>`;
      const tab = { id: 101, windowId: 7, url: "https://a.test/", title: "A", status: "complete" };
      tabsGet.mockImplementation(async () => ({ ...tab }));
      document.getElementById("next")!.addEventListener("click", () => {
        setTimeout(() => {
          Object.assign(tab, { status: "loading", url: "https://a.test/next" });
          tabUpdated(101, { status: "loading", url: "https://a.test/next" });
        }, 50);
        setTimeout(() => {
          Object.assign(tab, { status: "complete", title: "Next" });
          tabUpdated(101, { status: "complete" });
        }, 400);
      });
      const pending = request("nav-click", "page.click", { tabId: 101, selector: "#next", wait: "load" });
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(responseOf("nav-click").data).toMatchObject({
        navigated: true,
        url: "https://a.test/next",
        title: "Next",
      });
    });

    it("动作错误以错误码返回", async () => {
      document.body.innerHTML = `<button>Go</button><button>Go</button>`;
      await request("missing", "page.click", { tabId: 101, selector: "#none" });
      await request("ambiguous", "page.click", { tabId: 101, text: "Go" });
      await request("no-value", "page.fill", { tabId: 101, selector: "input" });
      expect(responseOf("missing").error.code).toBe("SELECTOR_NOT_FOUND");
      expect(responseOf("ambiguous").error.code).toBe("AMBIGUOUS_MATCH");
      expect(responseOf("no-value").error.message).toBe("value is required");
    });

    it("代理不能在个人标签执行动作", async () => {
      tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
      await request("denied", "page.click", { tabId: 101, selector: "button" });
      expect(responseOf("denied").error.code).toBe("PERSONAL_TAB_DENIED");
      expect(executeScript).not.toHaveBeenCalled();
    });

    it("快照返回可交互元素引用且引用可用于点击", async () => {
      document.body.innerHTML = `<button id="go">Go</button>`;
      const clicked = vi.fn();
      document.getElementById("go")!.addEventListener("click", clicked);
      await request("snapshot", "page.snapshot", { tabId: 101 });
      expect(responseOf("snapshot").data).toMatchObject({
        total: 1,
        elements: [{ ref: expect.stringMatching(/^e\d+$/), role: "button", name: "Go" }],
      });
      const ref = responseOf("snapshot").data.elements[0].ref;
      await request("ref-click", "page.click", { tabId: 101, ref });
      expect(clicked).toHaveBeenCalledTimes(1);
    });

    describe("引导模式", () => {
      beforeEach(() => {
        // jsdom 未实现 ResizeObserver
        Object.assign(globalThis, {
          ResizeObserver: class {
            observe() {}
            disconnect() {}
          },
        });
        tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 7, url: "https://a.test/", title: "A" }));
      });
      afterEach(async () => {
        await request("guide-cleanup", "guide.clear", { tabId: 101 });
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      });

      it("解析标注后绘制步骤，等待在人工点击下一步时返回", async () => {
        document.body.innerHTML = `<button id="save">Save</button>`;
        await request("guide-step", "guide.step", {
          tabId: 101,
          text: "Click Save",
          marks: [{ text: "Save", label: "here" }, { selector: "#save" }],
        });
        const { step, marks } = responseOf("guide-step").data;
        expect(marks).toEqual([
          { ref: expect.stringMatching(/^e\d+$/), label: "here" },
          { ref: marks[0].ref, label: "2" },
        ]);
        expect(document.querySelector("lbcat-agent-guide")).not.toBeNull();
        const waiting = request("guide-wait", "guide.wait", { tabId: 101 });
        guideService.record(101, step, { kind: "next", reply: "done" });
        await waiting;
        expect(responseOf("guide-wait")).toEqual({
          cmd: "guide.wait",
          data: {
            tabId: 101,
            step,
            action: "next",
            reply: "done",
            interactions: [],
            url: "https://a.test/",
            title: "A",
          },
        });
      });

      it("标注找不到时不开始步骤", async () => {
        await request("guide-missing", "guide.step", { tabId: 101, text: "Click", marks: [{ selector: "#none" }] });
        expect(responseOf("guide-missing").error.code).toBe("SELECTOR_NOT_FOUND");
        expect(document.querySelector("lbcat-agent-guide")).toBeNull();
        await request("guide-wait-none", "guide.wait", { tabId: 101 });
        expect(responseOf("guide-wait-none").error.code).toBe("GUIDE_NOT_STARTED");
      });

      it("等待超时后界面保留，清除时移除界面", async () => {
        await request("guide-plain", "guide.step", { tabId: 101, text: "Read this" });
        const waiting = request("guide-timeout", "guide.wait", { tabId: 101, timeoutMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        await waiting;
        expect(responseOf("guide-timeout").data).toMatchObject({ action: "timeout" });
        expect(document.querySelector("lbcat-agent-guide")).not.toBeNull();
        await request("guide-clear", "guide.clear", { tabId: 101 });
        expect(responseOf("guide-clear").data).toEqual({ tabId: 101, cleared: true });
        expect(document.querySelector("lbcat-agent-guide")).toBeNull();
      });

      it("结束会话时移除该会话的引导，等待中的代理收到 closed", async () => {
        await request("guide-owned", "guide.step", { tabId: 101, text: "Read this" });
        const waiting = request("guide-owned-wait", "guide.wait", { tabId: 101 });
        await vi.advanceTimersByTimeAsync(0);
        await request("guide-session-end", "sessions.close", {});
        await waiting;
        expect(responseOf("guide-owned-wait").data).toMatchObject({ action: "closed" });
        expect(document.querySelector("lbcat-agent-guide")).toBeNull();
      });

      it("页面跳转后等新页面加载完成再返回标题", async () => {
        await request("guide-nav", "guide.step", { tabId: 101, text: "Click Continue" });
        const waiting = request("guide-nav-wait", "guide.wait", { tabId: 101 });
        const next = { id: 101, windowId: 7, url: "https://a.test/billing", title: "https://a.test/billing" };
        tabsGet.mockImplementation(async () => ({ ...next, status: "loading" }));
        guideService.navigated(101, next.url);
        await vi.advanceTimersByTimeAsync(0);
        const loaded = { ...next, title: "Billing", status: "complete" } as chrome.tabs.Tab;
        tabsGet.mockImplementation(async () => loaded);
        for (const listener of tabUpdates) listener(101, { status: "complete" }, loaded);
        await waiting;
        expect(responseOf("guide-nav-wait").data).toMatchObject({
          action: "navigated",
          url: "https://a.test/billing",
          title: "Billing",
        });
      });

      it("代理不能在个人标签展示引导，缺少说明时报错", async () => {
        await request("guide-empty", "guide.step", { tabId: 101, text: " " });
        expect(responseOf("guide-empty").error.code).toBe("INVALID_ARGUMENT");
        tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
        await request("guide-denied", "guide.step", { tabId: 101, text: "hi" });
        expect(responseOf("guide-denied").error.code).toBe("PERSONAL_TAB_DENIED");
        expect(executeScript).not.toHaveBeenCalled();
      });
    });

    it("以页面身份请求并返回状态与正文", async () => {
      const fetchMock = vi.fn(async () => new Response("[1,2]", { headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      await request("fetch", "page.fetch", {
        tabId: 101,
        url: "https://a.test/api",
        method: "put",
        headers: { "X-Test": "1" },
        body: "x",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://a.test/api",
        expect.objectContaining({ method: "PUT", headers: { "X-Test": "1" }, body: "x" })
      );
      expect(responseOf("fetch").data).toMatchObject({ status: 200, ok: true, body: "[1,2]" });
      await request("fetch-missing", "page.fetch", { tabId: 101 });
      expect(responseOf("fetch-missing").error.message).toBe("url is required");
    });

    it("推送脚本后只重新加载可访问且匹配的标签", async () => {
      const installScript = vi.fn(async () => ({ update: false, updatetime: 0 }));
      initNativeMessaging({ installScript } as unknown as ScriptService);
      tabsQuery.mockResolvedValue([
        { id: 101, windowId: 7, url: "https://a.test/page" },
        { id: 102, windowId: 7, url: "https://b.test/" },
      ]);
      tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 7, url: "https://a.test/page" }));
      const code = `// ==UserScript==
// @name reload-test
// @namespace bctl
// @match https://a.test/*
// ==/UserScript==
`;
      await request("push", "script.push", { code, reloadTabs: true });
      expect(installScript).toHaveBeenCalledTimes(1);
      expect(tabsReload).toHaveBeenCalledTimes(1);
      expect(tabsReload).toHaveBeenCalledWith(101, { bypassCache: false });
      expect(responseOf("push").data).toMatchObject({ isNew: true, reloadedTabs: [101] });

      await request("push-plain", "script.push", { code });
      expect(tabsReload).toHaveBeenCalledTimes(1);
      expect(responseOf("push-plain").data).not.toHaveProperty("reloadedTabs");
    });

    it("无 debugger 时调整代理窗口使页面视口达到目标尺寸，重置后恢复原窗口", async () => {
      const win = { id: 7, state: "maximized", left: 0, top: 0, width: 1200, height: 900 };
      const chromeSize = { width: 200, height: 160 };
      const session: Record<string, unknown> = {};
      Object.assign(chrome.storage, {
        session: {
          get: vi.fn(async (key: string) => (key in session ? { [key]: structuredClone(session[key]) } : {})),
          set: vi.fn(async (value: Record<string, unknown>) => Object.assign(session, structuredClone(value))),
        },
      });
      windowsGet.mockImplementation(async () => ({ ...win }));
      windowsUpdate.mockImplementation(async (_id: number, update: Partial<typeof win>) => Object.assign(win, update));
      executeScript.mockImplementation(async () => [
        {
          result: {
            width: win.width - chromeSize.width,
            height: win.height - chromeSize.height,
            outerWidth: win.width,
            outerHeight: win.height,
          },
        },
      ]);
      await request("viewport", "page.viewport", { tabId: 101, width: 390, height: 844 });
      expect(windowsUpdate).toHaveBeenNthCalledWith(1, 7, { state: "normal", titlePreface: "[bctl 7] " });
      expect(windowsUpdate).toHaveBeenNthCalledWith(2, 7, { width: 590, height: 1004 });
      expect(responseOf("viewport").data).toEqual({
        tabId: 101,
        windowId: 7,
        width: 390,
        height: 844,
        exact: true,
        scope: "window",
        titleMarker: "[bctl 7] ",
      });

      await request("viewport-read", "page.viewport", { tabId: 101 });
      expect(windowsUpdate).toHaveBeenCalledTimes(2);
      expect(responseOf("viewport-read").data).toMatchObject({ width: 390, height: 844, scope: "window" });

      await request("viewport-again", "page.viewport", { tabId: 101, width: 400 });
      await request("viewport-reset", "page.viewport", { tabId: 101, reset: true });
      expect(windowsUpdate).toHaveBeenLastCalledWith(7, { state: "maximized" });
      expect(responseOf("viewport-reset").data).toMatchObject({ scope: "window", titleMarker: "[bctl 7] " });
    });

    it("窗口在隐藏的工作区时 Firefox 暂停布局：按页面自身尺寸换算外框并标记 deferred", async () => {
      const win = { id: 7, state: "normal", left: 1511, top: 950, width: 600, height: 700 };
      windowsGet.mockImplementation(async () => ({ ...win }));
      windowsUpdate.mockImplementation(async (_id: number, update: Partial<typeof win>) => Object.assign(win, update));
      // 页面仍停留在隐藏前的布局
      executeScript.mockResolvedValue([{ result: { width: 1512, height: 950, outerWidth: 1512, outerHeight: 950 } }]);
      const done = request("viewport-hidden", "page.viewport", { tabId: 101, width: 390, height: 844 });
      await vi.runAllTimersAsync();
      await done;
      expect(windowsUpdate).toHaveBeenLastCalledWith(7, { width: 390, height: 844 });
      expect(responseOf("viewport-hidden").data).toMatchObject({
        width: 1512,
        height: 950,
        exact: false,
        deferred: true,
      });
    });

    // 模拟 Chrome 调试器：视口按 CSS 像素测量，即设备无关像素除以页面缩放
    function stubEmulatingDebugger(zoom = 1) {
      let emulated: { width: number; height: number } | undefined;
      const attach = vi.fn().mockResolvedValue(undefined);
      const detach = vi.fn().mockResolvedValue(undefined);
      const sendCommand = vi.fn(async (_target: { tabId: number }, method: string, params?: object) => {
        if (method === "Emulation.setDeviceMetricsOverride") {
          const { width, height } = params as { width: number; height: number };
          emulated = { width, height };
        }
        if (method === "Emulation.clearDeviceMetricsOverride") emulated = undefined;
        return method === "Page.captureScreenshot" ? { data: "shot" } : {};
      });
      Object.assign(chrome, {
        debugger: { attach, detach, sendCommand, onDetach: { addListener: vi.fn() } },
        permissions: { contains: vi.fn().mockResolvedValue(true) },
      });
      Object.assign(chrome.tabs, { getZoom: vi.fn(async () => zoom) });
      Reflect.deleteProperty(chrome.tabs, "captureTab");
      executeScript.mockImplementation(async () => {
        const size = emulated ?? { width: 1280, height: 720 };
        return [{ result: { width: Math.round(size.width / zoom), height: Math.round(size.height / zoom) } }];
      });
      return { attach, detach, sendCommand };
    }

    it("Chrome 以 CDP 按标签模拟视口尺寸，不调整窗口，截图复用调试连接", async () => {
      const { attach, detach, sendCommand } = stubEmulatingDebugger();

      await request("emulate", "page.viewport", { tabId: 101, width: 390, height: 844 });
      expect(sendCommand).toHaveBeenCalledWith({ tabId: 101 }, "Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 0,
        mobile: false,
      });
      expect(windowsUpdate).not.toHaveBeenCalled();
      expect(responseOf("emulate").data).toEqual({
        tabId: 101,
        windowId: 7,
        width: 390,
        height: 844,
        exact: true,
        scope: "tab",
      });

      await request("emulate-width", "page.viewport", { tabId: 101, width: 375 });
      expect(sendCommand).toHaveBeenLastCalledWith({ tabId: 101 }, "Emulation.setDeviceMetricsOverride", {
        width: 375,
        height: 844,
        deviceScaleFactor: 0,
        mobile: false,
      });

      await request("emulated-shot", "page.screenshot", { tabId: 101 });
      expect(responseOf("emulated-shot").data).toMatchObject({ width: 375, height: 844 });
      expect(attach).toHaveBeenCalledTimes(1);
      expect(detach).not.toHaveBeenCalled();

      await request("emulate-reset", "page.viewport", { tabId: 101, reset: true });
      expect(sendCommand).toHaveBeenLastCalledWith({ tabId: 101 }, "Emulation.clearDeviceMetricsOverride");
      expect(detach).toHaveBeenCalledTimes(1);
      expect(responseOf("emulate-reset").data).toEqual({
        tabId: 101,
        windowId: 7,
        width: 1280,
        height: 720,
        scope: "tab",
      });
    });

    it("Chrome 模拟尺寸按页面缩放换算为设备无关像素", async () => {
      const { sendCommand } = stubEmulatingDebugger(1.25);
      await request("emulate-zoomed", "page.viewport", { tabId: 101, width: 390, height: 844 });
      expect(sendCommand).toHaveBeenCalledWith({ tabId: 101 }, "Emulation.setDeviceMetricsOverride", {
        width: 488,
        height: 1055,
        deviceScaleFactor: 0,
        mobile: false,
      });
      expect(responseOf("emulate-zoomed").data).toMatchObject({ width: 390, height: 844, exact: true });
      await request("emulate-zoomed-reset", "page.viewport", { tabId: 101, reset: true });
    });

    it("标签移出代理窗口后仍可重置；清除失败也释放调试连接", async () => {
      const { detach, sendCommand } = stubEmulatingDebugger();
      await request("emulate-moved", "page.viewport", { tabId: 101, width: 390 });
      tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
      sendCommand.mockRejectedValueOnce(new Error("Inspected target navigated or closed"));
      await request("reset-moved", "page.viewport", { tabId: 101, personalTabId: 101, reset: true });
      expect(responseOf("reset-moved").error.message).toMatch(/Inspected target/);
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it("视口测量卡住时按超时失败而不永久占用标签队列", async () => {
      stubEmulatingDebugger();
      let finish = () => {};
      executeScript.mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve([{ result: { width: 1280, height: 720 } }])))
      );
      const pending = request("viewport-hung", "page.viewport", { tabId: 101, width: 390, timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await pending;
      expect(responseOf("viewport-hung").error.message).toMatch(/timed out/);
      finish();
      await vi.runAllTimersAsync();
      await request("viewport-hung-reset", "page.viewport", { tabId: 101, reset: true });
      expect(responseOf("viewport-hung-reset").data).toMatchObject({ scope: "tab" });
      await vi.runAllTimersAsync();
    });

    it("视口调整不改变代理窗口之外的个人窗口", async () => {
      tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
      await request("viewport-personal", "page.viewport", { tabId: 101, personalTabId: 101, width: 390 });
      expect(responseOf("viewport-personal").error.code).toBe("VIEWPORT_WINDOW_DENIED");
      expect(windowsUpdate).not.toHaveBeenCalled();
    });

    it("监控记录失败请求、控制台错误与导航，读取后清空", async () => {
      const t0 = Date.now();
      await request("monitor-start", "page.monitor.start", { tabId: 101, dialogs: "dismiss" });
      expect(responseOf("monitor-start").data).toEqual({ tabId: 101, monitoring: true });
      expect(executeScript).toHaveBeenLastCalledWith(
        expect.objectContaining({ target: { tabId: 101 }, world: "MAIN", args: ["install", "dismiss"] })
      );
      const failed = { tabId: 101, method: "GET", url: "https://a.test/api", statusCode: 404, timeStamp: t0 + 1 };
      for (const listener of requestEvents.onCompleted) {
        listener(failed);
        listener({ ...failed, statusCode: 200 });
        listener({ ...failed, tabId: 102 });
      }
      for (const listener of requestEvents.onErrorOccurred) {
        listener({
          tabId: 101,
          method: "POST",
          url: "https://a.test/save",
          error: "net::ERR_FAILED",
          timeStamp: t0 + 2,
        });
        listener({
          tabId: 101,
          method: "GET",
          url: "https://a.test/img",
          error: "net::ERR_ABORTED",
          timeStamp: t0 + 3,
        });
      }
      vi.advanceTimersByTime(5);
      console.error("oops");
      vi.advanceTimersByTime(5);
      for (const listener of [...commits]) listener({ tabId: 101, frameId: 0, url: "https://a.test/next" } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(executeScript).toHaveBeenLastCalledWith(
        expect.objectContaining({ injectImmediately: true, world: "MAIN" })
      );

      await request("monitor-read", "page.monitor.read", { tabId: 101 });
      expect(responseOf("monitor-read").data).toEqual({
        tabId: 101,
        dropped: 0,
        entries: [
          expect.objectContaining({ type: "request", status: 404, message: "GET https://a.test/api -> 404" }),
          expect.objectContaining({ type: "request", message: "POST https://a.test/save failed: net::ERR_FAILED" }),
          expect.objectContaining({ type: "console", level: "error", message: "oops" }),
          expect.objectContaining({ type: "navigation", url: "https://a.test/next" }),
        ],
      });
      await request("monitor-reread", "page.monitor.read", { tabId: 101 });
      expect(responseOf("monitor-reread").data.entries).toEqual([]);

      await request("monitor-stop", "page.monitor.stop", { tabId: 101 });
      expect(requestEvents.onCompleted.size).toBe(0);
      await request("monitor-gone", "page.monitor.read", { tabId: 101 });
      expect(responseOf("monitor-gone").error.code).toBe("MONITOR_NOT_STARTED");
    });

    it("分块接收上传内容后交给页面设置文件", async () => {
      executeScript.mockImplementation(async () => [
        { result: { success: true, value: { matched: { tag: "input" } } } },
      ]);
      await request("chunk-1", "page.upload.chunk", { uploadId: "u1", data: "aGVs" });
      await request("chunk-2", "page.upload.chunk", { uploadId: "u1", data: "bG8=" });
      expect(responseOf("chunk-2").data).toEqual({ uploadId: "u1", received: 8 });
      await request("upload", "page.upload", {
        tabId: 101,
        selector: "#cv",
        wait: "none",
        files: [{ name: "cv.txt", type: "text/plain", uploadId: "u1" }],
      });
      expect(executeScript).toHaveBeenLastCalledWith(
        expect.objectContaining({
          args: [{ op: "upload", selector: "#cv", files: [{ name: "cv.txt", type: "text/plain", data: "aGVsbG8=" }] }],
        })
      );
      expect(responseOf("upload").data).toMatchObject({ matched: { tag: "input" }, navigated: false });

      await request("upload-again", "page.upload", {
        tabId: 101,
        files: [{ name: "cv.txt", type: "text/plain", uploadId: "u1" }],
      });
      expect(responseOf("upload-again").error.code).toBe("UPLOAD_NOT_FOUND");
    });

    it("跳转地址并等待加载完成", async () => {
      const tab = { id: 101, windowId: 7, url: "https://a.test/", title: "A", status: "complete" };
      tabsGet.mockImplementation(async () => ({ ...tab }));
      tabsUpdate.mockImplementation(async (id: number, { url }: { url: string }) => {
        Object.assign(tab, { status: "loading", url });
        tabUpdated(id, { status: "loading", url });
        return tab;
      });
      const pending = request("goto", "page.goto", { tabId: 101, url: "https://b.test/", wait: "load" });
      await vi.advanceTimersByTimeAsync(100);
      Object.assign(tab, { status: "complete", title: "B" });
      tabUpdated(101, { status: "complete" });
      await pending;
      expect(tabsUpdate).toHaveBeenCalledWith(101, { url: "https://b.test/" });
      expect(responseOf("goto").data).toEqual({
        tabId: 101,
        navigated: true,
        url: "https://b.test/",
        title: "B",
        status: "complete",
      });
    });

    it("等待元素出现，超时返回 WAIT_TIMEOUT，缺少条件时拒绝", async () => {
      tabsGet.mockResolvedValue({ id: 101, windowId: 7, url: "https://a.test/done", status: "complete" });
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<p class="ok">ok</p>`), 200);
      const found = request("wait", "page.wait", { tabId: 101, selector: ".ok", url: "/done$", timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(300);
      await found;
      expect(responseOf("wait").data).toMatchObject({ matched: { tag: "p" }, url: "https://a.test/done" });

      const missing = request("wait-timeout", "page.wait", { tabId: 101, selector: ".never", timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(600);
      await missing;
      expect(responseOf("wait-timeout").error.code).toBe("WAIT_TIMEOUT");

      await request("wait-empty", "page.wait", { tabId: 101 });
      expect(responseOf("wait-empty").error.code).toBe("INVALID_ARGUMENT");
    });

    it("等待期间主文档导航应在新文档上继续等待", async () => {
      tabsGet.mockResolvedValue({ id: 101, windowId: 7, url: "https://a.test/next", status: "complete" });
      executeScript.mockImplementationOnce(() => new Promise(() => {}));
      const waiting = request("wait-across", "page.wait", { tabId: 101, selector: ".welcome", timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(10);
      for (const listener of commits) listener({ tabId: 101, frameId: 0 });
      document.body.insertAdjacentHTML("beforeend", `<p class="welcome">Welcome</p>`);
      await vi.advanceTimersByTimeAsync(300);
      await waiting;
      expect(responseOf("wait-across").data).toMatchObject({ matched: { tag: "p" } });
    });

    it("新建标签可等待加载完成并返回状态", async () => {
      let status = "loading";
      tabsGet.mockImplementation(async (id: number) => ({ id, windowId: 7, status }));
      const pending = request("create-wait", "tabs.create", { url: "https://a.test/", wait: "load" });
      await vi.advanceTimersByTimeAsync(100);
      status = "complete";
      tabUpdated(103, { status: "complete" });
      await pending;
      expect(responseOf("create-wait").data).toMatchObject({ id: 103, status: "complete" });
    });
  });

  it("无效选择器应通过可克隆结果保留语法错误", async () => {
    executeScript.mockImplementationOnce(async ({ func, args }) => {
      try {
        return [{ result: await func(...args) }];
      } catch {
        return [{ error: { message: "non-structured-clonable data" } }];
      }
    });
    await request("content-selector", "page.content", { tabId: 101, selector: "[" });
    const response = postMessage.mock.calls.find(([message]) => message.id === "content-selector")?.[0];
    expect(response.payload.cmd).toBe("error");
    expect(response.payload.error.message).toContain("selector");
    expect(response.payload.error.message).not.toContain("non-structured-clonable");
  });

  it("运行超时后应立即拒绝同标签操作并在原执行结束后恢复", async () => {
    let release!: () => void;
    executeScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ result: { success: true, value: 1 } }]);
        })
    );
    const exec = request("active-timeout", "page.exec", { tabId: 101, code: "new Promise(() => {})", timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(6);
    await exec;
    const content = request("blocked-content", "page.content", { tabId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "blocked-content",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "TAB_EXECUTION_PENDING" }) }),
      })
    );
    release();
    await content;
    await vi.advanceTimersByTimeAsync(0);
    executeScript.mockResolvedValueOnce([{ result: { success: true, value: 2 } }]);
    await request("recovered", "page.exec", { tabId: 101, code: "2" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "recovered", payload: { cmd: "page.exec", data: { result: 2 } } })
    );
  });

  it("脚本列表应保留 run-at 元数据", async () => {
    disconnect();
    initNativeMessaging({
      getAllScripts: async () => [{ uuid: "script", metadata: { "run-at": ["document-end"] } }],
    } as unknown as ScriptService);
    await request("scripts", "script.list", {});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "scripts",
        payload: expect.objectContaining({ data: [expect.objectContaining({ runAt: "document-end" })] }),
      })
    );
  });

  it("超时标签应允许授权重载并在主文档提交后恢复所有操作", async () => {
    let release!: () => void;
    executeScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ result: { success: true, value: 1 } }]);
        })
    );
    const running = request("never", "page.exec", { tabId: 101, code: "new Promise(() => {})", timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(6);
    await running;
    await request("pause", "sessions.pause", {});
    await request("paused-reload", "page.reload", { tabId: 101 });
    expect(tabsReload).not.toHaveBeenCalled();
    await request("resume", "sessions.resume", {});
    await request("recovery-reload", "page.reload", { tabId: 101 });
    expect(tabsReload).toHaveBeenCalledWith(101, { bypassCache: false });
    await request("still-blocked", "page.screenshot", { tabId: 101 });
    expect(captureTab).not.toHaveBeenCalled();
    for (const listener of commits) listener({ tabId: 101, frameId: 0 });
    executeScript.mockResolvedValueOnce([{ result: { success: true, value: 2 } }]);
    await request("new-document", "page.exec", { tabId: 101, code: "2" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-document", payload: { cmd: "page.exec", data: { result: 2 } } })
    );
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  function errorOf(id: string) {
    const call = postMessage.mock.calls.find(([message]) => message.id === id);
    return call?.[0].payload.error as { code?: string; message: string } | undefined;
  }

  it("内容读取挂起时应在期限内报错、隔离标签并可经重载恢复", async () => {
    executeScript.mockImplementationOnce(() => new Promise(() => {}));
    const content = request("hung-content", "page.content", { tabId: 101, timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(6);
    await content;
    expect(errorOf("hung-content")?.message).toContain("page.content timed out after 5ms");
    await request("blocked", "page.exec", { tabId: 101, code: "1" });
    expect(errorOf("blocked")?.code).toBe("TAB_EXECUTION_PENDING");
    await request("recovery-reload", "page.reload", { tabId: 101 });
    expect(tabsReload).toHaveBeenCalledWith(101, { bypassCache: false });
    for (const listener of commits) listener({ tabId: 101, frameId: 0 });
    executeScript.mockResolvedValueOnce([{ result: { success: true, value: 2 } }]);
    await request("after-reload", "page.exec", { tabId: 101, code: "2" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "after-reload", payload: { cmd: "page.exec", data: { result: 2 } } })
    );
  });

  it("挂起的快照在用户重载主文档后应释放标签队列", async () => {
    executeScript.mockImplementationOnce(() => new Promise(() => {}));
    const snapshot = request("hung-snapshot", "page.snapshot", { tabId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of commits) listener({ tabId: 101, frameId: 0 });
    await snapshot;
    expect(errorOf("hung-snapshot")?.code).toBe("TAB_DOCUMENT_CHANGED");
    executeScript.mockResolvedValueOnce([{ result: { success: true, value: 2 } }]);
    await request("fresh-document", "page.exec", { tabId: 101, code: "2" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "fresh-document", payload: { cmd: "page.exec", data: { result: 2 } } })
    );
  });

  it("挂起的页面动作与截图应在调用方期限内报错而非无限占用标签", async () => {
    executeScript.mockImplementationOnce(() => new Promise(() => {}));
    const click = request("hung-click", "page.click", { tabId: 101, selector: "button", timeoutMs: 5 });
    captureTab.mockImplementationOnce(() => new Promise(() => {}));
    const shot = request("hung-shot", "page.screenshot", { tabId: 102, timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([click, shot]);
    expect(errorOf("hung-click")?.message).toContain("page.click timed out");
    expect(errorOf("hung-shot")?.message).toContain("page.screenshot timed out after 5ms");
    for (const listener of commits) {
      listener({ tabId: 101, frameId: 0 });
      listener({ tabId: 102, frameId: 0 });
    }
  });

  it("人工切换器无需登记代理窗口即可列出普通窗口标签", async () => {
    await chrome.storage.local.set({ "browserControl.agentWindow": { sessions: [] } });
    await request("switcher-list", "switcher.tabs.list", { sessionId: undefined });
    expect(tabsQuery).toHaveBeenCalledWith({});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "switcher-list",
        payload: {
          cmd: "switcher.tabs.list",
          data: [expect.objectContaining({ id: 101, windowId: 7 }), expect.objectContaining({ id: 102, windowId: 8 })],
        },
      })
    );
    await request("agent-list", "tabs.list", {});
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-list",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "AGENT_WINDOW_MISSING" }) }),
      })
    );
  });

  it("代理关闭工作标签而不能关闭个人或标记标签", async () => {
    await request("close-work", "tabs.close", { tabId: 101 });
    expect(tabsRemove).toHaveBeenCalledWith(101);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "close-work", payload: { cmd: "tabs.close", data: { tabId: 101, closed: true } } })
    );
    tabsGet.mockResolvedValue({ id: 102, windowId: 8 });
    await request("close-personal", "tabs.close", { tabId: 102, personalTabId: 102 });
    await request("close-marker", "tabs.close", { tabId: 900 });
    expect(tabsRemove).toHaveBeenCalledTimes(1);
    for (const [id, code] of [
      ["close-personal", "PERSONAL_TAB_DENIED"],
      ["close-marker", "AGENT_MARKER_PROTECTED"],
    ])
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id, payload: expect.objectContaining({ error: expect.objectContaining({ code }) }) })
      );
  });

  it("人工切换器可关闭任意标签但不能关闭代理窗口标记", async () => {
    tabsGet.mockResolvedValue({ id: 102, windowId: 8 });
    await request("switcher-close", "switcher.tabs.close", { tabId: 102, sessionId: undefined });
    await request("switcher-close-marker", "switcher.tabs.close", { tabId: 900, sessionId: undefined });
    expect(tabsRemove).toHaveBeenCalledTimes(1);
    expect(tabsRemove).toHaveBeenCalledWith(102);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "switcher-close-marker",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "AGENT_MARKER_PROTECTED" }) }),
      })
    );
  });

  it("人工切换器可聚焦个人标签且不会授权代理读取页面", async () => {
    tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
    tabsUpdate.mockResolvedValue({ id: 101, windowId: 8 });
    await request("switcher-focus", "switcher.tabs.focus", { tabId: 101, windowId: 8, sessionId: undefined });
    expect(tabsUpdate).toHaveBeenCalledWith(101, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(8, { focused: true });
    await request("agent-content", "page.content", { tabId: 101 });
    expect(executeScript).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-content",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "PERSONAL_TAB_DENIED" }) }),
      })
    );
  });

  it("人工切换器拒绝错误窗口及未实现的页面命令", async () => {
    await request("wrong-window", "switcher.tabs.focus", { tabId: 101, windowId: 8 });
    await request("switcher-page", "switcher.page.exec", { tabId: 101, code: "document.title" });
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "wrong-window",
        payload: expect.objectContaining({
          error: expect.objectContaining({ message: "windowId does not match target tab" }),
        }),
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "switcher-page",
        payload: expect.objectContaining({ error: expect.objectContaining({ code: "UNKNOWN_COMMAND" }) }),
      })
    );
  });

  it("人工切换器聚焦请求排队期间标签移到其他窗口时应拒绝激活", async () => {
    let release!: () => void;
    const held = withNativeWindowOperation(
      7,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(0);
    const pending = request("moved-switcher-tab", "switcher.tabs.focus", { tabId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    tabsGet.mockResolvedValue({ id: 101, windowId: 8 });
    release();
    await held;
    await pending;
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(windowsUpdate).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "moved-switcher-tab",
        payload: expect.objectContaining({
          error: expect.objectContaining({ message: "windowId does not match target tab" }),
        }),
      })
    );
  });

  it("未登记代理窗口时人工切换器仍可聚焦标签并接收关闭事件", async () => {
    await chrome.storage.local.set({ "browserControl.agentWindow": { sessions: [] } });
    await request("switcher-focus-no-agent", "switcher.tabs.focus", { tabId: 101, sessionId: undefined });
    expect(tabsUpdate).toHaveBeenCalledWith(101, { active: true });
    await request("switcher-removed", "switcher.tabs.subscribe", { events: ["onRemoved"] });
    const [handler] = vi.mocked(chrome.tabs.onRemoved.addListener).mock.calls.at(-1)!;
    handler(101, { windowId: 7, isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event",
        payload: {
          cmd: "switcher.tabs.event",
          data: expect.objectContaining({
            type: "tab-removed",
            tabId: expect.objectContaining({ tabId: 101, windowId: 7 }),
          }),
        },
      })
    );
  });

  it("人工切换器事件单独发送且代理事件仍限定专用窗口", async () => {
    await request("agent-events", "tabs.subscribe", { events: ["onActivated"] });
    await request("switcher-events", "switcher.tabs.subscribe", { events: ["onActivated"] });
    await request("switcher-events-repeat", "switcher.tabs.subscribe", { events: ["onActivated"] });
    tabsGet.mockResolvedValue({ id: 102, windowId: 8 });
    for (const handler of activations) handler({ tabId: 102, windowId: 8 });
    await vi.advanceTimersByTimeAsync(0);
    const events = postMessage.mock.calls.map(([message]) => message).filter((message) => message.type === "event");
    expect(events).toEqual([
      expect.objectContaining({
        payload: {
          cmd: "switcher.tabs.event",
          data: expect.objectContaining({
            type: "tab-focused",
            tabId: expect.objectContaining({ tabId: 102, windowId: 8 }),
          }),
        },
      }),
    ]);
    disconnect();
    expect(activations.size).toBe(0);
  });

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
    expect(eventAdd).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledTimes(2);
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
      debugger: { attach, detach, sendCommand, onDetach: { addListener: vi.fn() } },
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
          error: { code: "SCRIPT_ERROR", message: "script failed" },
        }),
      })
    );
  });

  it("脚本结果超过字符上限时截断并报告总长度", async () => {
    executeScript.mockImplementationOnce(
      async ({ func, args }: { func: (code: string, maxChars: number) => unknown; args: [string, number] }) => [
        { frameId: 0, result: await func(...args) },
      ]
    );
    await request("exec-long", "page.exec", { tabId: 101, code: "'x'.repeat(50)", maxChars: 10 });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exec-long",
        payload: { cmd: "page.exec", data: { result: "x".repeat(10), truncated: true, totalLength: 50 } },
      })
    );
  });

  it("页面 CSP 禁止 eval 时经 userScripts 注入源码执行，语句形式回退为函数体", async () => {
    const execute = vi.fn(async ({ js }: { js: [{ code: string }] }) => {
      (0, eval)(js[0].code);
      return [{ frameId: 0 }];
    });
    (chrome as unknown as { userScripts: unknown }).userScripts = { execute };
    executeScript.mockImplementation(
      async ({ func, args }: { func: (...values: unknown[]) => unknown; args: unknown[] }) =>
        args.length === 2
          ? [{ frameId: 0, result: { success: false, code: "CSP_BLOCKED", error: "unsafe-eval" } }]
          : [{ frameId: 0, result: await func(...args) }]
    );
    await request("csp-expr", "page.exec", { tabId: 101, code: "({ sum: 1 + 1 })" });
    expect(responseOf("csp-expr")).toEqual({ cmd: "page.exec", data: { result: { sum: 2 } } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 101 }, world: "MAIN" }));

    await request("csp-body", "page.exec", { tabId: 101, code: "const a = 2;\nreturn a * 3" });
    expect(responseOf("csp-body")).toEqual({ cmd: "page.exec", data: { result: 6 } });
    expect(execute).toHaveBeenCalledTimes(3);

    await request("csp-syntax", "page.exec", { tabId: 101, code: "return (" });
    expect(responseOf("csp-syntax").error).toMatchObject({ code: "SCRIPT_ERROR" });
  });

  it("没有 userScripts.execute 时保留 CSP_BLOCKED", async () => {
    executeScript.mockResolvedValueOnce([
      { frameId: 0, result: { success: false, code: "CSP_BLOCKED", error: "unsafe-eval" } },
    ]);
    await request("csp-none", "page.exec", { tabId: 101, code: "1" });
    expect(responseOf("csp-none").error.code).toBe("CSP_BLOCKED");
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
