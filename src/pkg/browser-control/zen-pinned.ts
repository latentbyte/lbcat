type PinnableTab = { windowId: number; pinned?: boolean; incognito?: boolean; url?: string };

// 镜像标签各自导航，地址会漂移（如 hash、子路径），按来源匹配；无来源时用完整 URL
function mirrorKey(url = ""): string {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
}

// Zen 把精华与空间固定标签同步到每个窗口，每份都有自己的标签 ID；只保留基准窗口那份。
// 基准窗口取 ID 最小（最早打开）的非代理普通窗口，其他窗口中与基准同源的固定标签视为镜像
export function dropZenPinnedMirrors<T extends PinnableTab>(tabs: T[], agentWindowId?: number): T[] {
  const pinned = tabs.filter((tab) => tab.pinned && !tab.incognito);
  const windowIds = [...new Set(pinned.map((tab) => tab.windowId))].sort((a, b) => a - b);
  if (windowIds.length < 2) return tabs;
  const baseWindowId = windowIds.find((id) => id !== agentWindowId) ?? windowIds[0];

  const baseCounts = new Map<string, number>();
  for (const tab of pinned)
    if (tab.windowId === baseWindowId)
      baseCounts.set(mirrorKey(tab.url), (baseCounts.get(mirrorKey(tab.url)) ?? 0) + 1);

  const mirrors = new Set<T>();
  const remaining = new Map<number, Map<string, number>>();
  for (const tab of pinned) {
    if (tab.windowId === baseWindowId) continue;
    let counts = remaining.get(tab.windowId);
    if (!counts) remaining.set(tab.windowId, (counts = new Map(baseCounts)));
    const key = mirrorKey(tab.url);
    const left = counts.get(key) ?? 0;
    if (left === 0) continue;
    counts.set(key, left - 1);
    mirrors.add(tab);
  }
  return tabs.filter((tab) => !mirrors.has(tab));
}
