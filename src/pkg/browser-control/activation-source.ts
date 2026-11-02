// 记录扩展自身触发的标签激活，供 tab-focused 事件标注来源。
// onActivated 在 tabs.update 之后才到达，标记需在发起激活前写入。

export type TabActivationSource = "agent" | "switcher";

type PendingActivation = { tabId: number; source: TabActivationSource; expiresAt: number };

// 标记有效期；超时的标记不参与归因，避免落到之后的人工切换上
const MARK_TTL_MS = 5_000;

let pending: PendingActivation[] = [];

export function markTabActivation(source: TabActivationSource, tabId: number): void {
  prune();
  pending.push({ tabId, source, expiresAt: Date.now() + MARK_TTL_MS });
}

// 取出并清除该标签的标记；没有标记说明是用户自己在浏览器里切换的
export function consumeTabActivation(tabId: number): TabActivationSource | undefined {
  prune();
  const index = pending.findIndex((entry) => entry.tabId === tabId);
  if (index < 0) return undefined;
  const [entry] = pending.splice(index, 1);
  return entry.source;
}

export function clearTabActivations(): void {
  pending = [];
}

function prune(): void {
  const now = Date.now();
  pending = pending.filter((entry) => entry.expiresAt > now);
}
