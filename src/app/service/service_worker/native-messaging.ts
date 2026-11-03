// native messaging bridge for browser-control
// connects to com.latentbyte.browser_control via chrome.runtime.connectNative and
// dispatches incoming commands to LBCat APIs and browser APIs

import { ScriptDAO, ScriptCodeDAO, SCRIPT_STATUS_ENABLE, type Script } from "@App/app/repo/scripts";
import {
  browserIdentityFromUserAgent,
  resolveBrowserControlIdentity,
  type BrowserControlIdentity,
} from "@App/pkg/browser-control/identity";
import {
  captureNativeTab,
  type NativeScreenshotOptions,
  withNativeTabOperation,
  withNativeWindowOperation,
} from "@App/pkg/browser-control/capture";
import { agentWindowService, BrowserControlScopeError } from "@App/pkg/browser-control/agent-window";
import { BrowserControlError } from "@App/pkg/browser-control/errors";
import {
  consumeTabActivation,
  markTabActivation,
  type TabActivationSource,
} from "@App/pkg/browser-control/activation-source";
import { runPageContent } from "@App/pkg/browser-control/page-content";
import { runPageExec, type PageExecResult } from "@App/pkg/browser-control/page-exec";
import { runPageFetch, type PageFetchRequest } from "@App/pkg/browser-control/page-fetch";
import { pageMonitorService, type PageDialogMode } from "@App/pkg/browser-control/page-monitor";
import { runPageAction, type PageActionRequest, type PageWaitState } from "@App/pkg/browser-control/page-actions";
import {
  navigateTab,
  waitForTabComplete,
  waitForTabUrl,
  type TabWaitMode,
} from "@App/pkg/browser-control/tab-navigation";
import { readViewport, resetViewport, setViewport } from "@App/pkg/browser-control/viewport";
import { agentNotesService, type AgentNoteKind, type AgentNoteStatus } from "@App/pkg/browser-control/agent-notes";
import {
  isNativeTabQuarantined,
  startNativeTabOperations,
  stopNativeTabOperations,
} from "@App/pkg/browser-control/tab-operation";
import { guideService } from "@App/pkg/browser-control/guide";
import { agentTabIndicators } from "./agent-tab-access";
import { drawGuide, endSessionGuides, handOffGuides } from "./agent-guide";
import { prepareScriptByCode } from "@App/pkg/utils/script";
import { isUrlIncluded } from "@App/pkg/utils/match";
import { getCombinedMeta, scriptURLPatternResults } from "./utils";
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

// 每个浏览器事件只挂一个监听器，再分发给已订阅的访问入口（switcher 为 true 表示人工切换器入口），断线时统一清理。
// 共用监听器保证激活来源标记每次事件只取一次，两条流看到相同来源
const tabSubscriptions = new Map<string, { streams: Set<boolean>; handler: (...args: unknown[]) => void }>();

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

function tabEventHandler(eventName: string, streams: Set<boolean>) {
  return (...eventArgs: unknown[]) => {
    const activeInfo = eventName === "onActivated" ? (eventArgs[0] as TabActiveInfo | undefined) : undefined;
    // 扩展自己发起的聚焦不是用户切换，交给消费方按来源决定是否记入历史
    const source = activeInfo ? (consumeTabActivation(activeInfo.tabId) ?? "user") : undefined;
    void normalizeNativeTabEvent(eventName, eventArgs, source)
      .then(async (event) => {
        if (!event) return;
        if (streams.has(true)) sendEvent({ cmd: "switcher.tabs.event", data: event });
        if (!streams.has(false) || !event.tabId) return;
        if (await agentWindowService.allowsTabEvent(event.tabId.tabId, event.tabId.windowId, event.tab?.url)) {
          sendEvent({ cmd: "tabs.event", data: event });
        }
      })
      .catch((err: unknown) => {
        if (!(err instanceof BrowserControlScopeError)) log.warn("tab event normalization failed", String(err));
      });
  };
}

function clearTabSubscriptions() {
  const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
  for (const [eventName, { handler }] of tabSubscriptions) {
    tabsObj[eventName]?.removeListener(handler);
  }
  tabSubscriptions.clear();
}

