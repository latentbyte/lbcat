import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY,
  browserAppNameFromBrowserName,
  browserIdentityFromUserAgent,
  getBrowserControlIdentityOverride,
  resolveBrowserControlIdentity,
  setBrowserControlIdentityOverride,
} from "./identity";

function stubStorage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  vi.stubGlobal("chrome", {
    runtime: {},
    storage: {
      local: {
        get: vi.fn((key: string, cb: (result: Record<string, unknown>) => void) => cb({ [key]: values[key] })),
        set: vi.fn((items: Record<string, unknown>, cb: () => void) => {
          Object.assign(values, items);
          cb();
        }),
        remove: vi.fn((key: string, cb: () => void) => {
          delete values[key];
          cb();
        }),
      },
    },
  });
  return values;
}

describe("browser control identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("derives app names from browser names", () => {
    expect(browserAppNameFromBrowserName("zen")).toBe("Zen");
    expect(browserAppNameFromBrowserName("custom-browser")).toBe("custom-browser");
  });

  it("resolves stored browser override before user agent", async () => {
    stubStorage({ [BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY]: { browserName: "zen", appName: "Ignored" } });

    await expect(resolveBrowserControlIdentity("Mozilla/5.0 Firefox/123.0")).resolves.toEqual({
      browserName: "zen",
      appName: "Zen",
    });
  });

  it("cleans empty and legacy app override values when saving", async () => {
    const values = stubStorage();

    await setBrowserControlIdentityOverride({ browserName: " zen " });

    expect(values[BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY]).toEqual({ browserName: "zen" });
    await expect(getBrowserControlIdentityOverride()).resolves.toEqual({ browserName: "zen" });
  });
});
