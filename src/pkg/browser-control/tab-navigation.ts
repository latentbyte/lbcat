import { BrowserControlError } from "./errors";

export type TabWaitMode = "load" | "none";
export type NavigateOptions = {
  wait: TabWaitMode;
  timeoutMs: number;
  // 动作可能不导航：在此时间内未开始导航则直接返回
  settleMs?: number;
};
export type NavigateResult = { navigated: boolean; tab: chrome.tabs.Tab };

// 等待导航时 URL 不变的同文档跳转可能没有 loading 事件，给它一个短窗口
const SAME_DOCUMENT_GRACE_MS = 1000;

type Watch = {
  started: Promise<void>;
  completed: Promise<void>;
  urlChanged: () => boolean;
  stop: () => void;
};

// 在触发导航前注册，避免错过事件或把旧页面的 complete 当作新页面
function watchTab(tabId: number): Watch {
  let urlChanged = false;
  let loading = false;
  let markStarted!: () => void;
  let markCompleted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const completed = new Promise<void>((resolve) => (markCompleted = resolve));
  const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId) return;
    if (change.url) {
      urlChanged = true;
      markStarted();
    }
    if (change.status === "loading") {
      loading = true;
      markStarted();
    }
    if (change.status === "complete" && loading) markCompleted();
  };
  chrome.tabs.onUpdated.addListener(listener);
  return {
    started,
    completed,
    urlChanged: () => urlChanged,
    stop: () => chrome.tabs.onUpdated.removeListener(listener),
  };
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const elapsed = <T>(promise: Promise<T>, ms: number) =>
  deadline(
    promise.then(() => true),
    ms,
    () => new Error("elapsed")
  ).catch(() => false);

export async function navigateTab(
  tabId: number,
  trigger: () => Promise<unknown>,
  options: NavigateOptions
): Promise<NavigateResult> {
  const watch = watchTab(tabId);
  const loadTimeout = () =>
    new BrowserControlError("LOAD_TIMEOUT", `tab ${tabId} did not finish loading within ${options.timeoutMs}ms`);
  try {
    await trigger();
    if (options.wait === "none") return { navigated: false, tab: await chrome.tabs.get(tabId) };
    const grace = options.settleMs ?? SAME_DOCUMENT_GRACE_MS;
    const started = await elapsed(watch.started, grace);
    if (!started) return { navigated: false, tab: await chrome.tabs.get(tabId) };
    const current = await chrome.tabs.get(tabId);
    // 仅地址变化（单页应用或锚点）没有加载周期
    if (current.status === "complete" && watch.urlChanged()) {
      const loading = await elapsed(watch.completed, 0);
      if (!loading) return { navigated: true, tab: current };
    }
    await deadline(watch.completed, options.timeoutMs, loadTimeout);
    return { navigated: true, tab: await chrome.tabs.get(tabId) };
  } finally {
    watch.stop();
  }
}

export async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return waitForTab(tabId, timeoutMs, (tab) => tab.status === "complete", "load");
}

export async function waitForTabUrl(tabId: number, pattern: RegExp, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return waitForTab(tabId, timeoutMs, (tab) => pattern.test(tab.url || tab.pendingUrl || ""), `url ${pattern}`);
}

async function waitForTab(
  tabId: number,
  timeoutMs: number,
  done: (tab: chrome.tabs.Tab) => boolean,
  label: string
): Promise<chrome.tabs.Tab> {
  let listener!: (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
  const matched = new Promise<chrome.tabs.Tab>((resolve) => {
    listener = (id, _change, tab) => {
      if (id === tabId && done(tab)) resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  try {
    const current = await chrome.tabs.get(tabId);
    if (done(current)) return current;
    return await deadline(
      matched,
      timeoutMs,
      () => new BrowserControlError("WAIT_TIMEOUT", `tab ${tabId} ${label} not reached within ${timeoutMs}ms`)
    );
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
}
