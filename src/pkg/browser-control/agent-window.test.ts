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
    const first = await prepare();
    const second = (await service.openSession()).sessionId;
    tabs.set(1, mockTab({ id: 1, windowId: 7 }));
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
    await service.designate(7);
    const sessionId = (await service.openSession(1000)).sessionId;
    tabs.set(1, mockTab({ id: 1, windowId: 7 }));
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
    const first = await prepare();
    const second = (await service.openSession()).sessionId;
    const tab = await service.createTab(first, "https://example.com");
    tabs.set(1, mockTab({ id: 1, windowId: 8 }));
    tabs.set(2, mockTab({ id: 2, windowId: 7 }));
    await expect(service.listTabs(second)).resolves.toEqual([mockTab({ id: 2, windowId: 7 })]);
    await expect(service.listTabs(first)).resolves.toEqual([tab, mockTab({ id: 2, windowId: 7 })]);
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
