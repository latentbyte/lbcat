import { describe, expect, it, vi } from "vitest";
import { AgentTaskWindowScope, AgentWindowService } from "@App/pkg/browser-control/agent-window";
import type { MessageSend } from "@Packages/message/types";
import { SessionToolRegistry } from "../session_tool_registry";
import { ToolRegistry } from "../tool_registry";
import { createBrowserTaskTools } from "./browser_task_tools";

function tab(properties: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
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

const sender: MessageSend = {
  connect: async () => {
    throw new Error("unused");
  },
  sendMessage: async () => {
    throw new Error("unused");
  },
};

describe("请求浏览器工具共享租约", () => {
  it("打开标签后页面脚本应使用同一任务租约，其他请求等待释放", async () => {
    let stored: unknown;
    let nextId = 1;
    const tabs = new Map<number, chrome.tabs.Tab>();
    const getTab = async (id: number) => {
      const value = tabs.get(id);
      if (!value) throw new Error("missing tab");
      return value;
    };
    const service = new AgentWindowService({
      load: async () => stored,
      save: async (value) => {
        stored = structuredClone(value);
      },
      markerUrl: () => "chrome-extension://test/marker",
      id: () => String(nextId++),
      now: () => 1000,
      getTab,
      listTabs: async (windowId) => [...tabs.values()].filter((item) => item.windowId === windowId),
      createTab: async (properties) => {
        const value = tab({
          id: nextId++,
          windowId: properties.windowId,
          url: properties.url,
          active: properties.active,
        });
        tabs.set(value.id!, value);
        return value;
      },
      getWindow: async (id) => ({ id, focused: false, alwaysOnTop: false, incognito: false, type: "normal" }),
      listWindows: async () => [],
      createWindow: async () => undefined,
      allTabs: async () => [...tabs.values()],
      removeTab: async (id) => {
        tabs.delete(id);
      },
    });
    await service.designate(7);
    vi.stubGlobal("chrome", {
      ...chrome,
      tabs: { ...chrome.tabs, get: getTab },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: 42 }]) },
    });
    const registry = new ToolRegistry();
    registry.registerSessionBuiltinFactory("browser", () =>
      createBrowserTaskTools({
        sender,
        summarize: async (content) => content,
        executeInSandbox: async () => null,
        windowScope: new AgentTaskWindowScope(service),
      })
    );
    const first = new SessionToolRegistry(registry);
    const next = new SessionToolRegistry(registry);
    try {
      const created = await first.execute([
        { id: "open", name: "open_tab", arguments: '{"url":"https://example.com"}' },
      ]);
      const tabId: number = JSON.parse(created[0].result).id;
      const pageCall = [
        {
          id: "script",
          name: "execute_script",
          arguments: JSON.stringify({ target: "page", tab_id: tabId, code: "return 42" }),
        },
      ];
      expect(JSON.parse((await first.execute(pageCall))[0].result)).toEqual({
        result: 42,
        target: "page",
        tab_id: tabId,
      });
      expect(JSON.parse((await next.execute(pageCall))[0].result).error).toContain("another browser task");
      await first.close();
      expect(JSON.parse((await next.execute(pageCall))[0].result).result).toBe(42);
      await next.close();
      expect(await service.listSessions()).toEqual([]);
    } finally {
      await first.close();
      await next.close();
      vi.unstubAllGlobals();
    }
  });
});
