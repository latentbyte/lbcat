import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTabTools } from "./tab_tools";

const mockWindowStatus = vi.fn();
const windowScope = {
  status: mockWindowStatus,
  listTabs: async (): Promise<chrome.tabs.Tab[]> => {
    const { windowId, markerTabId } = await mockWindowStatus();
    return (await chrome.tabs.query({ windowId })).filter((tab) => tab.windowId === windowId && tab.id !== markerTabId);
  },
  createTab: async (url: string): Promise<chrome.tabs.Tab> => {
    const { windowId } = await mockWindowStatus();
    return chrome.tabs.create({ url, windowId, active: false });
  },
  assertWindowTab: async (tabId: number): Promise<chrome.tabs.Tab> => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== 1) throw new Error("TAB_OUTSIDE_AGENT_WINDOW");
    if (tabId === 99) throw new Error("AGENT_WINDOW_MARKER_PROTECTED");
    if (tabId === 98) throw new Error("SESSION_REQUIRED");
    return tab;
  },
};

// mock chrome.scripting
const mockExecuteScript = vi.fn();
// mock chrome.tabs
const mockTabsQuery = vi.fn();
const mockTabsCreate = vi.fn();
const mockTabsRemove = vi.fn();
const mockTabsUpdate = vi.fn();
const mockTabsGet = vi.fn();
// mock chrome.windows
const mockWindowsUpdate = vi.fn();
// mock chrome.tabs.onUpdated
const mockOnUpdatedAddListener = vi.fn();
const mockOnUpdatedRemoveListener = vi.fn();

// mock offscreen extractHtmlWithSelectors 的返回值
let mockExtractReturn: string | null = "Extracted content with selectors for testing";
let mockExtractShouldThrow = false;

const mockSender = {
  sendMessage: vi.fn().mockImplementation(() => {
    if (mockExtractShouldThrow) {
      return Promise.reject(new Error("Offscreen unavailable"));
    }
    return Promise.resolve({ data: mockExtractReturn });
  }),
} as any;

const mockSummarize = vi.fn().mockResolvedValue("Summarized content");

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowStatus.mockResolvedValue({ windowId: 1, markerTabId: 99 });
  mockExtractReturn = "Extracted content with selectors for testing";
  mockExtractShouldThrow = false;

  // Default mock for chrome.tabs.get - allows normal test flow
  mockTabsGet.mockResolvedValue({ id: 42, windowId: 1, url: "https://example.com" });

  (chrome as any).scripting = { executeScript: mockExecuteScript };
  (chrome as any).tabs = {
    query: mockTabsQuery,
    create: mockTabsCreate,
    remove: mockTabsRemove,
    update: mockTabsUpdate,
    get: mockTabsGet,
    onUpdated: {
      addListener: mockOnUpdatedAddListener,
      removeListener: mockOnUpdatedRemoveListener,
    },
  };
  (chrome as any).windows = { update: mockWindowsUpdate };
});

function makeTools() {
  return createTabTools({ sender: mockSender, summarize: mockSummarize, windowScope });
}

function getExecutor(name: string) {
  const { tools } = makeTools();
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.executor;
}

describe("createTabTools", () => {
  it("should create 5 tools", () => {
    const { tools } = makeTools();
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain("get_tab_content");
    expect(names).toContain("list_tabs");
    expect(names).toContain("open_tab");
    expect(names).toContain("close_tab");
    expect(names).toContain("activate_tab");
  });
});

