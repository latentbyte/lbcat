// native messaging bridge for vmctl
// connects to com.scriptcat.vmhost via chrome.runtime.connectNative and
// dispatches incoming commands to ScriptCat APIs and browser APIs

import { ScriptDAO, ScriptCodeDAO, SCRIPT_STATUS_ENABLE } from "@App/app/repo/scripts";
import { prepareScriptByCode } from "@App/pkg/utils/script";
import type { ScriptService } from "./script";

const HOST_NAME = "com.scriptcat.vmhost";
const RECONNECT_DELAY = 5000;

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
    connected: { text: "●", color: "#4CAF50", title: "ScriptCat vmctl connected" },
    connecting: { text: "○", color: "#FF9800", title: "ScriptCat vmctl connecting" },
    disconnected: { text: "×", color: "#F44336", title: "ScriptCat vmctl disconnected" },
    error: { text: "!", color: "#9C27B0", title: "ScriptCat vmctl connection error" },
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
    port.postMessage({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "event",
      payload,
    });
  } catch (e: unknown) {
    if (process.env.DEBUG) {
      log.warn("sendEvent failed", String(e));
    }
  }
}

function tabEventHandler(eventName: string) {
  return (...eventArgs: unknown[]) => {
    const payload: Record<string, unknown> = { cmd: "tabs.event", data: { event: eventName } };
    if (eventName === "onCreated") {
      (payload["data"] as Record<string, unknown>)["tab"] = eventArgs[0];
    } else if (eventName === "onRemoved") {
      (payload["data"] as Record<string, unknown>)["tabId"] = eventArgs[0];
      (payload["data"] as Record<string, unknown>)["removeInfo"] = eventArgs[1];
    } else if (eventName === "onUpdated") {
      (payload["data"] as Record<string, unknown>)["tabId"] = eventArgs[0];
      (payload["data"] as Record<string, unknown>)["changeInfo"] = eventArgs[1];
      (payload["data"] as Record<string, unknown>)["tab"] = eventArgs[2];
    } else if (eventName === "onActivated") {
      (payload["data"] as Record<string, unknown>)["activeInfo"] = eventArgs[0];
    }
    sendEvent(payload);
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

const handlers: Record<string, Handler> = {
  // --- tabs ---

  async "tabs.list"(args) {
    const query = (args?.["query"] as chrome.tabs.QueryInfo) || {};
    const tabs = await chrome.tabs.query(query);
    return {
      data: tabs.map((t) => ({
        id: t.id,
        url: t.url || t.pendingUrl || "",
        title: t.title || "",
        active: t.active,
        windowId: t.windowId,
        status: t.status,
        pinned: t.pinned,
        incognito: t.incognito,
      })),
    };
  },

  async "tabs.get"(args) {
    const tab = await chrome.tabs.get(args["tabId"] as number);
    return {
      data: {
        id: tab.id,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        active: tab.active,
        windowId: tab.windowId,
      },
    };
  },

  async "tabs.create"(args) {
    const url = args["url"] as string | undefined;
    const active = args["active"] !== undefined ? Boolean(args["active"]) : true;
    if (!url) throw new Error("url is required");
    const tab = await chrome.tabs.create({ url, active });
    return {
      data: {
        id: tab.id,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        active: tab.active,
        windowId: tab.windowId,
      },
    };
  },

  "tabs.subscribe"(args) {
    const events = (args?.["events"] as string[]) || ["onCreated", "onRemoved", "onUpdated", "onActivated"];
    clearTabSubscriptions();
    const tabsObj = chrome.tabs as unknown as Record<string, chrome.events.Event<(...args: unknown[]) => void>>;
    for (const name of events) {
      const event = tabsObj[name];
      if (!event) continue;
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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string, fmt: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return fmt === "html" ? (el as HTMLElement).innerHTML : (el as HTMLElement).innerText;
      },
      args: [selector, format],
    });
    return { data: results?.[0]?.result ?? null };
  },

  async "page.reload"(args) {
    const tabId = args["tabId"] as number | undefined;
    const bypassCache = Boolean(args["bypassCache"]);
    if (!tabId) throw new Error("tabId is required");
    await chrome.tabs.reload(tabId, { bypassCache });
    return { data: { tabId } };
  },

  async "page.exec"(args) {
    const tabId = args["tabId"] as number | undefined;
    const code = args["code"] as string | undefined;
    const timeoutMs = (args["timeoutMs"] as number) || 45000;
    if (!tabId) throw new Error("tabId is required");
    if (!code) throw new Error("code is required");
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        // eval runs in page context, not extension SW
        func: (c: string) => eval(c),
        args: [code],
      }),
      timeoutMs,
      "page.exec"
    );
    return { data: { result: results?.[0]?.result ?? null } };
  },

  async "page.screenshot"(args) {
    const tabId = args["tabId"] as number | undefined;
    const selector = (args["selector"] as string) || null;
    const format = (args["format"] as "png" | "jpeg") || "png";
    const quality = (args["quality"] as number) || 80;
    const fullPage = Boolean(args["fullPage"]);
    if (!tabId) throw new Error("tabId is required");

    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId!, { focused: true });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const captureOpts: chrome.extensionTypes.ImageDetails = {
      format,
      quality: format === "jpeg" ? quality : undefined,
    };

    if (fullPage && !selector) {
      const [dimsResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        }),
      });
      const dims = dimsResult.result as {
        scrollWidth: number;
        scrollHeight: number;
        viewportWidth: number;
        viewportHeight: number;
        dpr: number;
      };

      if (dims.scrollHeight <= dims.viewportHeight) {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, captureOpts);
        return { data: { dataUrl, width: dims.viewportWidth, height: dims.viewportHeight } };
      }

      const captures: { y: number; dataUrl: string }[] = [];
      for (let y = 0; y < dims.scrollHeight; y += dims.viewportHeight) {
        const [scrollResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (scrollY: number) => {
            window.scrollTo(0, scrollY);
            return window.scrollY;
          },
          args: [y],
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const actualY = scrollResult.result ?? y;
        if (captures.at(-1)?.y === actualY) break;
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, captureOpts);
        captures.push({ y: actualY, dataUrl });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollTo(0, 0),
      });

      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const [stitchResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (
          capturesList: { y: number; dataUrl: string }[],
          totalHeight: number,
          vpWidth: number,
          vpHeight: number,
          dpr: number,
          mime: string
        ) => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(vpWidth * dpr);
          canvas.height = Math.round(totalHeight * dpr);
          const ctx = canvas.getContext("2d")!;
          for (const capture of capturesList) {
            const img = new Image();
            img.src = capture.dataUrl;
            await new Promise((res, rej) => {
              img.onload = res;
              img.onerror = rej;
            });
            const sliceH = Math.min(vpHeight, totalHeight - capture.y);
            ctx.drawImage(
              img,
              0,
              0,
              Math.round(vpWidth * dpr),
              Math.round(sliceH * dpr),
              0,
              Math.round(capture.y * dpr),
              Math.round(vpWidth * dpr),
              Math.round(sliceH * dpr)
            );
          }
          return canvas.toDataURL(mime);
        },
        args: [captures, dims.scrollHeight, dims.viewportWidth, dims.viewportHeight, dims.dpr, mimeType],
      });
      return { data: { dataUrl: stitchResult.result, width: dims.viewportWidth, height: dims.scrollHeight } };
    }

    if (selector) {
      const [rectResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
            dpr: window.devicePixelRatio || 1,
          };
        },
        args: [selector],
      });
      if (!rectResult.result) throw new Error(`element not found: ${selector}`);
      const rect = rectResult.result as { x: number; y: number; width: number; height: number; dpr: number };

      await new Promise((resolve) => setTimeout(resolve, 150));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, captureOpts);
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

      const [cropResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (src: string, rx: number, ry: number, rw: number, rh: number, dpr: number, mime: string) => {
          const img = new Image();
          img.src = src;
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
          });
          const canvas = document.createElement("canvas");
          canvas.width = rw * dpr;
          canvas.height = rh * dpr;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, rx * dpr, ry * dpr, rw * dpr, rh * dpr, 0, 0, rw * dpr, rh * dpr);
          return canvas.toDataURL(mime);
        },
        args: [dataUrl, rect.x, rect.y, rect.width, rect.height, rect.dpr, mimeType],
      });
      return { data: { dataUrl: cropResult.result, width: rect.width, height: rect.height } };
    }

    // simple visible viewport capture
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, captureOpts);
    const [vpResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
    const vp = vpResult.result as { width: number; height: number } | null;
    return { data: { dataUrl, width: vp?.width || 0, height: vp?.height || 0 } };
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
    const { script, oldScript } = await prepareScriptByCode(code, "vmctl");
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
    const { script } = await prepareScriptByCode(code, "vmctl", uuid);
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
    const { script, oldScript } = await prepareScriptByCode(code, "vmctl");
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

  let response: unknown;
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
      port.postMessage(response);
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
