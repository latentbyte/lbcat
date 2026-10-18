import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// mock chrome.debugger 和 chrome.tabs
const mockSendCommand = vi.fn();
const mockAttach = vi.fn().mockResolvedValue(undefined);
const mockDetach = vi.fn().mockResolvedValue(undefined);
const mockTabsGet = vi.fn();
let onDetach: (source: { tabId?: number }) => void = () => {};

const savedChrome = globalThis.chrome;
vi.stubGlobal("chrome", {
  debugger: {
    attach: mockAttach,
    detach: mockDetach,
    sendCommand: mockSendCommand,
    onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    onDetach: { addListener: (listener: typeof onDetach) => (onDetach = listener) },
  },
  tabs: { get: mockTabsGet },
});

import {
  acquireDebugger,
  cdpClick,
  cdpFill,
  cdpScreenshot,
  cdpStartMonitor,
  cdpStopMonitor,
  releaseDebugger,
  withDebugger,
} from "./dom_cdp";

afterAll(() => {
  vi.stubGlobal("chrome", savedChrome);
});

// 构造 sendCommand 的响应映射
function setupClickMocks(hitTestValue: string) {
  mockTabsGet.mockResolvedValue({ url: "https://example.com" });
  mockSendCommand.mockImplementation((_debuggee: unknown, method: string) => {
    switch (method) {
      case "DOM.getDocument":
        return Promise.resolve({ root: { nodeId: 1 } });
      case "DOM.querySelector":
        return Promise.resolve({ nodeId: 2 });
      case "DOM.scrollIntoViewIfNeeded":
        return Promise.resolve({});
      case "DOM.getBoxModel":
        return Promise.resolve({
          model: { content: [100, 100, 200, 100, 200, 200, 100, 200] },
        });
      case "Page.getLayoutMetrics":
        return Promise.resolve({ visualViewport: { pageX: 0, pageY: 0 } });
      case "Runtime.evaluate":
        return Promise.resolve({ result: { value: hitTestValue } });
      case "Input.dispatchMouseEvent":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  });
}

describe("agent_dom_cdp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("模块可正常导入", () => {
    expect(withDebugger).toBeDefined();
    expect(cdpClick).toBeDefined();
    expect(cdpFill).toBeDefined();
    expect(cdpScreenshot).toBeDefined();
  });

  it("cdpClick 在元素未被遮挡时正常点击", async () => {
    setupClickMocks("hit");
    const result = await cdpClick(999, "#btn");
    expect(result.success).toBe(true);
    // 验证 dispatchMouseEvent 被调用（mousePressed + mouseReleased）
    const mouseEvents = mockSendCommand.mock.calls.filter((c: unknown[]) => c[1] === "Input.dispatchMouseEvent");
    expect(mouseEvents).toHaveLength(2);
  }, 1000);

  it("cdpClick 在元素被遮挡时抛出错误", async () => {
    setupClickMocks("blocked_by:div.modal-overlay");
    await expect(cdpClick(999, "#btn")).rejects.toThrow(/Click blocked/);
    // 验证未发送鼠标事件
    const mouseEvents = mockSendCommand.mock.calls.filter((c: unknown[]) => c[1] === "Input.dispatchMouseEvent");
    expect(mouseEvents).toHaveLength(0);
  });

  it("cdpClick 遮挡错误信息包含遮挡元素描述", async () => {
    setupClickMocks("blocked_by:div#overlay.modal");
    await expect(cdpClick(999, "#btn")).rejects.toThrow(/blocked_by:div#overlay\.modal/);
  });

  it("cdpClick 在元素不存在时抛出错误", async () => {
    mockTabsGet.mockResolvedValue({ url: "https://example.com" });
    mockSendCommand.mockImplementation((_debuggee: unknown, method: string) => {
      if (method === "DOM.getDocument") return Promise.resolve({ root: { nodeId: 1 } });
      if (method === "DOM.querySelector") return Promise.resolve({ nodeId: 0 });
      return Promise.resolve({});
    });
    await expect(cdpClick(999, "#nonexistent")).rejects.toThrow(/Element not found/);
  });

  it("同一标签的多个持有者共享一次 attach，最后一个释放时才 detach", async () => {
    await acquireDebugger(31);
    await withDebugger(31, async () => "shot");
    await cdpStartMonitor(31);
    await cdpStopMonitor(31);
    expect(mockAttach).toHaveBeenCalledTimes(1);
    expect(mockDetach).not.toHaveBeenCalled();
    await releaseDebugger(31);
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });

  it("并发获取只 attach 一次，attach 失败后可重新获取", async () => {
    mockAttach.mockRejectedValueOnce(new Error("Cannot access a chrome:// URL"));
    await expect(Promise.all([acquireDebugger(32), acquireDebugger(32)])).rejects.toThrow(/chrome:/);
    expect(mockAttach).toHaveBeenCalledTimes(1);
    await acquireDebugger(32);
    expect(mockAttach).toHaveBeenCalledTimes(2);
    await releaseDebugger(32);
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });

  it("浏览器终止调试会话后重新 attach", async () => {
    await acquireDebugger(33);
    onDetach({ tabId: 33 });
    await withDebugger(33, async () => "shot");
    expect(mockAttach).toHaveBeenCalledTimes(2);
    expect(mockDetach).toHaveBeenCalledTimes(1);
  });
});
