// native messaging bridge for browser-control
// connects to com.latentbyte.browser_control via chrome.runtime.connectNative and
// dispatches incoming commands to LBCat APIs and browser APIs

import { ScriptDAO, ScriptCodeDAO, SCRIPT_STATUS_ENABLE } from "@App/app/repo/scripts";
import {
  browserIdentityFromUserAgent,
  resolveBrowserControlIdentity,
  type BrowserControlIdentity,
} from "@App/pkg/browser-control/identity";
import { captureNativeTab, withNativeTabOperation, withNativeWindowOperation } from "@App/pkg/browser-control/capture";
import { prepareScriptByCode } from "@App/pkg/utils/script";
import type { ScriptService } from "./script";

export { browserIdentityFromUserAgent } from "@App/pkg/browser-control/identity";

const HOST_NAME = "com.latentbyte.browser_control";
const RECONNECT_DELAY = 5000;
const MAX_NATIVE_MESSAGE_BYTES = 32 * 1024 * 1024;

type NativeResponse = { id: string; type: "response"; payload: Record<string, unknown> };

function nativeMessageSize(message: unknown): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

export function limitNativeResponse(response: NativeResponse, maxBytes = MAX_NATIVE_MESSAGE_BYTES): NativeResponse {
  if (nativeMessageSize(response) <= maxBytes) return response;
  return {
    id: response.id,
    type: "response",
    payload: {
      cmd: "error",
      error: { code: "RESPONSE_TOO_LARGE", message: `response exceeds ${maxBytes} bytes` },
    },
  };
}

type NativeMessagingConnectionState = "connected" | "connecting" | "disconnected" | "error";

export interface NativeMessagingStatus {
  status: NativeMessagingConnectionState;
  hostName: string;
  lastError?: string;
}

const log = {
  info: (...a: unknown[]) => console.info("[native-messaging]", ...a),
  warn: (...a: unknown[]) => console.warn("[native-messaging]", ...a),
  error: (...a: unknown[]) => console.error("[native-messaging]", ...a),
};

let scriptService: ScriptService | null = null;

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = false;
let connectionState: NativeMessagingConnectionState = "disconnected";
let lastConnectionError = "";
let statusListenerRegistered = false;

// active tab event subscriptions keyed by chrome.tabs event name
const tabSubscriptions: Record<string, (...args: unknown[]) => void> = {};

function getActionApi() {
  return chrome.action ?? (chrome as unknown as { browserAction?: typeof chrome.action }).browserAction;
}

function setNativeBadge(state: NativeMessagingConnectionState) {
  const actionApi = getActionApi();
  if (!actionApi) return;

  const badgeByState: Record<NativeMessagingConnectionState, { text: string; color: string; title: string }> = {
    connected: { text: "●", color: "#4CAF50", title: "LBCat Browser Control connected" },
    connecting: { text: "○", color: "#FF9800", title: "LBCat Browser Control connecting" },
    disconnected: { text: "×", color: "#F44336", title: "LBCat Browser Control disconnected" },
    error: { text: "!", color: "#9C27B0", title: "LBCat Browser Control connection error" },
  };
  const badge = badgeByState[state];
  actionApi.setBadgeText({ text: badge.text });
  actionApi.setBadgeBackgroundColor({ color: badge.color });
  actionApi.setTitle({ title: badge.title });
}

function setConnectionState(state: NativeMessagingConnectionState, error = "") {
  connectionState = state;
  lastConnectionError = error;
  setNativeBadge(state);
}

export function getNativeMessagingStatus(): NativeMessagingStatus {
  return {
    status: connectionState,
    hostName: HOST_NAME,
    lastError: lastConnectionError || undefined,
  };
}

function registerStatusListener() {
  if (statusListenerRegistered) return;
  statusListenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if ((message as { type?: string } | null)?.type !== "nativeMessaging.GET_STATUS") return undefined;
    sendResponse(getNativeMessagingStatus());
    return true;
  });
}

