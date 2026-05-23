export const BROWSER_CONTROL_IDENTITY_OVERRIDE_KEY = "browserControl.identityOverride";

export type BrowserControlIdentity = {
  browserName: string;
  appName: string;
};

export type BrowserControlIdentityOverride = Partial<BrowserControlIdentity>;

export function browserIdentityFromUserAgent(userAgent = navigator.userAgent): BrowserControlIdentity {
  if (userAgent.includes("Edg/")) return { browserName: "edge", appName: "Microsoft Edge" };
  if (userAgent.includes("Firefox/")) return { browserName: "firefox", appName: "Firefox" };
  if (userAgent.includes("OPR/") || userAgent.includes("Opera/")) return { browserName: "opera", appName: "Opera" };
  if (userAgent.includes("Vivaldi/")) return { browserName: "vivaldi", appName: "Vivaldi" };
  if (userAgent.includes("Chromium/")) return { browserName: "chromium", appName: "Chromium" };
  if (userAgent.includes("Chrome/")) return { browserName: "chrome", appName: "Google Chrome" };
  return { browserName: "unknown", appName: "Unknown Browser" };
}

function cleanIdentityOverride(value: unknown): BrowserControlIdentityOverride {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const browserName = typeof raw.browserName === "string" ? raw.browserName.trim() : "";
  const appName = typeof raw.appName === "string" ? raw.appName.trim() : "";
  return {
    ...(browserName ? { browserName } : {}),
    ...(appName ? { appName } : {}),
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
  return {
    browserName: override.browserName || detected.browserName,
    appName: override.appName || detected.appName,
  };
}