describe("get_tab_content", () => {
  it("should throw when tab_id is missing", async () => {
    const executor = getExecutor("get_tab_content");
    await expect(executor.execute({})).rejects.toThrow('缺少必填参数 "tab_id"');
  });

  it("should inject script and return extracted content", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>Hello World</div>", title: "Test", url: "https://example.com" } },
    ]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 42 })) as string;
    const result = JSON.parse(raw);

    expect(result.tab_id).toBe(42);
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Test");
    expect(result.content).toBe("Extracted content with selectors for testing");
    expect(result.truncated).toBe(false);
    expect(mockExecuteScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42 }, world: "MAIN" }));
  });

  it("should handle selector parameter", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>Section</div>", title: "Test", url: "https://example.com" } },
    ]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1, selector: "#main" })) as string;
    const result = JSON.parse(raw);

    expect(result.used_selector).toBe("#main");
    // Verify selector was passed to injected script
    const callArgs = mockExecuteScript.mock.calls[0][0].args[0];
    expect(callArgs.selector).toBe("#main");
  });

  it("should handle element not found", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: null, title: "Test", url: "https://example.com", error: "Element not found: #missing" } },
    ]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1 })) as string;
    const result = JSON.parse(raw);

    expect(result.content).toBe("Element not found: #missing");
  });

  it("should truncate at max_length", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>content</div>", title: "Test", url: "https://example.com" } },
    ]);
    mockExtractReturn = "A".repeat(200);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1, max_length: 50 })) as string;
    const result = JSON.parse(raw);

    expect(result.content.length).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it("should call summarize when prompt is provided", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>Hello</div>", title: "Test", url: "https://example.com" } },
    ]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1, prompt: "What is the price?" })) as string;
    const result = JSON.parse(raw);

    expect(mockSummarize).toHaveBeenCalledWith(expect.any(String), "What is the price?");
    expect(result.content).toBe("Summarized content");
    expect(result.truncated).toBe(false);
  });

  it("should fallback when offscreen extraction throws", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>Fallback text</div>", title: "Test", url: "https://example.com" } },
    ]);
    mockExtractShouldThrow = true;

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1 })) as string;
    const result = JSON.parse(raw);

    // 降级到简单去标签
    expect(result.content).toContain("Fallback text");
  });

  it("should throw when executeScript fails", async () => {
    mockExecuteScript.mockResolvedValue([]);

    const executor = getExecutor("get_tab_content");
    await expect(executor.execute({ tab_id: 1 })).rejects.toThrow("Failed to read tab content");
  });

  it("should fallback to raw HTML when extraction returns short content", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>Hi</div>", title: "Test", url: "https://example.com" } },
    ]);
    mockExtractReturn = "Hi"; // shorter than 20 chars

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1 })) as string;
    const result = JSON.parse(raw);

    // 降级到原始 HTML
    expect(result.content).toBe("<div>Hi</div>");
  });

  it("should return 'No content' when html is null without error", async () => {
    mockExecuteScript.mockResolvedValue([{ result: { html: null, title: "Test", url: "https://example.com" } }]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1 })) as string;
    const result = JSON.parse(raw);

    expect(result.content).toBe("No content");
  });

  it("should propagate summarize errors", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>content</div>", title: "Test", url: "https://example.com" } },
    ]);
    mockSummarize.mockRejectedValue(new Error("No model configured"));

    const executor = getExecutor("get_tab_content");
    await expect(executor.execute({ tab_id: 1, prompt: "summarize" })).rejects.toThrow("No model configured");
  });

  it("should set used_selector to null when no selector provided", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { html: "<div>content</div>", title: "Test", url: "https://example.com" } },
    ]);

    const executor = getExecutor("get_tab_content");
    const raw = (await executor.execute({ tab_id: 1 })) as string;
    const result = JSON.parse(raw);

    expect(result.used_selector).toBeNull();
  });
});

describe("list_tabs", () => {
  it("should return all tabs", async () => {
    mockTabsQuery.mockResolvedValue([
      {
        id: 1,
        url: "https://a.com",
        title: "A",
        active: true,
        windowId: 1,
        index: 0,
        audible: false,
        status: "complete",
      },
      {
        id: 2,
        url: "https://b.com",
        title: "B",
        active: false,
        windowId: 1,
        index: 1,
        audible: true,
        status: "loading",
      },
    ]);

    const executor = getExecutor("list_tabs");
    const raw = (await executor.execute({})) as string;
    const result = JSON.parse(raw);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].audible).toBe(true);
  });

  it("should filter by url_pattern", async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: "https://github.com/repo", title: "GitHub", active: true, windowId: 1, index: 0 },
      { id: 2, url: "https://google.com", title: "Google", active: false, windowId: 1, index: 1 },
    ]);

    const executor = getExecutor("list_tabs");
    const raw = (await executor.execute({ url_pattern: "github" })) as string;
    const result = JSON.parse(raw);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("should filter by title_pattern", async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: "https://a.com", title: "Shopping Cart", active: true, windowId: 1, index: 0 },
      { id: 2, url: "https://b.com", title: "Blog Post", active: false, windowId: 1, index: 1 },
    ]);

    const executor = getExecutor("list_tabs");
    const raw = (await executor.execute({ title_pattern: "shopping" })) as string;
    const result = JSON.parse(raw);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Shopping Cart");
  });

  it("应在代理窗口内应用活动和声音筛选", async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, windowId: 1, active: true, audible: false },
      { id: 2, windowId: 1, active: false, audible: false },
      { id: 3, windowId: 1, active: true, audible: true },
    ]);

    const result = JSON.parse(
      (await getExecutor("list_tabs").execute({ active: true, window_id: 1, audible: false })) as string
    );
    expect(result.map((tab: { id: number }) => tab.id)).toEqual([1]);
    expect(mockTabsQuery).toHaveBeenCalledWith({ windowId: 1 });
  });

  it("should exclude tabs without id", async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, url: "https://a.com", title: "A", active: true, windowId: 1, index: 0 },
      { url: "https://b.com", title: "B", active: false, windowId: 1, index: 1 }, // no id
    ]);

    const executor = getExecutor("list_tabs");
    const raw = (await executor.execute({})) as string;
    const result = JSON.parse(raw);

    expect(result).toHaveLength(1);
  });
});