function sendEvent(payload: unknown) {
  if (!port) return;
  try {
    const event = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "event",
      payload,
    };
    if (nativeMessageSize(event) > MAX_NATIVE_MESSAGE_BYTES) {
      log.warn("native event exceeds size limit");
      return;
    }
    port.postMessage(event);
  } catch (e: unknown) {
    if (process.env.DEBUG) {
      log.warn("sendEvent failed", String(e));
    }
  }
}

function tabEventHandler(eventName: string) {
  return (...eventArgs: unknown[]) => {
    void normalizeNativeTabEvent(eventName, eventArgs)
      .then((event) => {
        if (event) sendEvent({ cmd: "tabs.event", data: event });
      })
      .catch((err: unknown) => log.warn("tab event normalization failed", String(err)));
  };
}

function clearTabSubscriptions() {
  for (const name of Object.keys(tabSubscriptions)) {
    const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
    const event = tabsObj[name];
    if (event) {
      event.removeListener(tabSubscriptions[name]);
    }
    delete tabSubscriptions[name];
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

type HandlerResult = { data: unknown };
type Handler = (args: Record<string, unknown>) => HandlerResult | Promise<HandlerResult>;
type NativeExecutionResult = { success: true; value: unknown } | { success: false; error: string };

type TabRemoveInfo = {
  windowId?: number;
};

type TabActiveInfo = {
  tabId: number;
  windowId: number;
};

export type BrowserControlSharingState = {
  camera: boolean;
  microphone: boolean;
  screen?: string;
};

type BrowserTab = chrome.tabs.Tab & {
  sharingState?: BrowserControlSharingState;
};

export type BrowserControlTab = {
  browserId: string;
  browserName: string;
  appName: string;
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  incognito: boolean;
  audible: boolean;
  sharingState?: BrowserControlSharingState;
};

export type BrowserControlTabID = {
  browser: string;
  windowId: number;
  tabId: number;
};

export type BrowserControlEvent = {
  type: "tab-focused" | "tab-removed" | "tab-updated" | "tab-created";
  browserId: string;
  tab?: BrowserControlTab;
  tabId?: BrowserControlTabID;
};

export function tabToBrowserControlTab(
  tab: BrowserTab,
  identity: BrowserControlIdentity = browserIdentityFromUserAgent()
): BrowserControlTab {
  return {
    browserId: "",
    browserName: identity.browserName,
    appName: identity.appName,
    id: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
    title: tab.title || "",
    url: tab.url || tab.pendingUrl || "",
    active: Boolean(tab.active),
    incognito: Boolean(tab.incognito),
    audible: Boolean(tab.audible),
    ...(tab.sharingState ? { sharingState: { ...tab.sharingState } } : {}),
  };
}

function tabIDFromTab(tab: BrowserControlTab): BrowserControlTabID {
  return { browser: tab.browserId, windowId: tab.windowId, tabId: tab.id };
}

export async function normalizeNativeTabEvent(
  eventName: string,
  eventArgs: unknown[]
): Promise<BrowserControlEvent | null> {
  if (eventName === "onCreated") {
    const rawTab = eventArgs[0] as chrome.tabs.Tab | undefined;
    if (!rawTab) return null;
    const tab = tabToBrowserControlTab(rawTab, await resolveBrowserControlIdentity());
    return { type: "tab-created", browserId: tab.browserId, tab, tabId: tabIDFromTab(tab) };
  }

  if (eventName === "onRemoved") {
    const tabId = Number(eventArgs[0]);
    const removeInfo = eventArgs[1] as TabRemoveInfo | undefined;
    return {
      type: "tab-removed",
      browserId: "",
      tabId: { browser: "", windowId: removeInfo?.windowId ?? -1, tabId },
    };
  }

  if (eventName === "onUpdated") {
    const tabId = Number(eventArgs[0]);
    const rawTab = eventArgs[2] as chrome.tabs.Tab | undefined;
    if (!rawTab) {
      return { type: "tab-updated", browserId: "", tabId: { browser: "", windowId: -1, tabId } };
    }
    const tab = tabToBrowserControlTab(rawTab, await resolveBrowserControlIdentity());
    return { type: "tab-updated", browserId: tab.browserId, tab, tabId: tabIDFromTab(tab) };
  }

  if (eventName === "onActivated") {
    const activeInfo = eventArgs[0] as TabActiveInfo | undefined;
    if (!activeInfo) return null;
    try {
      const tab = tabToBrowserControlTab(
        await chrome.tabs.get(activeInfo.tabId),
        await resolveBrowserControlIdentity()
      );
      return { type: "tab-focused", browserId: tab.browserId, tab, tabId: tabIDFromTab(tab) };
    } catch {
      return {
        type: "tab-focused",
        browserId: "",
        tabId: { browser: "", windowId: activeInfo.windowId, tabId: activeInfo.tabId },
      };
    }
  }

  return null;
}

export async function focusNativeTab(tabId: number, requestedWindowId?: number) {
  const existing = await chrome.tabs.get(tabId);
  return withNativeWindowOperation(existing.windowId, async () => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = typeof requestedWindowId === "number" ? requestedWindowId : tab?.windowId;
    if (typeof windowId === "number") {
      await chrome.windows.update(windowId, { focused: true });
    }
    return { tabId, windowId };
  });
}

const handlers: Record<string, Handler> = {
  // --- tabs ---

  async "tabs.list"(args) {
    const query = (args?.["query"] as chrome.tabs.QueryInfo) || {};
    const tabs = await chrome.tabs.query(query);
    const identity = await resolveBrowserControlIdentity();
    return { data: tabs.map((tab) => tabToBrowserControlTab(tab, identity)) };
  },

  async "tabs.get"(args) {
    const tab = await chrome.tabs.get(args["tabId"] as number);
    return { data: tabToBrowserControlTab(tab, await resolveBrowserControlIdentity()) };
  },

  async "tabs.create"(args) {
    const url = args["url"] as string | undefined;
    const active = args["active"] !== undefined ? Boolean(args["active"]) : true;
    if (!url) throw new Error("url is required");
    let tab: chrome.tabs.Tab;
    if (active) {
      const window = await chrome.windows.getCurrent();
      const windowId = window.id;
      if (windowId === undefined) throw new Error("browser window unavailable");
      tab = await withNativeWindowOperation(windowId, () => chrome.tabs.create({ url, active, windowId }));
    } else {
      tab = await chrome.tabs.create({ url, active });
    }
    return { data: tabToBrowserControlTab(tab, await resolveBrowserControlIdentity()) };
  },

  async "tabs.focus"(args) {
    const tabId = args["tabId"] as number | undefined;
    const requestedWindowId = args["windowId"] as number | undefined;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    return { data: await focusNativeTab(tabId, requestedWindowId) };
  },

  "tabs.subscribe"(args) {
    const events = (args?.["events"] as string[]) || ["onCreated", "onRemoved", "onUpdated", "onActivated"];
    const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
    for (const name of events) {
      const event = tabsObj[name];
      if (!event || tabSubscriptions[name]) continue;
      const handler = tabEventHandler(name);
      tabSubscriptions[name] = handler;
      event.addListener(handler);
    }
    return { data: { subscribed: Object.keys(tabSubscriptions) } };
  },

  // --- page ---

  async "page.content"(args) {
    const tabId = args["tabId"] as number | undefined;
    const selector = (args["selector"] as string) || "body";
    const format = (args["format"] as string) || "text";
    if (!tabId) throw new Error("tabId is required");
    const results = await withNativeTabOperation(tabId, () =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string, fmt: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          return fmt === "html" ? (el as HTMLElement).innerHTML : (el as HTMLElement).innerText;
        },
        args: [selector, format],
      })
    );
    return { data: results?.[0]?.result ?? null };
  },

  async "page.reload"(args) {
    const tabId = args["tabId"] as number | undefined;
    const bypassCache = Boolean(args["bypassCache"]);
    if (!tabId) throw new Error("tabId is required");
    await withNativeTabOperation(tabId, () => chrome.tabs.reload(tabId, { bypassCache }));
    return { data: { tabId } };
  },

  async "page.exec"(args) {
    const tabId = args["tabId"] as number | undefined;
    const code = args["code"] as string | undefined;
    const timeoutMs = (args["timeoutMs"] as number) || 45000;
    if (!tabId) throw new Error("tabId is required");
    if (!code) throw new Error("code is required");
    const world = (args["world"] as string | undefined) ?? "MAIN";
    if (world !== "MAIN") {
      throw new Error("page.exec supports MAIN only; dynamic evaluation in ISOLATED is blocked by Manifest V3 CSP");
    }
    const expiresAt = Date.now() + timeoutMs;
    const results = await withTimeout(
      withNativeTabOperation(tabId, () => {
        if (Date.now() >= expiresAt) throw new Error(`page.exec timed out after ${timeoutMs}ms`);
        return chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          // eval runs in page context, not extension SW
          func: async (c: string): Promise<NativeExecutionResult> => {
            try {
              return { success: true, value: await eval(c) };
            } catch (error: unknown) {
              return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
          },
          args: [code],
        });
      }),
      timeoutMs,
      "page.exec"
    );
    const injection = results?.[0];
    if (injection && "error" in injection && injection.error) {
      const error = injection.error;
      const message = typeof error === "object" && "message" in error ? String(error.message) : String(error);
      throw new Error(message);
    }
    const result = injection?.result;
    if (!result) throw new Error("page execution produced no result");
    if (!result.success) throw new Error(result.error);
    return { data: { result: result.value ?? null } };
  },

  async "page.screenshot"(args) {
    const tabId = args["tabId"] as number | undefined;
    if (!tabId) throw new Error("tabId is required");
    return {
      data: await captureNativeTab(tabId, {
        selector: args["selector"] as string | undefined,
        format: args["format"] as "png" | "jpeg" | undefined,
        quality: args["quality"] as number | undefined,
        fullPage: Boolean(args["fullPage"]),
      }),
    };
  },

  // --- script ---

  async "script.list"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const scripts = await scriptService.getAllScripts();
    const filter = args?.["filter"] as { enabled?: boolean } | undefined;
    const list =
      filter?.enabled != null ? scripts.filter((s) => (s.status === SCRIPT_STATUS_ENABLE) === filter.enabled) : scripts;
    return {
      data: list.map((s) => ({
        uuid: s.uuid,
        name: s.name,
        namespace: s.namespace || "",
        description: s.metadata.description?.[0] || "",
        version: s.metadata.version?.[0] || "",
        enabled: s.status === SCRIPT_STATUS_ENABLE,
        sort: s.sort,
        type: s.type,
        runAt: s.metadata.runat?.[0] || "",
        createtime: s.createtime,
        updatetime: s.updatetime,
      })),
    };
  },

  async "script.get"(args) {
    const uuid = args["uuid"] as string | undefined;
    if (!uuid) throw new Error("uuid is required");
    const scriptDAO = new ScriptDAO();
    const script = await scriptDAO.get(uuid);
    if (!script) throw new Error(`script not found: ${uuid}`);
    const codeDAO = new ScriptCodeDAO();
    const codeRecord = await codeDAO.get(uuid);
    return {
      data: {
        uuid: script.uuid,
        name: script.name,
        namespace: script.namespace || "",
        description: script.metadata.description?.[0] || "",
        version: script.metadata.version?.[0] || "",
        enabled: script.status === SCRIPT_STATUS_ENABLE,
        sort: script.sort,
        type: script.type,
        metadata: script.metadata,
        code: codeRecord?.code ?? null,
      },
    };
  },

  async "script.create"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const code = args["code"] as string | undefined;
    if (!code) throw new Error("code is required");
    const { script, oldScript } = await prepareScriptByCode(code, "browser-control");
    await scriptService.installScript({ script, code, upsertBy: "user" });
    return { data: { uuid: script.uuid, isNew: !oldScript } };
  },

  async "script.update"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const uuid = args["uuid"] as string | undefined;
    const code = args["code"] as string | undefined;
    if (!uuid) throw new Error("uuid is required");
    if (!code) throw new Error("code is required");
    const scriptDAO = new ScriptDAO();
    const existing = await scriptDAO.get(uuid);
    if (!existing) throw new Error(`script not found: ${uuid}`);
    const { script } = await prepareScriptByCode(code, "browser-control", uuid);
    await scriptService.installScript({ script, code, upsertBy: "user" });
    return { data: { uuid: script.uuid, isNew: false } };
  },

  async "script.delete"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const uuid = args["uuid"] as string | undefined;
    if (!uuid) throw new Error("uuid is required");
    const scriptDAO = new ScriptDAO();
    const script = await scriptDAO.get(uuid);
    if (!script) throw new Error(`script not found: ${uuid}`);
    await scriptService.deleteScript(uuid, "user");
    return { data: { uuid } };
  },

  async "script.toggle"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const uuid = args["uuid"] as string | undefined;
    if (!uuid) throw new Error("uuid is required");
    const scriptDAO = new ScriptDAO();
    const script = await scriptDAO.get(uuid);
    if (!script) throw new Error(`script not found: ${uuid}`);
    const enable = args["enabled"] != null ? Boolean(args["enabled"]) : script.status !== SCRIPT_STATUS_ENABLE;
    await scriptService.enableScript({ uuid, enable });
    return { data: { uuid, enabled: enable } };
  },

  // upsert by @name + @namespace (matches VM push semantics)
  async "script.push"(args) {
    if (!scriptService) throw new Error("scriptService not initialized");
    const code = args["code"] as string | undefined;
    if (!code) throw new Error("code is required");
    // prepareScriptByCode resolves uuid via findByNameAndNamespace when uuid is omitted
    const { script, oldScript } = await prepareScriptByCode(code, "browser-control");
    await scriptService.installScript({ script, code, upsertBy: "user" });
    return { data: { uuid: script.uuid, isNew: !oldScript } };
  },

  // --- utility ---

  ping() {
    return { data: { pong: true } };
  },
};

