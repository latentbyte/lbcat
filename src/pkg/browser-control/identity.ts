export const BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY = "browserControl.identityOverride";

export type BrowserControlIdentity = {
  browserName: string;
  appName: string;
};

export type BrowserControlIdentityOverride = Partial<Pick<BrowserControlIdentity, "browserName">>;

export function browserAppNameFromBrowserName(browserName: string): string {
  switch (browserName.toLowerCase()) {
    case "chrome":
      return "Google Chrome";
    case "chromium":
      return "Chromium";
    case "firefox":
      return "Firefox";
    case "brave":
      return "Brave Browser";
    case "edge":
      return "Microsoft Edge";
    case "opera":
      return "Opera";
    case "vivaldi":
      return "Vivaldi";
    case "zen":
      return "Zen";
    case "waterfox":
      return "Waterfox";
    case "librewolf":
      return "LibreWolf";
    case "floorp":
      return "Floorp";
    case "unknown":
      return "Unknown Browser";
    default:
      return browserName;
  }
}

export function browserIdentityFromUserAgent(userAgent = navigator.userAgent): BrowserControlIdentity {
  if (userAgent.includes("Edg/")) return { browserName: "edge", appName: browserAppNameFromBrowserName("edge") };
  if (userAgent.includes("Firefox/"))
    return { browserName: "firefox", appName: browserAppNameFromBrowserName("firefox") };
  if (userAgent.includes("OPR/") || userAgent.includes("Opera/")) {
    return { browserName: "opera", appName: browserAppNameFromBrowserName("opera") };
  }
  if (userAgent.includes("Vivaldi/"))
    return { browserName: "vivaldi", appName: browserAppNameFromBrowserName("vivaldi") };
  if (userAgent.includes("Chromium/"))
    return { browserName: "chromium", appName: browserAppNameFromBrowserName("chromium") };
  if (userAgent.includes("Chrome/")) return { browserName: "chrome", appName: browserAppNameFromBrowserName("chrome") };
  return { browserName: "unknown", appName: browserAppNameFromBrowserName("unknown") };
}

function cleanIdentityOverride(value: unknown): BrowserControlIdentityOverride {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const browserName = typeof raw.browserName === "string" ? raw.browserName.trim() : "";
  return {
    ...(browserName ? { browserName } : {}),
  };
}

function storageLocal(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

export async function getBrowserControlIdentityOverride(): Promise<BrowserControlIdentityOverride> {
  const storage = storageLocal();
  if (!storage) return {};
  return new Promise((resolve) => {
    storage.get(BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY, (result) => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        console.error("chrome.runtime.lastError in browser-control identity get:", lastError.message);
        resolve({});
        return;
      }
      resolve(cleanIdentityOverride(result?.[BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY]));
    });
  });
}

export async function setBrowserControlIdentityOverride(override: BrowserControlIdentityOverride): Promise<void> {
  const storage = storageLocal();
  if (!storage) return;
  const cleaned = cleanIdentityOverride(override);
  return new Promise((resolve, reject) => {
    storage.set({ [BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY]: cleaned }, () => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function clearBrowserControlIdentityOverride(): Promise<void> {
  const storage = storageLocal();
  if (!storage) return;
  return new Promise((resolve, reject) => {
    storage.remove(BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY, () => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function resolveBrowserControlIdentity(userAgent = navigator.userAgent): Promise<BrowserControlIdentity> {
  const detected = browserIdentityFromUserAgent(userAgent);
  const override = await getBrowserControlIdentityOverride();
  const browserName = override.browserName || detected.browserName;
  return {
    browserName,
    appName: override.browserName ? browserAppNameFromBrowserName(browserName) : detected.appName,
  };
}
