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

vi.mock("@App/pkg/browser-control/agent-window", () => ({ agentWindowService: service }));

import { initAgentTabAccess } from "./agent-tab-access";

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
      tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
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
});
