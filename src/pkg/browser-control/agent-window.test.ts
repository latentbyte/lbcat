import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentWindowService, AgentTaskWindowScope, type AgentWindowDependencies } from "./agent-window";

function mockTab(properties: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    index: 0,
    windowId: 7,
    pinned: false,
    highlighted: false,
    active: false,
    frozen: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    ...properties,
  };
}

describe("代理专用窗口与标签租约", () => {
  let service: AgentWindowService;
  let stored: unknown;
  let nextId: number;
  let now: number;
  let tabs: Map<number, chrome.tabs.Tab>;
  let deps: AgentWindowDependencies;

  beforeEach(() => {
    stored = undefined;
    nextId = 100;
    now = 1000;
    tabs = new Map();
    deps = {
      load: async () => stored,
      save: async (value) => {
        stored = structuredClone(value);
      },
      markerUrl: () => "chrome-extension://test/src/agent-window.html",
      id: () => String(nextId++),
      now: () => now,
      getTab: async (id) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("missing tab");
        return tab;
      },
      listTabs: async (windowId) => [...tabs.values()].filter((tab) => tab.windowId === windowId),
      createTab: vi.fn(async (properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> => {
        const tab = mockTab({
          id: nextId++,
          windowId: properties.windowId!,
          url: properties.url!,
          active: properties.active ?? false,
        });
        tabs.set(tab.id!, tab);
        return tab;
      }),
      getWindow: async (id) => ({ id, focused: false, alwaysOnTop: false, incognito: false, type: "normal" }),
      listWindows: async () => [{ id: 7, focused: false, alwaysOnTop: false, incognito: false, type: "normal" }],
      createWindow: vi.fn(async (properties: chrome.windows.CreateData): Promise<chrome.windows.Window> => {
        const tab = mockTab({ id: nextId++, windowId: 7, url: String(properties.url) });
        tabs.set(tab.id!, tab);
        return { id: 7, focused: false, alwaysOnTop: false, incognito: false, type: "normal", tabs: [tab] };
      }),
      allTabs: async () => [...tabs.values()],
      removeTab: vi.fn(async (id: number) => {
        tabs.delete(id);
      }),
    };
    service = new AgentWindowService(deps);
  });

  // 重启会清空标签与会话存储，只保留本地存储中的登记
  function restartBrowser(): void {
    tabs.clear();
    delete (stored as { verifiedMarkerUrl?: string }).verifiedMarkerUrl;
  }

  async function prepare(): Promise<string> {
    await service.designate(7);
    return (await service.openSession()).sessionId;
  }

  it("未登记窗口时应阻止任务而非选择当前窗口", async () => {
    await expect(service.openSession()).rejects.toMatchObject({
      code: "AGENT_WINDOW_MISSING",
      message: expect.stringContaining("No agent window is registered"),
    });
    expect(deps.createTab).not.toHaveBeenCalled();
  });

  it("会话 ID 取 8 位短 ID 且避开现有会话", async () => {
    await service.designate(7);
    const ids = [
      "ab12cd34-0000-4000-8000-000000000001",
      "ab12cd34-0000-4000-8000-000000000002",
      "ef56ab78-0000-4000-8000-000000000003",
    ];
    deps.id = () => ids.shift()!;
    expect((await service.openSession()).sessionId).toBe("ab12cd34");
    expect((await service.openSession()).sessionId).toBe("ef56ab78");
  });

  it("创建专用窗口时不抢焦点", async () => {
    const status = await service.create();
    expect(deps.createWindow).toHaveBeenCalledWith(expect.objectContaining({ focused: false, type: "normal" }));
    await expect(service.status()).resolves.toEqual(status);
  });

  it("指定窗口时不固定标记标签以免 Zen 将其复制到每个新窗口", async () => {
    await service.designate(7);
    expect(deps.createTab).toHaveBeenCalledWith(expect.not.objectContaining({ pinned: true }));
  });

  it("新窗口返回多个标签时按唯一标记 URL 选择而非标签顺序", async () => {
    const createWindow = deps.createWindow;
    deps.createWindow = async (properties) => {
      const window = (await createWindow(properties))!;
      const inherited = mockTab({ id: 1, url: "https://example.org" });
      tabs.set(1, inherited);
      return { ...window, tabs: [inherited, ...window.tabs!] };
    };
    const status = await service.create();
    expect(tabs.get(status.markerTabId)?.url).toContain("?registration=");
    await expect(service.status()).resolves.toEqual(status);
  });

  it("创建标记尚未提交导航时等待实际 URL 而非保存待导航身份", async () => {
    vi.useFakeTimers();
    try {
      const createWindow = deps.createWindow;
      deps.createWindow = async (properties) => {
        const window = (await createWindow(properties))!;
        const marker = window.tabs![0];
        marker.pendingUrl = marker.url;
        marker.url = "about:blank";
        setTimeout(() => {
          marker.url = marker.pendingUrl;
          delete marker.pendingUrl;
        }, 50);
        return window;
      };
      const pending = service.create();
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(75);
      const status = await pending;
      await expect(service.status()).resolves.toEqual(status);
    } finally {
      vi.useRealTimers();
    }
  });

  it("窗口返回标签缺少标记时通过窗口查询寻找确切标记", async () => {
    const createWindow = deps.createWindow;
    deps.createWindow = async (properties) => {
      const window = (await createWindow(properties))!;
      return { ...window, tabs: [mockTab({ id: 1, url: "https://example.org" })] };
    };
    const status = await service.create();
    expect(tabs.get(status.markerTabId)?.url).toContain("?registration=");
    await expect(service.status()).resolves.toEqual(status);
  });

  it("窗口初始查询只有继承标签与空白页时重试直到标记 URL 出现", async () => {
    vi.useFakeTimers();
    try {
      const createWindow = deps.createWindow;
      deps.createWindow = async (properties) => {
        const window = (await createWindow(properties))!;
        const marker = window.tabs![0];
        const markerUrl = marker.url;
        marker.url = "about:blank";
        tabs.set(1, mockTab({ id: 1, url: "https://example.org" }));
        setTimeout(() => {
          marker.url = markerUrl;
        }, 75);
        return { ...window, tabs: [tabs.get(1)!, { ...marker }] };
      };
      const listTabs = deps.listTabs;
      deps.listTabs = vi.fn(async (windowId) => (await listTabs(windowId)).map((tab) => ({ ...tab })));
      const outcome = service.create().then(
        (status) => ({ status }),
        (error: unknown) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);
      const result = await outcome;
      expect(result).toHaveProperty("status");
      if (!("status" in result)) throw result.error;
      expect(deps.listTabs).toHaveBeenCalledTimes(4);
      await expect(service.status()).resolves.toEqual(result.status);
      const sessionId = (await service.openSession()).sessionId;
      await expect(service.listTabs(sessionId)).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("始终无法发现精确标记时超时并保留原登记", async () => {
    vi.useFakeTimers();
    try {
      const original = await service.designate(7);
      deps.createWindow = async () => ({
        id: 8,
        focused: false,
        alwaysOnTop: false,
        incognito: false,
        type: "normal",
        tabs: [mockTab({ id: 1, windowId: 8, url: "https://example.org" })],
      });
      let settled = false;
      const pending = service.create().finally(() => {
        settled = true;
      });
      const result = expect(pending).rejects.toThrow("Could not identify agent window marker");
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1900);
      await result;
      await expect(service.status()).resolves.toEqual(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it("标记导航超时后拒绝登记且不阻塞下一次明确指定", async () => {
    vi.useFakeTimers();
    try {
      const createWindow = deps.createWindow;
      deps.createWindow = async (properties) => {
        const window = (await createWindow(properties))!;
        const marker = window.tabs![0];
        marker.pendingUrl = marker.url;
        marker.url = "about:blank";
        return window;
      };
      const result = expect(service.create()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
      await vi.advanceTimersByTimeAsync(2000);
      await result;
      await service.designate(7);
      await expect(service.status()).resolves.toMatchObject({ windowId: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("创建窗口继承的标签不因窗口 ID 相同而获得授权", async () => {
    const createWindow = deps.createWindow;
    deps.createWindow = async (properties) => {
      const window = (await createWindow(properties))!;
      tabs.set(1, mockTab({ id: 1, url: "https://example.org" }));
      return window;
    };
    await service.create();
    const sessionId = (await service.openSession()).sessionId;
    await expect(service.listTabs(sessionId)).resolves.toEqual([]);
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await expect(service.assertTabAccess(1, sessionId, 1)).resolves.toMatchObject({ id: 1 });
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await service.designate(7);
    const granted = (await service.openSession()).sessionId;
    await expect(service.assertTabAccess(1, granted)).resolves.toMatchObject({ id: 1 });
  });

  it("指定窗口仅授权当时已有的工作标签而不授权之后迁入的标签", async () => {
    tabs.set(1, mockTab({ id: 1, url: "https://example.org" }));
    const sessionId = await prepare();
    tabs.set(2, mockTab({ id: 2, url: "https://example.net" }));
    await expect(service.assertTabAccess(1, sessionId)).resolves.toMatchObject({ id: 1 });
    await expect(service.assertTabAccess(2, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await expect(service.listTabs(sessionId)).resolves.toEqual([tabs.get(1)]);
  });

  it("旧格式登记缺少明确标签授权时应关闭默认访问", async () => {
    tabs.set(1, mockTab({ id: 1, url: "https://example.org" }));
    const sessionId = await prepare();
    const state = stored as { registration: { eligibleTabIds?: number[] } };
    delete state.registration.eligibleTabIds;
    await expect(service.listTabs(sessionId)).resolves.toEqual([]);
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
  });

  it("重新指定后的旧标记与复制的标记页面始终不作为工作标签", async () => {
    const previous = await service.designate(7);
    tabs.set(1, mockTab({ id: 1, url: deps.markerUrl() + "?registration=old#copied" }));
    const sessionId = await prepare();
    await expect(service.listTabs(sessionId)).resolves.toEqual([]);
    for (const id of [previous.markerTabId, 1]) {
      await expect(service.assertTabAccess(id, sessionId, id)).rejects.toMatchObject({
        code: "AGENT_MARKER_PROTECTED",
      });
    }
  });

  it("标记被关闭或移动后应拒绝旧登记", async () => {
    const status = await service.designate(7);
    tabs.get(status.markerTabId)!.windowId = 8;
    await expect(service.status()).rejects.toMatchObject({
      code: "AGENT_WINDOW_MISSING",
      message: expect.stringContaining("marker tab moved to another window"),
    });
    tabs.delete(status.markerTabId);
    await expect(service.status()).rejects.toMatchObject({
      code: "AGENT_WINDOW_MISSING",
      message: expect.stringContaining("marker tab was closed"),
    });
  });

  it("复用数字标签 ID 但 URL 不匹配时应拒绝", async () => {
    const status = await service.designate(7);
    tabs.get(status.markerTabId)!.url = "https://example.com";
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
  });

  it("浏览器重启后按唯一登记标记恢复窗口并清除失效的标签授权", async () => {
    tabs.set(1, mockTab({ id: 1, url: "https://example.org" }));
    const sessionId = await prepare();
    await service.assertTabAccess(1, sessionId);
    const { markerUrl } = (stored as { registration: { markerUrl: string } }).registration;
    restartBrowser();
    tabs.set(1, mockTab({ id: 1, windowId: 9, url: "https://personal.example" }));
    tabs.set(50, mockTab({ id: 50, windowId: 9, url: markerUrl }));
    await expect(service.status()).resolves.toEqual({ windowId: 9, markerTabId: 50 });
    await expect(service.listTabs(sessionId)).resolves.toEqual([]);
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    const created = await service.createTab(sessionId, "https://example.com");
    expect(created.windowId).toBe(9);
  });

  it("重启后存在多个相同登记标记副本时拒绝恢复", async () => {
    await service.designate(7);
    const { markerUrl } = (stored as { registration: { markerUrl: string } }).registration;
    restartBrowser();
    tabs.set(50, mockTab({ id: 50, windowId: 9, url: markerUrl }));
    tabs.set(51, mockTab({ id: 51, windowId: 10, url: markerUrl }));
    await expect(service.status()).rejects.toMatchObject({
      code: "AGENT_WINDOW_MISSING",
      message: expect.stringContaining("2 copies of the agent window marker"),
    });
  });

  it("扩展重载或浏览器重启后标记丢失时提示原因与恢复命令", async () => {
    await service.designate(7);
    restartBrowser();
    await expect(service.status()).rejects.toMatchObject({
      code: "AGENT_WINDOW_MISSING",
      message: expect.stringMatching(/marker tab is gone .*extension reload.*browser restart.*agent-window create/),
    });
  });

  it("同一次浏览器运行中关闭标记后不得改绑到残留的标记副本", async () => {
    const status = await service.designate(7);
    const { markerUrl } = (stored as { registration: { markerUrl: string } }).registration;
    tabs.delete(status.markerTabId);
    tabs.set(50, mockTab({ id: 50, windowId: 9, url: markerUrl }));
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
  });

  it("工作标签只能在专用窗口后台创建并绑定任务", async () => {
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    expect(deps.createTab).toHaveBeenLastCalledWith({ windowId: 7, url: "https://example.com", active: false });
    await expect(service.assertTabAccess(tab.id!, sessionId)).resolves.toMatchObject({ id: tab.id });
  });

  it("普通窗口标签默认拒绝且例外只匹配指定标签", async () => {
    const sessionId = await prepare();
    tabs.set(1, mockTab({ id: 1, windowId: 8, url: "https://example.com" }));
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await expect(service.assertTabAccess(1, sessionId, 2)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await expect(service.assertTabAccess(1, sessionId, 1)).resolves.toMatchObject({ id: 1 });
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
  });

  it("两个任务不能同时占用同一标签", async () => {
    tabs.set(1, mockTab({ id: 1, windowId: 7 }));
    const first = await prepare();
    const second = (await service.openSession()).sessionId;
    const results = await Promise.allSettled([service.assertTabAccess(1, first), service.assertTabAccess(1, second)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "TAB_BUSY" } });
  });

  it("已出租标签不能被无任务的内置工具接管", async () => {
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    await expect(service.assertWindowTab(tab.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
  });

  it("任务过期或暂停后应拒绝操作直到恢复", async () => {
    tabs.set(1, mockTab({ id: 1, windowId: 7 }));
    await service.designate(7);
    const sessionId = (await service.openSession(1000)).sessionId;
    now = 2000;
    await expect(service.assertTabAccess(1, sessionId)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    const next = (await service.openSession()).sessionId;
    await service.pauseSession(next);
    await expect(service.assertTabAccess(1, next)).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    await service.resumeSession(next);
    await expect(service.assertTabAccess(1, next)).resolves.toMatchObject({ id: 1 });
  });

  it("结束任务释放租约而不关闭工作标签", async () => {
    const first = await prepare();
    const tab = await service.createTab(first, "https://example.com");
    await service.closeSession(first);
    const second = (await service.openSession()).sessionId;
    await expect(service.assertTabAccess(tab.id!, second)).resolves.toMatchObject({ id: tab.id });
    expect(tabs.has(tab.id!)).toBe(true);
  });

  it("结束任务时可关闭自己的工作标签但保留个人标签与已消失标签", async () => {
    const sessionId = await prepare();
    const work = await service.createTab(sessionId, "https://example.com");
    const gone = await service.createTab(sessionId, "https://example.com/gone");
    tabs.set(1, mockTab({ id: 1, windowId: 8, url: "https://personal.example" }));
    await service.setTabGrant(1, { mode: "all" });
    await service.assertTabAccess(1, sessionId);
    tabs.delete(gone.id!);
    await expect(service.closeSession(sessionId, { closeTabs: true })).resolves.toEqual({
      closedTabIds: [work.id],
      keptTabIds: [1],
    });
    expect(deps.removeTab).toHaveBeenCalledTimes(1);
    expect(tabs.has(1)).toBe(true);
    await expect(service.listSessions()).resolves.toEqual([]);
  });

  it("暂停的任务结束时不关闭人工可能正在使用的标签", async () => {
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    await service.pauseSession(sessionId);
    await expect(service.closeSession(sessionId, { closeTabs: true })).resolves.toEqual({
      closedTabIds: [],
      keptTabIds: [tab.id],
    });
    expect(deps.removeTab).not.toHaveBeenCalled();
  });

  it("标签移出窗口后应拒绝原任务继续操作", async () => {
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    tabs.get(tab.id!)!.windowId = 8;
    await expect(service.assertTabAccess(tab.id!, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
  });

  it("标记标签不得作为工作标签或个人例外", async () => {
    const sessionId = await prepare();
    const status = await service.status();
    await expect(service.assertTabAccess(status.markerTabId, sessionId, status.markerTabId)).rejects.toMatchObject({
      code: "AGENT_MARKER_PROTECTED",
    });
  });

  it("缺少窗口后登记成功时原任务作用域可以重试", async () => {
    const scope = new AgentTaskWindowScope(service);
    await expect(scope.listTabs()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
    await service.designate(7);
    await expect(scope.listTabs()).resolves.toEqual([]);
  });

  it("列表只返回专用窗口中未被其他任务占用的工作标签", async () => {
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    const first = await prepare();
    const second = (await service.openSession()).sessionId;
    const tab = await service.createTab(first, "https://example.com");
    tabs.set(1, mockTab({ id: 1, windowId: 8 }));
    await expect(service.listTabs(second)).resolves.toEqual([mockTab({ id: 2, windowId: 7 })]);
    await expect(service.listTabs(first)).resolves.toEqual([mockTab({ id: 2, windowId: 7 }), tab]);
  });
  it("内置任务作用域在租约过期后并发调用只开启一个新会话", async () => {
    await service.designate(7);
    const scope = new AgentTaskWindowScope(service);
    const tab = await scope.createTab("https://example.com");
    now += 15 * 60 * 1000;
    await expect(Promise.all([scope.listTabs(), scope.assertWindowTab(tab.id!)])).resolves.toEqual([[tab], tab]);
    expect(await service.listSessions()).toHaveLength(1);
    await scope.close();
  });

  it("重新指定窗口后已缓存的内置任务作用域恢复并排除旧标记", async () => {
    await service.designate(7);
    const scope = new AgentTaskWindowScope(service);
    const tab = await scope.createTab("https://example.com");
    await service.designate(7);
    await expect(scope.listTabs()).resolves.toEqual([tab]);
    await scope.close();
  });

  it("暂停与其他任务占用不得触发内置会话重建", async () => {
    await service.designate(7);
    const scope = new AgentTaskWindowScope(service);
    const tab = await scope.createTab("https://example.com");
    const [{ sessionId }] = await service.listSessions();
    await service.pauseSession(sessionId);
    await expect(scope.listTabs()).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    expect(await service.listSessions()).toHaveLength(1);
    await service.resumeSession(sessionId);
    now += 15 * 60 * 1000;
    const other = (await service.openSession()).sessionId;
    await service.assertTabAccess(tab.id!, other);
    await expect(scope.assertWindowTab(tab.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
    const sessions = await service.listSessions();
    expect(sessions).toHaveLength(2);
    await expect(scope.assertWindowTab(tab.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
    expect(await service.listSessions()).toEqual(sessions);
    await scope.close();
  });

  it("暂停租约即使过期并有其他任务开启也不得被内置恢复绕过", async () => {
    await service.designate(7);
    const scope = new AgentTaskWindowScope(service);
    await scope.listTabs();
    const [{ sessionId }] = await service.listSessions();
    await service.pauseSession(sessionId);
    now += 15 * 60 * 1000;
    await service.openSession();
    await expect(scope.listTabs()).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    await expect(scope.listTabs()).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    await scope.close();
  });

  it("标签事件只包含明确授权的标签且不因其他任务占用而隐藏", async () => {
    await service.create();
    const first = (await service.openSession()).sessionId;
    const tab = await service.createTab(first, "https://example.com");
    tabs.set(1, mockTab({ id: 1, windowId: 7, url: "https://example.org" }));
    await expect(service.allowsTabEvent(tab.id!, 7, tab.url)).resolves.toBe(true);
    await expect(service.allowsTabEvent(tab.id!, 7)).resolves.toBe(true);
    await expect(service.allowsTabEvent(1, 7)).resolves.toBe(false);
    await expect(service.allowsTabEvent(tab.id!, 8)).resolves.toBe(false);
    await expect(service.allowsTabEvent(tab.id!, 7, deps.markerUrl() + "?registration=old")).resolves.toBe(false);
    expect((await service.listSessions())[0].tabIds).toEqual([tab.id]);
  });

  it("新窗口不是普通非隐身窗口时不得登记", async () => {
    const createWindow = deps.createWindow;
    deps.createWindow = async (properties) => ({ ...(await createWindow(properties))!, incognito: true });
    await expect(service.create()).rejects.toMatchObject({ code: "INVALID_AGENT_WINDOW" });
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
  });

  it("任务范围关闭后应立即释放标签而无需等待租约过期", async () => {
    await service.designate(7);
    const first = new AgentTaskWindowScope(service);
    const tab = await first.createTab("https://example.com");
    await expect(service.assertWindowTab(tab.id!)).rejects.toMatchObject({ code: "TAB_BUSY" });
    await first.close();
    expect(await service.listSessions()).toEqual([]);
    const next = new AgentTaskWindowScope(service);
    await expect(next.assertWindowTab(tab.id!)).resolves.toEqual(tab);
    await next.close();
  });

  it("任务会话保存可读标签并在列表中返回", async () => {
    await service.designate(7);
    const { sessionId } = await service.openSession(undefined, "  claude: fix login  ");
    const unnamed = (await service.openSession()).sessionId;
    const sessions = await service.listSessions();
    expect(sessions.find((item) => item.sessionId === sessionId)?.label).toBe("claude: fix login");
    expect(sessions.find((item) => item.sessionId === unnamed)?.label).toBeUndefined();
    await service.openSession(undefined, "x".repeat(200));
    expect((await service.listSessions()).at(-1)?.label).toHaveLength(60);
  });

  it("任务列表按当前 URL 返回所持标签的来源且不泄露路径", async () => {
    const sessionId = await prepare();
    const empty = (await service.openSession()).sessionId;
    const web = await service.createTab(sessionId, "https://voice.google.com/u/0/calls?x=1#y");
    const port = await service.createTab(sessionId, "http://localhost:8443/app");
    const blank = await service.createTab(sessionId, "about:blank");
    const internal = await service.createTab(sessionId, "https://example.com");
    const pending = await service.createTab(sessionId, "https://example.org");
    const gone = await service.createTab(sessionId, "https://example.net");
    tabs.get(internal.id!)!.url = "chrome://newtab/";
    Object.assign(tabs.get(pending.id!)!, { url: "", pendingUrl: "https://voice.google.com/u/0/calls" });
    tabs.delete(gone.id!);
    const sessions = await service.listSessions();
    expect(sessions.find((item) => item.sessionId === sessionId)).toMatchObject({
      tabIds: [web.id, port.id, blank.id, internal.id, pending.id, gone.id],
      tabs: [
        { id: web.id, origin: "https://voice.google.com" },
        { id: port.id, origin: "http://localhost:8443" },
        { id: blank.id, origin: null },
        { id: internal.id, origin: null },
        { id: pending.id, origin: "https://voice.google.com" },
        { id: gone.id, origin: null },
      ],
    });
    expect(sessions.find((item) => item.sessionId === empty)).toMatchObject({ tabIds: [], tabs: [] });
  });

  it("关闭标签访问后所有任务都不能操作且释放原有租约", async () => {
    await service.designate(7);
    const sessionId = (await service.openSession()).sessionId;
    const tab = await service.createTab(sessionId, "https://example.com");
    await service.setTabGrant(tab.id!, { mode: "off" });
    await expect(service.assertTabAccess(tab.id!, sessionId)).rejects.toMatchObject({ code: "TAB_ACCESS_DENIED" });
    expect((await service.listSessions())[0].tabIds).toEqual([]);
    expect(await service.listTabs(sessionId)).toEqual([]);
    await expect(service.allowsTabEvent(tab.id!, 7)).resolves.toBe(false);
    await service.setTabGrant(tab.id!, undefined);
    await expect(service.assertTabAccess(tab.id!, sessionId)).resolves.toEqual(tab);
  });

  it("允许所有代理时窗口外个人标签可被任一任务使用并仍保持独占", async () => {
    await service.designate(7);
    const first = (await service.openSession()).sessionId;
    const second = (await service.openSession()).sessionId;
    const personal = mockTab({ id: 1, windowId: 8, url: "https://personal.example" });
    tabs.set(1, personal);
    await expect(service.assertTabAccess(1, first)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await service.setTabGrant(1, { mode: "all" });
    expect(await service.listTabs(second)).toEqual([personal]);
    await expect(service.assertTabAccess(1, first)).resolves.toEqual(personal);
    await expect(service.assertTabAccess(1, second)).rejects.toMatchObject({ code: "TAB_BUSY" });
    expect(await service.listTabs(second)).toEqual([]);
    await expect(service.allowsTabEvent(1, 8)).resolves.toBe(true);
  });

  it("授权给指定任务时其他任务被拒绝且该任务结束后授权失效", async () => {
    await service.designate(7);
    const first = (await service.openSession()).sessionId;
    const second = (await service.openSession()).sessionId;
    const inside = await service.createTab(first, "https://example.com");
    await service.closeSession(first);
    const owner = (await service.openSession()).sessionId;
    tabs.set(1, mockTab({ id: 1, windowId: 8, url: "https://personal.example" }));
    await service.setTabGrant(1, { mode: "session", sessionId: owner });
    await service.setTabGrant(inside.id!, { mode: "session", sessionId: owner });
    await expect(service.assertTabAccess(1, second)).rejects.toMatchObject({ code: "TAB_ACCESS_DENIED" });
    await expect(service.assertTabAccess(inside.id!, second)).rejects.toMatchObject({ code: "TAB_ACCESS_DENIED" });
    expect((await service.listTabs(second)).map((tab) => tab.id)).toEqual([]);
    expect((await service.listTabs(owner)).map((tab) => tab.id).sort()).toEqual([1, inside.id].sort());
    await expect(service.assertTabAccess(1, owner)).resolves.toMatchObject({ id: 1 });
    await service.closeSession(owner);
    await expect(service.assertTabAccess(1, second)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    await expect(service.assertTabAccess(inside.id!, second)).resolves.toEqual(inside);
  });

  it("授权给不存在的任务时应拒绝保存", async () => {
    await service.designate(7);
    await expect(service.setTabGrant(1, { mode: "session", sessionId: "missing" })).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });

  it("标签访问视图返回授权、占用任务与可选任务", async () => {
    await service.designate(7);
    const sessionId = (await service.openSession(undefined, "codex")).sessionId;
    const tab = await service.createTab(sessionId, "https://example.com");
    const view = await service.tabAccess(tab.id!);
    expect(view).toMatchObject({
      tabId: tab.id,
      inAgentWindow: true,
      owner: { sessionId, label: "codex", paused: false },
    });
    expect(view.sessions.map((item) => item.sessionId)).toEqual([sessionId]);
    expect(view.grant).toBeUndefined();
    await service.releaseTab(tab.id!);
    expect((await service.tabAccess(tab.id!)).owner).toBeUndefined();
  });

  it("人工切换器视图标出标记、工作标签与获授权的个人标签", async () => {
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    tabs.set(3, mockTab({ id: 3, windowId: 8 }));
    tabs.set(4, mockTab({ id: 4, windowId: 8 }));
    tabs.set(5, mockTab({ id: 5, windowId: 7 }));
    const { markerTabId } = await service.designate(7);
    const sessionId = (await service.openSession(undefined, "codex")).sessionId;
    const owned = await service.createTab(sessionId, "https://example.com");
    await service.pauseSession(sessionId);
    await service.setTabGrant(3, { mode: "all" });
    await service.setTabGrant(5, { mode: "off" });
    const views = await service.agentTabs([...tabs.values()]);
    expect(Object.fromEntries(views)).toEqual({
      [markerTabId]: { role: "marker" },
      2: { role: "work" },
      [owned.id!]: { role: "work", label: "codex", paused: true },
      3: { role: "granted" },
    });
  });

  it("浏览器重启后未确认登记前不标出任何标签", async () => {
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    await service.designate(7);
    restartBrowser();
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    expect((await service.agentTabs([...tabs.values()])).size).toBe(0);
  });

  it("标签关闭后清除授权与租约记录", async () => {
    await service.designate(7);
    const sessionId = (await service.openSession()).sessionId;
    const tab = await service.createTab(sessionId, "https://example.com");
    await service.setTabGrant(tab.id!, { mode: "all" });
    await service.forgetTab(tab.id!);
    expect((await service.listSessions())[0].tabIds).toEqual([]);
    expect((await service.tabAccess(tab.id!)).grant).toBeUndefined();
  });

  it("任务可关闭自己在专用窗口中的工作标签并释放租约", async () => {
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    await expect(service.closeTab(tab.id!, sessionId)).resolves.toMatchObject({ id: tab.id });
    await expect(service.closeTab(2, sessionId)).resolves.toMatchObject({ id: 2 });
    expect(deps.removeTab).toHaveBeenCalledWith(tab.id);
    expect(deps.removeTab).toHaveBeenCalledWith(2);
    expect((await service.listSessions())[0].tabIds).toEqual([]);
  });

  it("任务不能关闭其他任务占用的标签", async () => {
    const first = await prepare();
    const second = (await service.openSession()).sessionId;
    const tab = await service.createTab(first, "https://example.com");
    await expect(service.closeTab(tab.id!, second)).rejects.toMatchObject({ code: "TAB_BUSY" });
    expect(deps.removeTab).not.toHaveBeenCalled();
  });

  it("个人标签即使授权代理使用也不能被代理关闭", async () => {
    const sessionId = await prepare();
    tabs.set(1, mockTab({ id: 1, windowId: 8, url: "https://personal.example" }));
    await service.setTabGrant(1, { mode: "all" });
    await expect(service.assertTabAccess(1, sessionId)).resolves.toMatchObject({ id: 1 });
    await expect(service.closeTab(1, sessionId)).rejects.toMatchObject({ code: "PERSONAL_TAB_DENIED" });
    expect(deps.removeTab).not.toHaveBeenCalled();
  });

  it("代理不能关闭标记标签或在暂停后关闭标签", async () => {
    const sessionId = await prepare();
    const tab = await service.createTab(sessionId, "https://example.com");
    const { markerTabId } = await service.status();
    await expect(service.closeTab(markerTabId, sessionId)).rejects.toMatchObject({ code: "AGENT_MARKER_PROTECTED" });
    await service.pauseSession(sessionId);
    await expect(service.closeTab(tab.id!, sessionId)).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    expect(deps.removeTab).not.toHaveBeenCalled();
  });

  it("人工可关闭任意窗口标签且无需代理窗口", async () => {
    tabs.set(1, mockTab({ id: 1, windowId: 8, url: "https://personal.example" }));
    await expect(service.closeAnyTab(1)).resolves.toMatchObject({ id: 1 });
    expect(deps.removeTab).toHaveBeenCalledWith(1);
  });

  it("人工关闭仍保护代理窗口标记", async () => {
    await service.designate(7);
    const { markerTabId } = await service.status();
    await expect(service.closeAnyTab(markerTabId)).rejects.toMatchObject({ code: "AGENT_MARKER_PROTECTED" });
    expect(deps.removeTab).not.toHaveBeenCalled();
  });

  it("状态变化时通知指示器并给出每个标签的标识", async () => {
    await service.designate(7);
    const changes: Array<Map<number, unknown>> = [];
    service.subscribe((indicators) => changes.push(indicators));
    const sessionId = (await service.openSession(undefined, "claude")).sessionId;
    const tab = await service.createTab(sessionId, "https://example.com");
    tabs.set(1, mockTab({ id: 1, windowId: 8 }));
    await service.setTabGrant(1, { mode: "off" });
    const latest = changes.at(-1)!;
    expect(latest.get(tab.id!)).toMatchObject({ kind: "owned", label: "claude", sessionId, paused: false });
    expect(latest.get(1)).toEqual({ kind: "off" });
    expect(latest.size).toBe(2);
  });
});