describe("open_tab", () => {
  it("should throw when url is missing", async () => {
    const executor = getExecutor("open_tab");
    await expect(executor.execute({})).rejects.toThrow('缺少必填参数 "url"');
  });

  it("should create a new tab", async () => {
    mockTabsCreate.mockResolvedValue({
      id: 10,
      url: "https://example.com",
      title: "Example",
      windowId: 1,
      index: 3,
    });

    const executor = getExecutor("open_tab");
    const raw = (await executor.execute({ url: "https://example.com" })) as string;
    const result = JSON.parse(raw);

    expect(result.id).toBe(10);
    expect(result.url).toBe("https://example.com");
    expect(mockTabsCreate).toHaveBeenCalledWith({ url: "https://example.com", active: false, windowId: 1 });
  });

  it("should create background tab when active=false", async () => {
    mockTabsCreate.mockResolvedValue({ id: 11, url: "https://bg.com", title: "", windowId: 1, index: 4 });

    const executor = getExecutor("open_tab");
    await executor.execute({ url: "https://bg.com", active: false, windowId: 1 });

    expect(mockTabsCreate).toHaveBeenCalledWith({ url: "https://bg.com", active: false, windowId: 1 });
  });

  it("应允许显式指定已注册的代理窗口", async () => {
    mockTabsCreate.mockResolvedValue({ id: 12, url: "https://a.com", title: "", windowId: 1, index: 0 });

    const executor = getExecutor("open_tab");
    await executor.execute({ url: "https://a.com", window_id: 1 });

    expect(mockTabsCreate).toHaveBeenCalledWith({ url: "https://a.com", active: false, windowId: 1 });
  });

  it("should use pendingUrl when url is undefined", async () => {
    mockTabsCreate.mockResolvedValue({
      id: 13,
      url: undefined,
      pendingUrl: "https://pending.com",
      title: "",
      windowId: 1,
      index: 0,
    });

    const executor = getExecutor("open_tab");
    const raw = (await executor.execute({ url: "https://pending.com" })) as string;
    const result = JSON.parse(raw);

    expect(result.url).toBe("https://pending.com");
  });
});

describe("close_tab", () => {
  it("should throw when tab_id is missing", async () => {
    const executor = getExecutor("close_tab");
    await expect(executor.execute({})).rejects.toThrow('缺少必填参数 "tab_id"');
  });

  it("should close the tab", async () => {
    mockTabsRemove.mockResolvedValue(undefined);

    const executor = getExecutor("close_tab");
    const raw = (await executor.execute({ tab_id: 5 })) as string;
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.tab_id).toBe(5);
    expect(mockTabsRemove).toHaveBeenCalledWith(5);
  });

  it("should propagate error when tab does not exist", async () => {
    mockTabsRemove.mockRejectedValue(new Error("No tab with id: 999"));

    const executor = getExecutor("close_tab");
    await expect(executor.execute({ tab_id: 999 })).rejects.toThrow("No tab with id: 999");
  });
});

describe("activate_tab", () => {
  it("should throw when tab_id is missing", async () => {
    const executor = getExecutor("activate_tab");
    await expect(executor.execute({})).rejects.toThrow('缺少必填参数 "tab_id"');
  });

  it("应拒绝激活标签而不抢占窗口焦点", async () => {
    await expect(getExecutor("activate_tab").execute({ tab_id: 7 })).rejects.toThrow("FOREGROUND_PERMISSION_REQUIRED");
    expect(mockTabsUpdate).not.toHaveBeenCalled();
    expect(mockWindowsUpdate).not.toHaveBeenCalled();
  });
});

