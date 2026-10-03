import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserIdentityFromUserAgent,
  focusNativeTab,
  limitNativeResponse,
  normalizeNativeTabEvent,
  tabToBrowserControlTab,
} from "./native-messaging";

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