function subscribeNativeTabs(args: Record<string, unknown>, switcher: boolean): HandlerResult {
  const events = (args.events as string[]) || ["onCreated", "onRemoved", "onUpdated", "onActivated"];
  const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
  for (const name of events) {
    const event = tabsObj[name];
    if (!event) continue;
    let subscription = tabSubscriptions.get(name);
    if (!subscription) {
      const streams = new Set<boolean>();
      subscription = { streams, handler: tabEventHandler(name, streams) };
      tabSubscriptions.set(name, subscription);
      event.addListener(subscription.handler);
    }
    subscription.streams.add(switcher);
  }
  return {
    data: {
      subscribed: [...tabSubscriptions]
        .filter(([, subscription]) => subscription.streams.has(switcher))
        .map(([eventName]) => eventName),
    },
  };
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

export type BrowserControlEventSource = "user" | TabActivationSource;

export type BrowserControlEvent = {
  type: "tab-focused" | "tab-removed" | "tab-updated" | "tab-created";
  // tab-focused 才有：用户自己切换，或扩展代为执行的聚焦
  source?: BrowserControlEventSource;
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
  eventArgs: unknown[],
  source: BrowserControlEventSource = "user"
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
      return { type: "tab-focused", source, browserId: tab.browserId, tab, tabId: tabIDFromTab(tab) };
    } catch {
      return {
        type: "tab-focused",
        source,
        browserId: "",
        tabId: { browser: "", windowId: activeInfo.windowId, tabId: activeInfo.tabId },
      };
    }
  }

  return null;
}

export async function focusNativeTab(
  tabId: number,
  requestedWindowId: number | undefined,
  validateAccess: (() => Promise<void>) | undefined,
  source: TabActivationSource
) {
  const existing = await chrome.tabs.get(tabId);
  return withNativeWindowOperation(existing.windowId, async () => {
    await validateAccess?.();
    // 已在前台的标签不会触发 onActivated，留下标记会误归因下一次人工切换
    if (!existing.active) markTabActivation(source, tabId);
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = typeof requestedWindowId === "number" ? requestedWindowId : tab?.windowId;
    if (typeof windowId === "number") {
      await chrome.windows.update(windowId, { focused: true });
    }
    return { tabId, windowId };
  });
}

// 窗口当前显示本会话的标签时，把引导所在标签切到前台；个人或其他任务的标签不让位，也不聚焦窗口
async function bringGuideForward(tab: chrome.tabs.Tab, owner?: string): Promise<void> {
  if (tab.active || tab.id === undefined || !owner) return;
  const tabId = tab.id;
  await withNativeWindowOperation(tab.windowId, async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id === undefined || active.id === tabId) return;
    const { owner: holder } = await agentWindowService.tabAccess(active.id);
    if (holder?.sessionId !== owner) return;
    markTabActivation("agent", tabId);
    await chrome.tabs.update(tabId, { active: true });
  });
}

const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
// 导航类操作在加载超时之外还需注入与静置时间；须小于 CLI 的 5 秒请求余量
const NAVIGATION_MARGIN_MS = 4_000;
// 内容与快照的 CLI 默认请求超时为 30 秒，扩展先于其报错
const DEFAULT_READ_TIMEOUT_MS = 25_000;
// CLI 截图默认请求超时为 2 分钟
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 115_000;
const DEFAULT_ACTION_SETTLE_MS = 300;
const DEFAULT_SNAPSHOT_MAX = 150;
// 引导等待默认 9 分钟，低于代理 Bash 工具 10 分钟上限；超时后界面保留，可再次等待
const DEFAULT_GUIDE_WAIT_MS = 9 * 60_000;
const GUIDE_LOAD_WAIT_MS = 10_000;
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

const UPLOAD_TTL_MS = 120_000;
const UPLOAD_MAX_CHARS = 64 * 1024 * 1024;
const pendingUploads = new Map<string, { data: string; expiresAt: number }>();

async function injectExec(tabId: number, code: string, maxChars: number, compiledKey?: string) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: runPageExec,
    args: compiledKey ? [code, maxChars, compiledKey] : [code, maxChars],
  });
  const injection = results?.[0];
  if (injection && "error" in injection && injection.error) {
    const error = injection.error;
    throw new Error(typeof error === "object" && "message" in error ? String(error.message) : String(error));
  }
  const result = injection?.result;
  if (!result) throw new Error("page execution produced no result");
  return result;
}