describe("open_tab with tab_id (navigate)", () => {
  it("should navigate and wait for load by default", async () => {
    mockTabsUpdate.mockResolvedValue({ id: 42 });
    mockOnUpdatedAddListener.mockImplementation((listener: (tabId: number, info: { status?: string }) => void) => {
      listener(42, { status: "complete" });
    });
    mockTabsGet.mockResolvedValue({
      id: 42,
      windowId: 1,
      url: "https://new-page.com",
      title: "New Page",
      status: "complete",
    });

    const executor = getExecutor("open_tab");
    const raw = (await executor.execute({ tab_id: 42, url: "https://new-page.com" })) as string;
    const result = JSON.parse(raw);

    expect(result.id).toBe(42);
    expect(result.url).toBe("https://new-page.com");
    expect(result.title).toBe("New Page");
    expect(result.status).toBe("complete");
    expect(mockTabsUpdate).toHaveBeenCalledWith(42, { url: "https://new-page.com" });
    expect(mockOnUpdatedAddListener).toHaveBeenCalled();
    expect(mockOnUpdatedRemoveListener).toHaveBeenCalled();
  });

  it("should skip waiting when wait_until_loaded is false", async () => {
    mockTabsUpdate.mockResolvedValue({ id: 42 });
    mockTabsGet.mockResolvedValue({
      id: 42,
      windowId: 1,
      url: "https://new-page.com",
      title: "",
      status: "loading",
    });

    const executor = getExecutor("open_tab");
    const raw = (await executor.execute({
      tab_id: 42,
      url: "https://new-page.com",
      wait_until_loaded: false,
    })) as string;
    const result = JSON.parse(raw);

    expect(result.status).toBe("loading");
    expect(mockOnUpdatedAddListener).not.toHaveBeenCalled();
  });

  it("should ignore updates from other tabs", async () => {
    mockTabsUpdate.mockResolvedValue({ id: 42 });
    mockOnUpdatedAddListener.mockImplementation((listener: (tabId: number, info: { status?: string }) => void) => {
      listener(99, { status: "complete" }); // 其他 tab
      listener(42, { status: "loading" }); // 目标 tab 还在加载
      listener(42, { status: "complete" }); // 目标 tab 加载完成
    });
    mockTabsGet.mockResolvedValue({
      id: 42,
      windowId: 1,
      url: "https://new-page.com",
      title: "Done",
      status: "complete",
    });

    const executor = getExecutor("open_tab");
    const raw = (await executor.execute({ tab_id: 42, url: "https://new-page.com" })) as string;
    const result = JSON.parse(raw);

    expect(result.title).toBe("Done");
  });
});

describe("标签工具窗口隔离", () => {
  it("应过滤代理窗口标记和个人窗口标签", async () => {
    mockTabsQuery.mockResolvedValue([
      { id: 1, windowId: 1, url: "https://example.com" },
      { id: 2, windowId: 2, url: "https://personal.example.com" },
      { id: 99, windowId: 1, url: "chrome-extension://marker" },
    ]);
    const result = JSON.parse((await getExecutor("list_tabs").execute({})) as string);
    expect(result.map((tab: { id: number }) => tab.id)).toEqual([1]);
    expect(mockTabsQuery).toHaveBeenCalledWith({ windowId: 1 });
  });

  it.each(["list_tabs", "open_tab"])("%s 应拒绝指定个人窗口", async (name) => {
    await expect(getExecutor(name).execute({ url: "https://example.com", window_id: 2 })).rejects.toThrow(
      "TAB_OUTSIDE_AGENT_WINDOW"
    );
    expect(mockTabsQuery).not.toHaveBeenCalled();
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it.each(["get_tab_content", "open_tab", "close_tab"])("%s 应拒绝操作个人窗口标签", async (name) => {
    mockTabsGet.mockResolvedValue({ id: 2, windowId: 2, url: "https://personal.example.com" });
    await expect(
      getExecutor(name).execute({ tab_id: 2, url: "https://example.com", wait_until_loaded: false })
    ).rejects.toThrow("TAB_OUTSIDE_AGENT_WINDOW");
    expect(mockExecuteScript).not.toHaveBeenCalled();
    expect(mockTabsUpdate).not.toHaveBeenCalled();
    expect(mockTabsRemove).not.toHaveBeenCalled();
  });

  it("应在代理窗口缺失时停止创建标签", async () => {
    mockWindowStatus.mockRejectedValue(new Error("AGENT_WINDOW_REQUIRED"));
    await expect(getExecutor("open_tab").execute({ url: "https://example.com" })).rejects.toThrow(
      "AGENT_WINDOW_REQUIRED"
    );
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it("应拒绝通过新建标签请求激活窗口", async () => {
    await expect(getExecutor("open_tab").execute({ url: "https://example.com", active: true })).rejects.toThrow(
      "FOREGROUND_PERMISSION_REQUIRED"
    );
    expect(mockTabsCreate).not.toHaveBeenCalled();
  });

  it("应保护代理窗口标记标签", async () => {
    mockTabsGet.mockResolvedValue({ id: 99, windowId: 1, url: "chrome-extension://marker" });
    await expect(getExecutor("close_tab").execute({ tab_id: 99 })).rejects.toThrow("AGENT_WINDOW_MARKER_PROTECTED");
    expect(mockTabsRemove).not.toHaveBeenCalled();
  });
});
