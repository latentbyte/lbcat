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
import { agentWindowService, BrowserControlScopeError } from "@App/pkg/browser-control/agent-window";
import { BrowserControlError } from "@App/pkg/browser-control/errors";
import { runPageContent } from "@App/pkg/browser-control/page-content";
import { runPageExec } from "@App/pkg/browser-control/page-exec";
import { runPageFetch, type PageFetchRequest } from "@App/pkg/browser-control/page-fetch";
import { runPageAction, type PageActionRequest, type PageWaitState } from "@App/pkg/browser-control/page-actions";
import {
  navigateTab,
  waitForTabComplete,
  waitForTabUrl,
  type TabWaitMode,
} from "@App/pkg/browser-control/tab-navigation";
import { agentNotesService, type AgentNoteKind, type AgentNoteStatus } from "@App/pkg/browser-control/agent-notes";
import {
  isNativeTabQuarantined,
  startNativeTabOperations,
  stopNativeTabOperations,
} from "@App/pkg/browser-control/tab-operation";
import { agentTabIndicators } from "./agent-tab-access";
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
  try {
    if (nativeMessageSize(response) <= maxBytes) return response;
  } catch (error: unknown) {
    return {
      id: response.id,
      type: "response",
      payload: {
        cmd: "error",
        error: { code: "RESPONSE_NOT_SERIALIZABLE", message: error instanceof Error ? error.message : String(error) },
      },
    };
  }
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

// 按访问入口及浏览器事件名称保存监听器，断线时统一清理
const tabSubscriptions: Record<string, { eventName: string; handler: (...args: unknown[]) => void }> = {};

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
  agentTabIndicators.setDefaults({ text: badge.text, color: badge.color, title: badge.title });
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

function tabEventHandler(eventName: string, switcher: boolean) {
  return (...eventArgs: unknown[]) => {
    void normalizeNativeTabEvent(eventName, eventArgs)
      .then((event) => {
        if (!event) return;
        if (switcher) {
          sendEvent({ cmd: "switcher.tabs.event", data: event });
          return;
        }
        if (!event.tabId) return;
        return agentWindowService
          .allowsTabEvent(event.tabId.tabId, event.tabId.windowId, event.tab?.url)
          .then((allowed) => {
            if (allowed) {
              sendEvent({ cmd: "tabs.event", data: event });
            }
          });
      })
      .catch((err: unknown) => {
        if (!(err instanceof BrowserControlScopeError)) log.warn("tab event normalization failed", String(err));
      });
  };
}

function clearTabSubscriptions() {
  for (const [key, { eventName, handler }] of Object.entries(tabSubscriptions)) {
    const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
    const event = tabsObj[eventName];
    if (event) {
      event.removeListener(handler);
    }
    delete tabSubscriptions[key];
  }
}