// 页面 CSP 禁止 eval 时，经 userScripts 把源码作为脚本注入主世界（不受页面 CSP 限制），
// 编译成函数存入一次性全局键，再由 runPageExec 调用；先试表达式形式，解析失败再试函数体
async function execInPage(tabId: number, code: string, maxChars: number): Promise<PageExecResult> {
  const result = await injectExec(tabId, code, maxChars);
  if (result.success || result.code !== "CSP_BLOCKED") return result;
  if (typeof chrome.userScripts?.execute !== "function")
    return {
      ...result,
      error: `${result.error}; the source-injection fallback needs userScripts.execute (Chrome 135+ with user scripts allowed)`,
    };
  const key = `bctl.exec.${crypto.randomUUID()}`;
  let injectError = "";
  for (const body of [`(\n${code.replace(/[\s;]+$/, "")}\n)`, `{\n${code}\n}`]) {
    await chrome.userScripts
      .execute({
        target: { tabId },
        world: "MAIN",
        js: [{ code: `globalThis[Symbol.for(${JSON.stringify(key)})] = async () => ${body};` }],
      })
      .catch((error: unknown) => {
        // 语法错误可能以拒绝返回；记录后试下一种形式
        injectError = error instanceof Error ? error.message : String(error);
      });
    const compiled = await injectExec(tabId, code, maxChars, key);
    if (compiled.success || compiled.code !== "NOT_COMPILED") return compiled;
  }
  return {
    success: false,
    code: "SCRIPT_ERROR",
    error: `code has a syntax error (page CSP blocks eval, so it was injected as source)${injectError ? `: ${injectError}` : ""}`,
  };
}

// 动作可能触发导航：在同一标签队列内执行并观察导航，返回动作结果与最终页面；
// snapshot 为 diff 时附带动作引起的快照变化（新文档则为完整快照），为 full 时附带整页快照
async function nativePageAction(args: Record<string, unknown>, request: PageActionRequest) {
  const tabId = args.tabId;
  if (typeof tabId !== "number") throw new Error("tabId is required");
  const timeoutMs = timeoutArg(args, DEFAULT_LOAD_TIMEOUT_MS);
  const observe = args.snapshot === "diff" || args.snapshot === "full" ? args.snapshot : undefined;
  return withNativeTabOperation(
    tabId,
    async () => {
      await assertNativeTab(args, tabId);
      let value: Awaited<ReturnType<typeof injectPageAction>> | undefined;
      const { navigated, tab } = await navigateTab(
        tabId,
        async () => {
          value = await injectPageAction(tabId, { ...request, ...(observe === "diff" ? { observe: true } : {}) });
        },
        {
          wait: waitMode(args),
          timeoutMs,
          settleMs: typeof args.settleMs === "number" ? args.settleMs : DEFAULT_ACTION_SETTLE_MS,
        }
      );
      // 动作已生效，快照失败只随结果报告，避免调用方重复执行动作
      const observed = observe
        ? await injectPageAction(tabId, { op: "snapshot", max: DEFAULT_SNAPSHOT_MAX, diff: observe === "diff" }).catch(
            (error: unknown) => ({ snapshotError: error instanceof Error ? error.message : String(error) })
          )
        : {};
      return {
        data: { ...value, navigated, url: tab.url || tab.pendingUrl || "", title: tab.title || "", ...observed },
      };
    },
    { timeoutMs: timeoutMs + NAVIGATION_MARGIN_MS, label: `page.${request.op}` }
  );
}

async function nativeNavigate(
  args: Record<string, unknown>,
  label: string,
  trigger: (tabId: number) => Promise<unknown>
) {
  const tabId = args.tabId;
  if (typeof tabId !== "number") throw new Error("tabId is required");
  const timeoutMs = timeoutArg(args, DEFAULT_LOAD_TIMEOUT_MS);
  return withNativeTabOperation(
    tabId,
    async () => {
      await assertNativeTab(args, tabId);
      const { navigated, tab } = await navigateTab(tabId, () => trigger(tabId), { wait: waitMode(args), timeoutMs });
      return {
        data: { tabId, navigated, url: tab.url || tab.pendingUrl || "", title: tab.title || "", status: tab.status },
      };
    },
    { timeoutMs: timeoutMs + NAVIGATION_MARGIN_MS, label }
  );
}