function connect() {
  if (port) return;
  shouldReconnect = true;
  setConnectionState("connecting");
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("connectNative failed", message);
    setConnectionState("error", message);
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  setConnectionState("connected");
  log.info("connected to " + HOST_NAME);
}

export function disconnect() {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearTabSubscriptions();
  if (port) {
    port.disconnect();
    port = null;
  }
  setConnectionState("disconnected");
}

function scheduleReconnect() {
  if (!shouldReconnect || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

function onDisconnect() {
  const err = chrome.runtime.lastError;
  const message = err?.message || "unknown reason";
  log.warn("disconnected: " + message);
  port = null;
  clearTabSubscriptions();
  setConnectionState(err ? "error" : "disconnected", err?.message || "");
  if (shouldReconnect) scheduleReconnect();
}

interface Envelope {
  id: string;
  type: string;
  payload?: {
    cmd?: string;
    args?: Record<string, unknown>;
  };
}

async function onMessage(envelope: Envelope) {
  if (!envelope || envelope.type !== "request") return;

  const { id, payload } = envelope;
  const cmd = payload?.cmd;
  const handler = cmd ? handlers[cmd] : undefined;

  let response: NativeResponse;
  if (handler) {
    try {
      const result = await handler(payload?.args || {});
      response = { id, type: "response", payload: { cmd, ...result } };
    } catch (err: unknown) {
      response = {
        id,
        type: "response",
        payload: {
          cmd: "error",
          error: { code: "HANDLER_ERROR", message: err instanceof Error ? err.message : String(err) },
        },
      };
    }
  } else {
    response = {
      id,
      type: "response",
      payload: {
        cmd: "error",
        error: { code: "UNKNOWN_COMMAND", message: `unknown command: ${cmd}` },
      },
    };
  }

  if (port) {
    try {
      port.postMessage(limitNativeResponse(response));
    } catch (e: unknown) {
      log.error("postMessage failed", String(e));
    }
  }
}

// connect on load; the shim handles handshake with the daemon
export function initNativeMessaging(svc: ScriptService) {
  scriptService = svc;
  registerStatusListener();
  connect();
}
