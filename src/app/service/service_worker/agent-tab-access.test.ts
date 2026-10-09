import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  subscribe: vi.fn(),
  currentIndicators: vi.fn(async () => new Map()),
  forgetTab: vi.fn(async () => {}),
  setTabGrant: vi.fn(async () => {}),
  releaseTab: vi.fn(async () => {}),
  pauseSession: vi.fn(async () => {}),
  resumeSession: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  tabAccess: vi.fn(async (tabId: number) => ({ tabId, inAgentWindow: false, sessions: [] })),
}));

const notes = vi.hoisted(() => ({
  subscribe: vi.fn(),
  list: vi.fn(async (_filter: { url?: string; status?: string }) => [] as Array<{ id: string; url: string }>),
  acknowledge: vi.fn(async () => {}),
  reply: vi.fn(async () => {}),
  resolve: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));

vi.mock("@App/pkg/browser-control/agent-window", () => ({ agentWindowService: service }));
vi.mock("@App/pkg/browser-control/agent-notes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  agentNotesService: notes,
}));

import { agentTabIndicators, initAgentTabAccess } from "./agent-tab-access";

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => unknown;

describe("代理标签访问消息", () => {
  let listener: Listener;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "ext",
        getURL: (path: string) => `chrome-extension://ext/${path}`,
        onMessage: { addListener: (fn: Listener) => (listener = fn) },
      },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
      tabs: {
        query: vi.fn(async () => [
          { id: 1, url: "https://example.com/pay#card" },
          { id: 2, url: "https://example.com/other" },
        ]),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
    });
    initAgentTabAccess();
  });

  it("页面内停止按钮只关闭发送消息的标签", () => {
    listener({ type: "browserControl.STOP_TAB", tabId: 99 }, { id: "ext", tab: { id: 5 } as chrome.tabs.Tab }, vi.fn());
    expect(service.setTabGrant).toHaveBeenCalledWith(5, { mode: "off" });
    listener({ type: "browserControl.STOP_TAB" }, { id: "other", tab: { id: 6 } as chrome.tabs.Tab }, vi.fn());
    expect(service.setTabGrant).toHaveBeenCalledTimes(1);
  });

  it("授权请求只接受扩展页面并返回最新访问视图", async () => {
    const grant = { type: "browserControl.TAB_ACCESS", action: "grant", tabId: 3, grant: { mode: "all" } };
    expect(listener(grant, { id: "ext", url: "https://example.com/" }, vi.fn())).toBeUndefined();
    expect(service.setTabGrant).not.toHaveBeenCalled();

    const respond = vi.fn();
    expect(listener(grant, { id: "ext", url: "chrome-extension://ext/src/popup.html" }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(service.setTabGrant).toHaveBeenCalledWith(3, { mode: "all" });
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { tabId: 3, inAgentWindow: false, sessions: [] } });
  });

  it("操作失败时返回错误信息", async () => {
    service.pauseSession.mockRejectedValueOnce(new Error("Browser task session expired"));
    const respond = vi.fn();
    listener(
      { type: "browserControl.TAB_ACCESS", action: "pause", tabId: 3, sessionId: "s" },
      { id: "ext", url: "chrome-extension://ext/src/popup.html" },
      respond
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false, error: "Browser task session expired" }));
  });

  it("人工处理便签只接受扩展页面并返回当前页面的便签", async () => {
    const reply = {
      type: "browserControl.NOTES",
      action: "reply",
      url: "https://example.com/pay",
      id: "n1",
      text: "ok",
    };
    expect(listener(reply, { id: "ext", url: "https://example.com/" }, vi.fn())).toBeUndefined();
    expect(notes.reply).not.toHaveBeenCalled();

    notes.list.mockResolvedValueOnce([{ id: "n1", url: "https://example.com/pay" }]);
    const respond = vi.fn();
    expect(listener(reply, { id: "ext", url: "chrome-extension://ext/src/popup.html" }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(notes.reply).toHaveBeenCalledWith("n1", "ok");
    expect(notes.list).toHaveBeenCalledWith({ url: "https://example.com/pay" });
    expect(respond).toHaveBeenCalledWith({ ok: true, data: [{ id: "n1", url: "https://example.com/pay" }] });
  });

  it("按标签网址统计未读便签显示在徽标上", async () => {
    const setNotes = vi.spyOn(agentTabIndicators, "setNotes");
    notes.list.mockResolvedValueOnce([
      { id: "a", url: "https://example.com/pay" },
      { id: "b", url: "https://example.com/pay" },
    ]);
    const [onChange] = notes.subscribe.mock.calls.at(-1) as unknown as [() => void];
    onChange();
    await vi.waitFor(() => expect(setNotes).toHaveBeenLastCalledWith(new Map([[1, 2]])));
    expect(notes.list).toHaveBeenLastCalledWith({ status: "open" });
  });
});