function subscribeNativeTabs(args: Record<string, unknown>, switcher: boolean): HandlerResult {
  const events = (args.events as string[]) || ["onCreated", "onRemoved", "onUpdated", "onActivated"];
  const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
  const prefix = switcher ? "switcher.tabs" : "tabs";
  for (const name of events) {
    const event = tabsObj[name];
    const key = `${prefix}:${name}`;
    if (!event || tabSubscriptions[key]) continue;
    const handler = tabEventHandler(name, switcher);
    tabSubscriptions[key] = { eventName: name, handler };
    event.addListener(handler);
  }
  return {
    data: {
      subscribed: Object.entries(tabSubscriptions)
        .filter(([key]) => key.startsWith(`${prefix}:`))
        .map(([, subscription]) => subscription.eventName),
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

type HandlerResult = { data: unknown };
type Handler = (args: Record<string, unknown>) => HandlerResult | Promise<HandlerResult>;

function sessionId(args: Record<string, unknown>): string | undefined {
  return typeof args.sessionId === "string" ? args.sessionId : undefined;
}

async function assertNativeTab(args: Record<string, unknown>, tabId: number): Promise<chrome.tabs.Tab> {
  return agentWindowService.assertTabAccess(
    tabId,
    sessionId(args),
    typeof args.personalTabId === "number" ? args.personalTabId : undefined
  );
}
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
  status?: string;
  favIconUrl?: string;
  sharingState?: BrowserControlSharingState;
};

// inline data: favicons ride along with every tab list; drop outliers so one
// huge icon cannot bloat native messages
const MAX_FAVICON_URL_LENGTH = 64 * 1024;

function publicFavIconUrl(url: string | undefined): string | undefined {
  if (!url || url.length > MAX_FAVICON_URL_LENGTH) return undefined;
  return url;
}

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
    ...(tab.status ? { status: tab.status } : {}),
    ...(publicFavIconUrl(tab.favIconUrl) ? { favIconUrl: tab.favIconUrl } : {}),
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

export async function focusNativeTab(tabId: number, requestedWindowId?: number, validateAccess?: () => Promise<void>) {
  const existing = await chrome.tabs.get(tabId);
  return withNativeWindowOperation(existing.windowId, async () => {
    await validateAccess?.();
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = typeof requestedWindowId === "number" ? requestedWindowId : tab?.windowId;
    if (typeof windowId === "number") {
      await chrome.windows.update(windowId, { focused: true });
    }
    return { tabId, windowId };
  });
}

const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_SETTLE_MS = 300;
// 注入失败多因导航中文档被替换，等待期间短暂重试
const WAIT_RETRY_MS = 100;

function waitMode(args: Record<string, unknown>): TabWaitMode {
  return args.wait === "load" ? "load" : "none";
}

function timeoutArg(args: Record<string, unknown>, fallback: number): number {
  return typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : fallback;
}

function locatorArgs(args: Record<string, unknown>) {
  return {
    ...(typeof args.selector === "string" && args.selector ? { selector: args.selector } : {}),
    ...(typeof args.text === "string" && args.text ? { text: args.text } : {}),
    ...(typeof args.ref === "string" && args.ref ? { ref: args.ref } : {}),
    ...(typeof args.nth === "number" && args.nth > 0 ? { nth: args.nth } : {}),
  };
}

async function injectPageAction(tabId: number, request: PageActionRequest) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: runPageAction, args: [request] });
  const injection = results?.[0];
  if (injection && "error" in injection && injection.error) {
    const error = injection.error;
    throw new Error(typeof error === "object" && "message" in error ? String(error.message) : String(error));
  }
  const result = injection?.result;
  if (!result) throw new Error("page action produced no result");
  if (!result.success) throw new BrowserControlError(result.code, result.error);
  return result.value;
}

// 动作可能触发导航：在同一标签队列内执行并观察导航，返回动作结果与最终页面
async function nativePageAction(args: Record<string, unknown>, request: PageActionRequest) {
  const tabId = args.tabId;
  if (typeof tabId !== "number") throw new Error("tabId is required");
  return withNativeTabOperation(tabId, async () => {
    await assertNativeTab(args, tabId);
    let value: Awaited<ReturnType<typeof injectPageAction>> | undefined;
    const { navigated, tab } = await navigateTab(
      tabId,
      async () => {
        value = await injectPageAction(tabId, request);
      },
      {
        wait: waitMode(args),
        timeoutMs: timeoutArg(args, DEFAULT_LOAD_TIMEOUT_MS),
        settleMs: typeof args.settleMs === "number" ? args.settleMs : DEFAULT_ACTION_SETTLE_MS,
      }
    );
    return { data: { ...value, navigated, url: tab.url || tab.pendingUrl || "", title: tab.title || "" } };
  });
}

async function nativeNavigate(args: Record<string, unknown>, trigger: (tabId: number) => Promise<unknown>) {
  const tabId = args.tabId;
  if (typeof tabId !== "number") throw new Error("tabId is required");
  return withNativeTabOperation(tabId, async () => {
    await assertNativeTab(args, tabId);
    const { navigated, tab } = await navigateTab(tabId, () => trigger(tabId), {
      wait: waitMode(args),
      timeoutMs: timeoutArg(args, DEFAULT_LOAD_TIMEOUT_MS),
    });
    return {
      data: { tabId, navigated, url: tab.url || tab.pendingUrl || "", title: tab.title || "", status: tab.status },
    };
  });
}

