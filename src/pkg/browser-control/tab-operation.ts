import { BrowserControlScopeError } from "./agent-window";

type Signal = { promise: Promise<void>; resolve: () => void };
type TabQueue = {
  tail?: Promise<void>;
  active?: Promise<void>;
  changed: Signal;
  blocked: Signal;
  quarantined: boolean;
  documentBound: boolean;
};
export type NativeTabOperation = { quarantine: () => void; bindToDocument: () => void };
const queues = new Map<number, TabQueue>();
let listening = false;

function signal(): Signal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pendingError(): BrowserControlScopeError {
  return new BrowserControlScopeError(
    "TAB_EXECUTION_PENDING",
    "Timed-out page execution is still running; wait for completion or reload the tab"
  );
}

// 主文档提交才结束旧执行世界；子框架及同文档导航不能释放队列
function onCommitted(info: { tabId: number; frameId: number }): void {
  if (info.frameId === 0 && queues.get(info.tabId)?.documentBound) invalidate(info.tabId);
}
function invalidate(tabId: number): void {
  const queue = queues.get(tabId);
  queues.delete(tabId);
  queue?.changed.resolve();
}

export function startNativeTabOperations(): void {
  if (listening) return;
  chrome.webNavigation?.onCommitted?.addListener(onCommitted);
  chrome.tabs.onRemoved?.addListener(invalidate);
  listening = true;
}

export function stopNativeTabOperations(): void {
  if (!listening) return;
  chrome.webNavigation?.onCommitted?.removeListener(onCommitted);
  chrome.tabs.onRemoved?.removeListener(invalidate);
  listening = false;
}

export function isNativeTabQuarantined(tabId: number): boolean {
  return queues.get(tabId)?.quarantined ?? false;
}

// timeoutMs 从调用起计时：排队中到期则放弃且不再执行；运行中到期则隔离队列直到操作真正结束，
// 隔离后主文档提交即可恢复（页面重载是恢复手段）
export function withNativeTabOperation<T>(
  tabId: number,
  action: (operation: NativeTabOperation) => Promise<T>,
  options: { timeoutMs?: number; label?: string } = {}
): Promise<T> {
  const { timeoutMs, label = "tab operation" } = options;
  if (!timeoutMs || timeoutMs <= 0) return runNativeTabOperation(tabId, action);
  const timeoutError = () => new Error(`${label} timed out after ${timeoutMs}ms`);
  let expired = false;
  let quarantine: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = runNativeTabOperation(tabId, async (operation) => {
    if (expired) throw timeoutError();
    quarantine = operation.quarantine;
    return action(operation);
  });
  return Promise.race([
    run,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        quarantine?.();
        reject(timeoutError());
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runNativeTabOperation<T>(
  tabId: number,
  action: (operation: NativeTabOperation) => Promise<T>
): Promise<T> {
  let queue = queues.get(tabId);
  if (queue?.quarantined) throw pendingError();
  if (!queue) {
    queue = { changed: signal(), blocked: signal(), quarantined: false, documentBound: false };
    queues.set(tabId, queue);
  }
  const current = queue;
  const previous = current.tail;
  const pending = signal();
  current.tail = pending.promise;
  const changed = current.changed.promise.then(() => {
    throw new BrowserControlScopeError(
      "TAB_DOCUMENT_CHANGED",
      "Tab document changed; retry the operation on the new document"
    );
  });
  try {
    await Promise.race([
      previous,
      changed,
      current.blocked.promise.then(() => {
        throw pendingError();
      }),
    ]);
    if (queues.get(tabId) !== current)
      throw new BrowserControlScopeError(
        "TAB_DOCUMENT_CHANGED",
        "Tab document changed; retry the operation on the new document"
      );
    if (current.quarantined) throw pendingError();
    current.active = pending.promise;
    current.documentBound = false;
    return await Promise.race([
      action({
        bindToDocument: () => {
          current.documentBound = true;
        },
        // 超时后旧执行仍可能运行；主文档提交会结束其执行世界，因此隔离后总是由提交恢复
        quarantine: () => {
          if (queues.get(tabId) === current && current.active === pending.promise) {
            current.quarantined = true;
            current.documentBound = true;
            current.blocked.resolve();
          }
        },
      }),
      changed,
    ]);
  } finally {
    pending.resolve();
    if (
      queues.get(tabId) === current &&
      (current.quarantined ? current.active === pending.promise : current.tail === pending.promise)
    ) {
      queues.delete(tabId);
    }
  }
}
