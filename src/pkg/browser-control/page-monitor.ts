import { BrowserControlError } from "./errors";

export type PageMonitorEntry = {
  time: number;
  type: "console" | "error" | "rejection" | "dialog" | "request" | "navigation";
  level?: "error" | "warn";
  message: string;
  url?: string;
  method?: string;
  status?: number;
};
export type PageDialogMode = "pass" | "accept" | "dismiss";
export type PageMonitorBatch = { entries: PageMonitorEntry[]; dropped: number };

// 注入 MAIN 世界：install 挂钩控制台、异常与对话框，drain 取出并清空，remove 取出后恢复原函数
// 必须自包含；未安装时 drain/remove 返回 null
export function runPageMonitor(op: "install" | "drain" | "remove", dialogs: PageDialogMode): PageMonitorBatch | null {
  type State = PageMonitorBatch & { dialogs: PageDialogMode; restore: () => void };
  const key = Symbol.for("bctl.page-monitor");
  const host = window as unknown as Record<symbol, State | undefined>;
  const existing = host[key];
  const take = (state: State): PageMonitorBatch => {
    const batch = { entries: state.entries, dropped: state.dropped };
    state.entries = [];
    state.dropped = 0;
    return batch;
  };
  if (op !== "install") {
    if (!existing) return null;
    if (op === "remove") {
      existing.restore();
      delete host[key];
    }
    return take(existing);
  }
  if (existing) {
    existing.dialogs = dialogs;
    return { entries: [], dropped: 0 };
  }

  const LIMIT = 500;
  const state: State = { entries: [], dropped: 0, dialogs, restore: () => {} };
  const text = (value: unknown): string => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const push = (entry: Omit<PageMonitorEntry, "time">) => {
    if (state.entries.length >= LIMIT) {
      state.entries.shift();
      state.dropped++;
    }
    state.entries.push({ time: Date.now(), ...entry, message: entry.message.slice(0, 2000) });
  };

  const original = {
    error: console.error,
    warn: console.warn,
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
  };
  console.error = function (...args: unknown[]) {
    push({ type: "console", level: "error", message: args.map(text).join(" ") });
    return original.error.apply(this, args);
  };
  console.warn = function (...args: unknown[]) {
    push({ type: "console", level: "warn", message: args.map(text).join(" ") });
    return original.warn.apply(this, args);
  };
  // pass 交给浏览器显示（会阻塞页面直到用户响应），accept/dismiss 立即返回
  window.alert = function (message?: unknown) {
    push({ type: "dialog", message: `alert: ${text(message ?? "")}` });
    if (state.dialogs === "pass") original.alert.call(window, message);
  };
  window.confirm = function (message?: string) {
    if (state.dialogs === "pass") {
      push({ type: "dialog", message: `confirm: ${text(message ?? "")} -> (shown to user)` });
      return original.confirm.call(window, message);
    }
    const answer = state.dialogs === "accept";
    push({ type: "dialog", message: `confirm: ${text(message ?? "")} -> ${answer}` });
    return answer;
  };
  window.prompt = function (message?: string, value?: string) {
    if (state.dialogs === "pass") {
      push({ type: "dialog", message: `prompt: ${text(message ?? "")} -> (shown to user)` });
      return original.prompt.call(window, message, value);
    }
    const answer = state.dialogs === "accept" ? (value ?? "") : null;
    push({ type: "dialog", message: `prompt: ${text(message ?? "")} -> ${JSON.stringify(answer)}` });
    return answer;
  };
  // 资源加载失败由 webRequest 记录，这里只取脚本运行时异常
  const onError = (event: Event) => {
    if (!(event instanceof ErrorEvent)) return;
    push({
      type: "error",
      level: "error",
      message: event.error !== undefined && event.error !== null ? text(event.error) : event.message,
      ...(event.filename ? { url: `${event.filename}:${event.lineno}:${event.colno}` } : {}),
    });
  };
  const onRejection = (event: Event) => {
    push({ type: "rejection", level: "error", message: text((event as PromiseRejectionEvent).reason) });
  };
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  state.restore = () => {
    console.error = original.error;
    console.warn = original.warn;
    window.alert = original.alert;
    window.confirm = original.confirm;
    window.prompt = original.prompt;
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  // 不可枚举，避免出现在页面对 window 的遍历中
  Object.defineProperty(window, key, { value: state, configurable: true });
  return { entries: [], dropped: 0 };
}

type TabMonitor = PageMonitorBatch & { dialogs: PageDialogMode };

const MONITOR_LIMIT = 500;

// 网络失败由 webRequest 在后台记录（跨导航保留）；页面钩子在每次主框架提交后重新注入
export class PageMonitorService {
  private readonly monitors = new Map<number, TabMonitor>();

  private readonly onCompleted = (details: chrome.webRequest.OnCompletedDetails) => {
    if (details.statusCode < 400) return;
    this.record(details.tabId, {
      time: details.timeStamp,
      type: "request",
      level: "error",
      method: details.method,
      url: details.url,
      status: details.statusCode,
      message: `${details.method} ${details.url} -> ${details.statusCode}`,
    });
  };

  private readonly onErrorOccurred = (details: chrome.webRequest.OnErrorOccurredDetails) => {
    // 取消的请求（导航离开、中止的 fetch）不是故障
    if (/ABORTED/.test(details.error)) return;
    this.record(details.tabId, {
      time: details.timeStamp,
      type: "request",
      level: "error",
      method: details.method,
      url: details.url,
      message: `${details.method} ${details.url} failed: ${details.error}`,
    });
  };

  private readonly onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    const monitor = this.monitors.get(details.tabId);
    if (!monitor || details.frameId !== 0) return;
    this.record(details.tabId, {
      time: Date.now(),
      type: "navigation",
      url: details.url,
      message: `navigated to ${details.url}`,
    });
    this.inject(details.tabId, "install", monitor.dialogs, true).catch((error: unknown) => {
      this.record(details.tabId, {
        time: Date.now(),
        type: "error",
        level: "warn",
        message: `monitor hooks not attached: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  };

  private readonly onRemoved = (tabId: number) => {
    if (this.monitors.delete(tabId)) this.unlistenIfIdle();
  };

  async start(tabId: number, dialogs: PageDialogMode): Promise<void> {
    const existing = this.monitors.get(tabId);
    if (existing) existing.dialogs = dialogs;
    else {
      if (this.monitors.size === 0) this.listen();
      this.monitors.set(tabId, { entries: [], dropped: 0, dialogs });
    }
    await this.inject(tabId, "install", dialogs, false);
  }

  async read(tabId: number, keep: boolean): Promise<PageMonitorBatch> {
    const monitor = this.require(tabId);
    this.merge(monitor, await this.inject(tabId, "drain", monitor.dialogs, false));
    const batch = { entries: [...monitor.entries].sort((a, b) => a.time - b.time), dropped: monitor.dropped };
    if (!keep) {
      monitor.entries = [];
      monitor.dropped = 0;
    }
    return batch;
  }

  // 先注销再取回页面中剩余条目，页面不可注入时注销仍然生效
  async stop(tabId: number): Promise<PageMonitorBatch> {
    const monitor = this.require(tabId);
    this.monitors.delete(tabId);
    this.unlistenIfIdle();
    this.merge(monitor, await this.inject(tabId, "remove", monitor.dialogs, false));
    return { entries: monitor.entries.sort((a, b) => a.time - b.time), dropped: monitor.dropped };
  }

  private require(tabId: number): TabMonitor {
    const monitor = this.monitors.get(tabId);
    if (!monitor)
      throw new BrowserControlError("MONITOR_NOT_STARTED", `no monitor on tab ${tabId}; run page monitor start`);
    return monitor;
  }

  private async inject(
    tabId: number,
    op: "install" | "drain" | "remove",
    dialogs: PageDialogMode,
    immediately: boolean
  ): Promise<PageMonitorBatch | null> {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: runPageMonitor,
      args: [op, dialogs],
      ...(immediately ? { injectImmediately: true } : {}),
    });
    return (injection?.result as PageMonitorBatch | null | undefined) ?? null;
  }

  private merge(monitor: TabMonitor, batch: PageMonitorBatch | null) {
    if (!batch) return;
    monitor.dropped += batch.dropped;
    for (const entry of batch.entries) this.append(monitor, entry);
  }

  private record(tabId: number, entry: PageMonitorEntry) {
    const monitor = this.monitors.get(tabId);
    if (monitor) this.append(monitor, entry);
  }

  private append(monitor: TabMonitor, entry: PageMonitorEntry) {
    if (monitor.entries.length >= MONITOR_LIMIT) {
      monitor.entries.shift();
      monitor.dropped++;
    }
    monitor.entries.push(entry);
  }

  private listen() {
    chrome.webRequest.onCompleted.addListener(this.onCompleted, { urls: ["<all_urls>"] });
    chrome.webRequest.onErrorOccurred.addListener(this.onErrorOccurred, { urls: ["<all_urls>"] });
    chrome.webNavigation.onCommitted.addListener(this.onCommitted);
    chrome.tabs.onRemoved.addListener(this.onRemoved);
  }

  private unlistenIfIdle() {
    if (this.monitors.size > 0) return;
    chrome.webRequest.onCompleted.removeListener(this.onCompleted);
    chrome.webRequest.onErrorOccurred.removeListener(this.onErrorOccurred);
    chrome.webNavigation.onCommitted.removeListener(this.onCommitted);
    chrome.tabs.onRemoved.removeListener(this.onRemoved);
  }
}

export const pageMonitorService = new PageMonitorService();
