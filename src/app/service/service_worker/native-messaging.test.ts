import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserIdentityFromUserAgent, focusNativeTab, tabToBrowserControlTab } from "./native-messaging";

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