const handlers: Record<string, Handler> = {
  async "agentWindow.list"() {
    return { data: await agentWindowService.listWindows() };
  },
  async "agentWindow.create"() {
    return { data: await agentWindowService.create() };
  },
  async "agentWindow.designate"(args) {
    if (typeof args.windowId !== "number") throw new Error("windowId is required");
    return { data: await agentWindowService.designate(args.windowId) };
  },
  async "agentWindow.status"() {
    const scope = await agentWindowService.status();
    const manifest = chrome.runtime.getManifest();
    return { data: { ...scope, extensionVersion: manifest.version, manifestVersion: manifest.manifest_version } };
  },
  async "agentWindow.clear"() {
    await agentWindowService.clear();
    return { data: { cleared: true } };
  },
  async "sessions.open"(args) {
    return {
      data: await agentWindowService.openSession(
        typeof args.ttlMs === "number" ? args.ttlMs : undefined,
        typeof args.label === "string" ? args.label : undefined
      ),
    };
  },
  async "sessions.list"() {
    return { data: await agentWindowService.listSessions() };
  },
  async "sessions.renew"(args) {
    return { data: await agentWindowService.renewSession(sessionId(args) ?? "") };
  },
  async "sessions.close"(args) {
    const tabs = await agentWindowService.closeSession(sessionId(args) ?? "", { closeTabs: Boolean(args.closeTabs) });
    return { data: { closed: true, ...(args.closeTabs ? tabs : {}) } };
  },
  async "sessions.pause"(args) {
    await agentWindowService.pauseSession(sessionId(args) ?? "");
    return { data: { paused: true } };
  },
  async "sessions.resume"(args) {
    await agentWindowService.resumeSession(sessionId(args) ?? "");
    return { data: { paused: false } };
  },
  async "sessions.claim"(args) {
    if (typeof args.tabId !== "number") throw new Error("tabId is required");
    return {
      data: tabToBrowserControlTab(await assertNativeTab(args, args.tabId), await resolveBrowserControlIdentity()),
    };
  },
  // --- notes ---

  async "notes.add"(args) {
    if (typeof args.tabId !== "number") throw new Error("tabId is required");
    const tab = await assertNativeTab(args, args.tabId);
    const { owner } = await agentWindowService.tabAccess(args.tabId);
    return {
      data: await agentNotesService.add({
        url: tab.url || tab.pendingUrl || "",
        title: tab.title,
        sessionId: sessionId(args) ?? "",
        label: owner?.label,
        kind: args.kind as AgentNoteKind,
        text: args.text as string,
      }),
    };
  },
  async "notes.list"(args) {
    return {
      data: await agentNotesService.list({
        sessionId: sessionId(args),
        status: typeof args.status === "string" ? (args.status as AgentNoteStatus) : undefined,
      }),
    };
  },
  async "notes.get"(args) {
    return { data: await agentNotesService.get(String(args.id ?? "")) };
  },
  async "notes.resolve"(args) {
    return { data: await agentNotesService.resolve(String(args.id ?? "")) };
  },

  // --- tabs ---

  async "tabs.list"(args) {
    const tabs = await agentWindowService.listTabs(sessionId(args));
    const identity = await resolveBrowserControlIdentity();
    return { data: tabs.map((tab) => tabToBrowserControlTab(tab, identity)) };
  },

  async "tabs.get"(args) {
    const tab = await assertNativeTab(args, args["tabId"] as number);
    return { data: tabToBrowserControlTab(tab, await resolveBrowserControlIdentity()) };
  },

  async "tabs.create"(args) {
    const url = args["url"] as string | undefined;
    const active = Boolean(args["active"]);
    if (!url) throw new Error("url is required");
    if (active && !args.allowFocus)
      throw new BrowserControlScopeError(
        "FOREGROUND_PERMISSION_REQUIRED",
        "Foreground tab creation requires explicit permission"
      );
    let tab = await agentWindowService.createTab(sessionId(args), url);
    if (active && tab.id !== undefined) {
      const tabId = tab.id;
      await focusNativeTab(tabId, undefined, async () => {
        await assertNativeTab(args, tabId);
      });
    }
    if (waitMode(args) === "load" && tab.id !== undefined)
      tab = await waitForTabComplete(tab.id, timeoutArg(args, DEFAULT_LOAD_TIMEOUT_MS));
    return { data: tabToBrowserControlTab(tab, await resolveBrowserControlIdentity()) };
  },

  async "tabs.focus"(args) {
    const tabId = args["tabId"] as number | undefined;
    const requestedWindowId = args["windowId"] as number | undefined;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    if (!args.allowFocus)
      throw new BrowserControlScopeError(
        "FOREGROUND_PERMISSION_REQUIRED",
        "Focusing a browser window requires explicit permission"
      );
    const tab = await assertNativeTab(args, tabId);
    if (requestedWindowId !== undefined && requestedWindowId !== tab.windowId)
      throw new Error("windowId does not match target tab");
    return {
      data: await focusNativeTab(tabId, requestedWindowId, async () => {
        await assertNativeTab(args, tabId);
      }),
    };
  },

  async "tabs.close"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    await agentWindowService.closeTab(tabId, sessionId(args));
    return { data: { tabId, closed: true } };
  },

  "tabs.subscribe"(args) {
    return subscribeNativeTabs(args, false);
  },

  // 人工切换器仅提供标签元数据、聚焦、关闭及事件，不授予页面操作权限
  async "switcher.tabs.list"() {
    const tabs = await chrome.tabs.query({});
    const identity = await resolveBrowserControlIdentity();
    return { data: tabs.map((tab) => tabToBrowserControlTab(tab, identity)) };
  },

  async "switcher.tabs.focus"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) throw new Error("tabId is required");
    const tab = await chrome.tabs.get(tabId);
    if (args.windowId !== undefined && args.windowId !== tab.windowId)
      throw new Error("windowId does not match target tab");
    return {
      data: await focusNativeTab(tabId, tab.windowId, async () => {
        const current = await chrome.tabs.get(tabId);
        if (current.windowId !== tab.windowId) throw new Error("windowId does not match target tab");
      }),
    };
  },

  async "switcher.tabs.close"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) throw new Error("tabId is required");
    await agentWindowService.closeAnyTab(tabId);
    return { data: { tabId, closed: true } };
  },

  "switcher.tabs.subscribe"(args) {
    return subscribeNativeTabs(args, true);
  },

  // --- page ---

  async "page.content"(args) {
    const tabId = args["tabId"] as number | undefined;
    const selector = (args["selector"] as string) || "body";
    const format = args.format === "html" || args.format === "markdown" ? args.format : "text";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : 0;
    if (!tabId) throw new Error("tabId is required");
    const results = await withNativeTabOperation(tabId, async () => {
      await assertNativeTab(args, tabId);
      return chrome.scripting.executeScript({
        target: { tabId },
        func: runPageContent,
        args: [{ selector, format, maxChars }],
      });
    });
    const injection = results?.[0];
    if (injection && "error" in injection && injection.error) {
      const error = injection.error;
      throw new Error(typeof error === "object" && "message" in error ? String(error.message) : String(error));
    }
    const result = injection?.result;
    if (!result) throw new Error("page content injection produced no result");
    if (!result.success) throw new BrowserControlError(result.code, result.error);
    return { data: result.value };
  },

  async "page.reload"(args) {
    const tabId = args["tabId"] as number | undefined;
    const bypassCache = Boolean(args["bypassCache"]);
    if (!tabId) throw new Error("tabId is required");
    await assertNativeTab(args, tabId);
    // 超时执行仍在运行时队列被隔离，重新加载是恢复手段，不等待加载
    if (isNativeTabQuarantined(tabId)) {
      await chrome.tabs.reload(tabId, { bypassCache });
      return { data: { tabId } };
    }
    return nativeNavigate(args, (id) => chrome.tabs.reload(id, { bypassCache }));
  },

  async "page.goto"(args) {
    const url = args.url;
    if (typeof url !== "string" || !url) throw new Error("url is required");
    return nativeNavigate(args, (id) => chrome.tabs.update(id, { url }));
  },

  async "page.back"(args) {
    return nativeNavigate(args, (id) => chrome.tabs.goBack(id));
  },

  async "page.forward"(args) {
    return nativeNavigate(args, (id) => chrome.tabs.goForward(id));
  },

  async "page.click"(args) {
    return nativePageAction(args, { op: "click", ...locatorArgs(args) });
  },

  async "page.fill"(args) {
    if (typeof args.value !== "string") throw new Error("value is required");
    return nativePageAction(args, { op: "fill", value: args.value, ...locatorArgs(args) });
  },

  async "page.select"(args) {
    if (typeof args.value !== "string") throw new Error("value is required");
    return nativePageAction(args, { op: "select", value: args.value, ...locatorArgs(args) });
  },

  async "page.press"(args) {
    if (typeof args.key !== "string" || !args.key) throw new Error("key is required");
    return nativePageAction(args, { op: "press", key: args.key, ...locatorArgs(args) });
  },

  async "page.fetch"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    if (typeof args.url !== "string" || !args.url) throw new Error("url is required");
    const request: PageFetchRequest = {
      url: args.url,
      timeoutMs: timeoutArg(args, 30_000),
      ...(typeof args.method === "string" && args.method ? { method: args.method.toUpperCase() } : {}),
      ...(args.headers && typeof args.headers === "object" ? { headers: args.headers as Record<string, string> } : {}),
      ...(typeof args.body === "string" ? { body: args.body } : {}),
      ...(typeof args.maxChars === "number" && args.maxChars > 0 ? { maxChars: args.maxChars } : {}),
    };
    const results = await withNativeTabOperation(tabId, async () => {
      await assertNativeTab(args, tabId);
      return chrome.scripting.executeScript({ target: { tabId }, func: runPageFetch, args: [request] });
    });
    const injection = results?.[0];
    if (injection && "error" in injection && injection.error) {
      const error = injection.error;
      throw new Error(typeof error === "object" && "message" in error ? String(error.message) : String(error));
    }
    const result = injection?.result;
    if (!result) throw new Error("page fetch produced no result");
    if (!result.success) throw new BrowserControlError(result.code, result.error);
    return { data: result.value };
  },

  async "page.snapshot"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    const selector = typeof args.selector === "string" && args.selector ? args.selector : undefined;
    const max = typeof args.max === "number" && args.max > 0 ? args.max : 150;
    const value = await withNativeTabOperation(tabId, async () => {
      await assertNativeTab(args, tabId);
      return injectPageAction(tabId, { op: "snapshot", selector, max });
    });
    return { data: value.snapshot };
  },

  // 依次等待加载、地址、元素或文本，共享同一超时
  async "page.wait"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    const timeoutMs = timeoutArg(args, 10_000);
    const expiresAt = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, expiresAt - Date.now());
    const selector = typeof args.selector === "string" && args.selector ? args.selector : undefined;
    const text = typeof args.text === "string" && args.text ? args.text : undefined;
    const urlPattern = typeof args.url === "string" && args.url ? args.url : undefined;
    if (!args.load && !urlPattern && !selector && !text)
      throw new BrowserControlError("INVALID_ARGUMENT", "wait needs --load, --url, --selector, or --text");
    let pattern: RegExp | undefined;
    try {
      pattern = urlPattern ? new RegExp(urlPattern) : undefined;
    } catch (error) {
      throw new BrowserControlError("INVALID_ARGUMENT", `invalid --url pattern: ${(error as Error).message}`);
    }
    await assertNativeTab(args, tabId);
    const startedAt = Date.now();
    if (args.load) await waitForTabComplete(tabId, remaining());
    if (pattern) await waitForTabUrl(tabId, pattern, remaining());
    let matched: unknown;
    if (selector || text) {
      const state: PageWaitState = args.state === "attached" || args.state === "gone" ? args.state : "visible";
      for (;;) {
        try {
          await assertNativeTab(args, tabId);
          matched = (
            await withNativeTabOperation(tabId, () =>
              injectPageAction(tabId, { op: "wait", selector, text, state, timeoutMs: remaining() })
            )
          ).matched;
          break;
        } catch (error) {
          if (error instanceof BrowserControlError || remaining() <= WAIT_RETRY_MS) throw error;
          await new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_MS));
        }
      }
    }
    const tab = await chrome.tabs.get(tabId);
    return {
      data: {
        ...(matched ? { matched } : {}),
        elapsedMs: Date.now() - startedAt,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
      },
    };
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
    let quarantine: (() => void) | undefined;
    const results = await withTimeout(
      withNativeTabOperation(tabId, async (operation) => {
        if (Date.now() >= expiresAt) throw new Error(`page.exec timed out after ${timeoutMs}ms`);
        await assertNativeTab(args, tabId);
        if (Date.now() >= expiresAt) throw new Error(`page.exec timed out after ${timeoutMs}ms`);
        quarantine = operation.quarantine;
        operation.bindToDocument();
        return chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: runPageExec,
          args: [code, typeof args.maxChars === "number" ? args.maxChars : 0],
        });
      }),
      timeoutMs,
      "page.exec",
      () => quarantine?.()
    );
    const injection = results?.[0];
    if (injection && "error" in injection && injection.error) {
      const error = injection.error;
      const message = typeof error === "object" && "message" in error ? String(error.message) : String(error);
      throw new Error(message);
    }
    const result = injection?.result;
    if (!result) throw new Error("page execution produced no result");
    if (!result.success) throw new BrowserControlError(result.code, result.error);
    return {
      data: {
        result: result.value ?? null,
        ...(result.truncated ? { truncated: true, totalLength: result.totalLength } : {}),
      },
    };
  },

  async "page.screenshot"(args) {
    const tabId = args["tabId"] as number | undefined;
    if (!tabId) throw new Error("tabId is required");
    return {
      data: await captureNativeTab(
        tabId,
        {
          selector: args["selector"] as string | undefined,
          format: args["format"] as "png" | "jpeg" | undefined,
          quality: args["quality"] as number | undefined,
          fullPage: Boolean(args["fullPage"]),
          allowForeground: Boolean(args.allowForeground),
        },
        async () => {
          await assertNativeTab(args, tabId);
        }
      ),
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
        runAt: s.metadata["run-at"]?.[0] || "",
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
  stopNativeTabOperations();
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
          error: {
            code: err instanceof BrowserControlError ? err.code : "HANDLER_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
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
  startNativeTabOperations();
  scriptService = svc;
  registerStatusListener();
  connect();
}