// 重新加载会话可访问且匹配脚本规则的标签，让推送的新版本立即生效
async function reloadScriptTabs(args: Record<string, unknown>, script: Script): Promise<number[]> {
  const patterns = scriptURLPatternResults({
    metadata: getCombinedMeta(script.metadata, script.selfMetadata || {}),
    originalMetadata: script.metadata,
  })?.scriptUrlPatterns;
  if (!patterns) return [];
  const tabIds = (await agentWindowService.listTabs(sessionId(args)))
    .filter((tab) => tab.id !== undefined && isUrlIncluded(tab.url || tab.pendingUrl || "", patterns))
    .map((tab) => tab.id!);
  await Promise.all(
    tabIds.map((tabId) =>
      nativeNavigate({ ...args, tabId }, "page.reload", (id) => chrome.tabs.reload(id, { bypassCache: false }))
    )
  );
  return tabIds;
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
    endSessionGuides(sessionId(args) ?? "");
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
      await focusNativeTab(
        tabId,
        undefined,
        async () => {
          await assertNativeTab(args, tabId);
        },
        "agent"
      );
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
      data: await focusNativeTab(
        tabId,
        requestedWindowId,
        async () => {
          await assertNativeTab(args, tabId);
        },
        "agent"
      ),
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
      data: await focusNativeTab(
        tabId,
        tab.windowId,
        async () => {
          const current = await chrome.tabs.get(tabId);
          if (current.windowId !== tab.windowId) throw new Error("windowId does not match target tab");
        },
        "switcher"
      ),
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
    const results = await withNativeTabOperation(
      tabId,
      async (operation) => {
        await assertNativeTab(args, tabId);
        operation.bindToDocument();
        return chrome.scripting.executeScript({
          target: { tabId },
          func: runPageContent,
          args: [{ selector, format, maxChars }],
        });
      },
      { timeoutMs: timeoutArg(args, DEFAULT_READ_TIMEOUT_MS), label: "page.content" }
    );
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
    // 超时操作仍在运行时队列被隔离（含排队期间才被隔离），重新加载是恢复手段，不等待加载
    if (!isNativeTabQuarantined(tabId)) {
      try {
        return await nativeNavigate(args, "page.reload", (id) => chrome.tabs.reload(id, { bypassCache }));
      } catch (error) {
        if (!(error instanceof BrowserControlScopeError && error.code === "TAB_EXECUTION_PENDING")) throw error;
      }
    }
    await chrome.tabs.reload(tabId, { bypassCache });
    return { data: { tabId } };
  },

  async "page.goto"(args) {
    const url = args.url;
    if (typeof url !== "string" || !url) throw new Error("url is required");
    return nativeNavigate(args, "page.goto", (id) => chrome.tabs.update(id, { url }));
  },

  async "page.back"(args) {
    return nativeNavigate(args, "page.back", (id) => chrome.tabs.goBack(id));
  },

  async "page.forward"(args) {
    return nativeNavigate(args, "page.forward", (id) => chrome.tabs.goForward(id));
  },

  // 原生消息单帧上限 1 MB，文件内容以 base64 分块先行送达，按 uploadId 拼接
  async "page.upload.chunk"(args) {
    const { uploadId, data } = args;
    if (typeof uploadId !== "string" || !uploadId) throw new Error("uploadId is required");
    if (typeof data !== "string") throw new Error("data is required");
    const now = Date.now();
    for (const [id, pending] of pendingUploads) if (pending.expiresAt < now) pendingUploads.delete(id);
    const received = (pendingUploads.get(uploadId)?.data ?? "") + data;
    if (received.length > UPLOAD_MAX_CHARS) {
      pendingUploads.delete(uploadId);
      throw new BrowserControlError("UPLOAD_TOO_LARGE", `uploads are limited to ${UPLOAD_MAX_CHARS} base64 characters`);
    }
    pendingUploads.set(uploadId, { data: received, expiresAt: now + UPLOAD_TTL_MS });
    return { data: { uploadId, received: received.length } };
  },

  async "page.upload"(args) {
    if (!Array.isArray(args.files) || !args.files.length) throw new Error("files are required");
    const requested = args.files as Array<{ name: string; type: string; uploadId: string }>;
    const files = requested.map(({ name, type, uploadId }) => {
      const pending = pendingUploads.get(uploadId);
      if (!pending)
        throw new BrowserControlError("UPLOAD_NOT_FOUND", `upload ${uploadId} was not received or has expired`);
      return { name, type, data: pending.data };
    });
    for (const { uploadId } of requested) pendingUploads.delete(uploadId);
    return nativePageAction(args, { op: "upload", files, ...locatorArgs(args) });
  },

  async "page.click"(args) {
    const { x, y } = args;
    if (typeof x === "number" && typeof y === "number") return nativePageAction(args, { op: "click", point: { x, y } });
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
    const results = await withNativeTabOperation(
      tabId,
      async (operation) => {
        await assertNativeTab(args, tabId);
        operation.bindToDocument();
        return chrome.scripting.executeScript({ target: { tabId }, func: runPageFetch, args: [request] });
      },
      { timeoutMs: request.timeoutMs + 2_000, label: "page.fetch" }
    );
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
    const max = typeof args.max === "number" && args.max > 0 ? args.max : DEFAULT_SNAPSHOT_MAX;
    const value = await withNativeTabOperation(
      tabId,
      async (operation) => {
        await assertNativeTab(args, tabId);
        operation.bindToDocument();
        return injectPageAction(tabId, { op: "snapshot", selector, max });
      },
      { timeoutMs: timeoutArg(args, DEFAULT_READ_TIMEOUT_MS), label: "page.snapshot" }
    );
    return { data: value.snapshot };
  },

  // --- guide ---

  // 引导模式：解析标注并在页面绘制步骤卡片；人工响应由 guide.wait 取回
  async "guide.step"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new BrowserControlError("INVALID_ARGUMENT", "guide step needs --text");
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
    const marks = (Array.isArray(args.marks) ? args.marks : []).map((mark: unknown, index) => {
      const value = (mark ?? {}) as Record<string, unknown>;
      const locator = locatorArgs(value);
      if (!locator.selector && !locator.text && !locator.ref)
        throw new BrowserControlError("INVALID_ARGUMENT", `mark ${index + 1} needs a selector, text, or ref`);
      const label = typeof value.label === "string" ? value.label.trim().slice(0, 80) : "";
      return { locator, label: label || String(index + 1) };
    });
    const step = await withNativeTabOperation(
      tabId,
      async (operation) => {
        const tab = await assertNativeTab(args, tabId);
        operation.bindToDocument();
        const { refs = [] } = marks.length
          ? await injectPageAction(tabId, { op: "resolve", locators: marks.map((mark) => mark.locator) })
          : {};
        const guideMarks = refs.map((ref, index) => ({ ref, label: marks[index].label }));
        // 会话此前没有进行中的引导时标记开始，CLI 据此通知人工；换标签与后续步骤不重复通知
        const started = !guideService.owned(sessionId(args)).length;
        const stepId = guideService.begin(tabId, { text, title, marks: guideMarks }, sessionId(args));
        try {
          await drawGuide(tabId, { stepId, title, text, marks: guideMarks, state: "step" });
        } catch (error) {
          guideService.close(tabId);
          throw error;
        }
        await handOffGuides(tabId, sessionId(args));
        await bringGuideForward(tab, sessionId(args));
        return { step: stepId, marks: guideMarks, ...(started ? { started } : {}) };
      },
      { timeoutMs: timeoutArg(args, DEFAULT_READ_TIMEOUT_MS), label: "guide.step" }
    );
    return { data: { tabId, ...step } };
  },

  // 阻塞到人工响应、页面导航、标签关闭或超时；不占用标签操作队列
  async "guide.wait"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    await assertNativeTab(args, tabId);
    const outcome = await guideService.wait(tabId, timeoutArg(args, DEFAULT_GUIDE_WAIT_MS));
    // 跳转后新页面的标题要等加载完成；页面迟迟不完成时返回当前所知
    const tab =
      outcome.action === "closed"
        ? undefined
        : outcome.action === "navigated"
          ? await waitForTabComplete(tabId, GUIDE_LOAD_WAIT_MS).catch(() => chrome.tabs.get(tabId))
          : await chrome.tabs.get(tabId);
    return {
      data: {
        tabId,
        ...outcome,
        ...(tab ? { url: outcome.url ?? tab.url ?? tab.pendingUrl ?? "", title: tab.title ?? "" } : {}),
      },
    };
  },

  async "guide.clear"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    await assertNativeTab(args, tabId);
    guideService.close(tabId);
    await withNativeTabOperation(tabId, () => drawGuide(tabId, null), {
      timeoutMs: timeoutArg(args, DEFAULT_READ_TIMEOUT_MS),
      label: "guide.clear",
    });
    return { data: { tabId, cleared: true } };
  },

  async "page.monitor.start"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    const dialogs = args.dialogs ?? "pass";
    if (dialogs !== "pass" && dialogs !== "accept" && dialogs !== "dismiss")
      throw new BrowserControlError("INVALID_ARGUMENT", "dialogs must be pass, accept, or dismiss");
    await assertNativeTab(args, tabId);
    await pageMonitorService.start(tabId, dialogs as PageDialogMode);
    return { data: { tabId, monitoring: true } };
  },

  async "page.monitor.read"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    await assertNativeTab(args, tabId);
    return { data: { tabId, ...(await pageMonitorService.read(tabId, Boolean(args.keep))) } };
  },

  async "page.monitor.stop"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    await assertNativeTab(args, tabId);
    return { data: { tabId, ...(await pageMonitorService.stop(tabId)) } };
  },

  // 设置页面视口尺寸（Chrome 按标签模拟，Firefox 调整代理窗口）；reset 撤销；不提供尺寸时只读取当前视口
  async "page.viewport"(args) {
    const tabId = args.tabId;
    if (typeof tabId !== "number") throw new Error("tabId is required");
    const width = typeof args.width === "number" && args.width > 0 ? args.width : undefined;
    const height = typeof args.height === "number" && args.height > 0 ? args.height : undefined;
    const tab = await withNativeTabOperation(tabId, () => assertNativeTab(args, tabId));
    const { windowId } = await agentWindowService.status();
    const result = { tabId, windowId };
    if (!args.reset && width === undefined && height === undefined)
      return { data: { ...result, ...(await readViewport(tabId)) } };
    // 重置不限窗口：已模拟尺寸的标签移出代理窗口后仍可撤销
    if (!args.reset && tab.windowId !== windowId)
      throw new BrowserControlError(
        "VIEWPORT_WINDOW_DENIED",
        "only tabs in the agent window can be resized; move the tab into the agent window first"
      );
    const viewport = await withNativeTabOperation(
      tabId,
      () => (args.reset ? resetViewport(tabId, windowId) : setViewport(tabId, windowId, { width, height })),
      { timeoutMs: timeoutArg(args, DEFAULT_READ_TIMEOUT_MS), label: "page.viewport" }
    );
    return { data: { ...result, ...viewport } };
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
            await withNativeTabOperation(
              tabId,
              async (operation) => {
                operation.bindToDocument();
                return injectPageAction(tabId, { op: "wait", selector, text, state, timeoutMs: remaining() });
              },
              { timeoutMs: remaining() + 1_000, label: "page.wait" }
            )
          ).matched;
          break;
        } catch (error) {
          // 等待期间主文档提交时在新文档上继续等待
          const retryable =
            !(error instanceof BrowserControlError) ||
            (error instanceof BrowserControlScopeError && error.code === "TAB_DOCUMENT_CHANGED");
          if (!retryable || remaining() <= WAIT_RETRY_MS) throw error;
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
    const result = await withNativeTabOperation(
      tabId,
      async (operation) => {
        await assertNativeTab(args, tabId);
        // 校验期间可能已到期，到期后不得再开始执行代码
        if (Date.now() >= expiresAt) throw new Error(`page.exec timed out after ${timeoutMs}ms`);
        operation.bindToDocument();
        return execInPage(tabId, code, typeof args.maxChars === "number" ? args.maxChars : 0);
      },
      { timeoutMs, label: "page.exec" }
    );
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
          region: args.region as NativeScreenshotOptions["region"],
          format: args["format"] as "png" | "jpeg" | undefined,
          quality: args["quality"] as number | undefined,
          fullPage: Boolean(args["fullPage"]),
          allowForeground: Boolean(args.allowForeground),
          timeoutMs: timeoutArg(args, DEFAULT_SCREENSHOT_TIMEOUT_MS),
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
    const reloadedTabs = args.reloadTabs ? await reloadScriptTabs(args, script) : undefined;
    return { data: { uuid: script.uuid, isNew: !oldScript, ...(reloadedTabs ? { reloadedTabs } : {}) } };
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
