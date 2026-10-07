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
      pinTab: vi.fn(async () => {}),
    };
    service = new AgentWindowService(deps);
  });

  async function prepare(): Promise<string> {
    await service.designate(7);
    return (await service.openSession()).sessionId;
  }

  it("未登记窗口时应阻止任务而非选择当前窗口", async () => {
    await expect(service.openSession()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
    expect(deps.createTab).not.toHaveBeenCalled();
  });

  it("创建专用窗口时不抢焦点并固定标记标签", async () => {
    const status = await service.create();
    expect(deps.createWindow).toHaveBeenCalledWith(expect.objectContaining({ focused: false, type: "normal" }));
    expect(deps.pinTab).toHaveBeenCalledWith(status.markerTabId);
    await expect(service.status()).resolves.toEqual(status);
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
    expect(deps.pinTab).not.toHaveBeenCalledWith(1);
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
      expect(deps.pinTab).not.toHaveBeenCalled();
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
      expect(deps.pinTab).not.toHaveBeenCalled();
      await service.designate(7);
      await expect(service.status()).resolves.toMatchObject({ windowId: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["window", "url"])("固定标记后 %s 身份变化不得报告创建成功", async (identity) => {
    deps.pinTab = async (id) => {
      if (identity === "window") tabs.get(id)!.windowId = 8;
      else tabs.get(id)!.url = "about:blank";
    };
    await expect(service.create()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
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
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
    tabs.delete(status.markerTabId);
    await expect(service.status()).rejects.toMatchObject({ code: "AGENT_WINDOW_MISSING" });
  });

  it("复用数字标签 ID 但 URL 不匹配时应拒绝", async () => {
    const status = await service.designate(7);
    tabs.get(status.markerTabId)!.url = "https://example.com";
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
});
