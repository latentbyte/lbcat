import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserIdentityFromUserAgent,
  focusNativeTab,
  normalizeNativeTabEvent,
  tabToBrowserControlTab,
} from "./native-messaging";

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

describe("native messaging reconnect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reconnects when status is requested after a clean disconnect", async () => {
    vi.resetModules();

    let statusListener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void
        ) => boolean | undefined)
      | undefined;
    let disconnectListener: (() => void) | undefined;

    const makePort = (): chrome.runtime.Port =>
      ({
        name: "browser-control",
        onMessage: { addListener: vi.fn() },
        onDisconnect: {
          addListener: vi.fn((listener: () => void) => {
            disconnectListener = listener;
          }),
        },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }) as unknown as chrome.runtime.Port;

    const ports = [makePort(), makePort()];
    const connectNative = vi.fn(() => ports.shift() as chrome.runtime.Port);

    vi.stubGlobal("chrome", {
      runtime: {
        connectNative,
        lastError: undefined,
        onMessage: {
          addListener: vi.fn((listener: typeof statusListener) => {
            statusListener = listener;
          }),
        },
      },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        setTitle: vi.fn(),
      },
    });

    const { disconnect, initNativeMessaging } = await import("./native-messaging.js");
    initNativeMessaging({} as Parameters<typeof initNativeMessaging>[0]);
    expect(connectNative).toHaveBeenCalledTimes(1);

    disconnectListener?.();
    expect(connectNative).toHaveBeenCalledTimes(1);

    let response: unknown;
    statusListener?.({ type: "nativeMessaging.GET_STATUS" }, {}, (value?: unknown) => {
      response = value;
    });

    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({
      hostName: "com.latentbyte.browser_control",
      status: "connected",
    });

    disconnect();
  });
});

describe("tabToBrowserControlTab", () => {
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
