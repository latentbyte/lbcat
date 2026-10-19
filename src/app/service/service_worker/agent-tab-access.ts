// 代理标签可视化与用户访问控制：徽标、页面边框、弹出页授权、页面内停止按钮以及代理便签

import { endGuide, endSessionGuides } from "./agent-guide";
import { agentNotesService, noteUrl } from "@App/pkg/browser-control/agent-notes";
import { agentWindowService } from "@App/pkg/browser-control/agent-window";
import {
  AGENT_OVERLAY_CORNER_KEY,
  type OverlayCorner,
  renderAgentOverlay,
  TabIndicatorController,
} from "@App/pkg/browser-control/tab-indicator";
import {
  AGENT_NOTES_MESSAGE,
  AGENT_STOP_TAB_MESSAGE,
  AGENT_TAB_ACCESS_MESSAGE,
  type NotesRequest,
  type NotesResponse,
  type TabAccessRequest,
  type TabAccessResponse,
} from "@App/pkg/browser-control/tab-access-message";

export const agentTabIndicators = new TabIndicatorController(
  {
    setBadge: async (tabId, { text, color, title }) => {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setBadgeBackgroundColor({ tabId, color }),
        chrome.action.setTitle({ tabId, title }),
      ]);
    },
    setOverlay: async (tabId, overlay) => {
      const tab = await chrome.tabs.get(tabId);
      if (!/^https?:/.test(tab.url ?? "")) return;
      const stored = await chrome.storage.local.get(AGENT_OVERLAY_CORNER_KEY);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: renderAgentOverlay,
        args: [
          overlay,
          {
            stopMessage: AGENT_STOP_TAB_MESSAGE,
            corner: stored[AGENT_OVERLAY_CORNER_KEY] as OverlayCorner | undefined,
            cornerKey: AGENT_OVERLAY_CORNER_KEY,
          },
        ],
      });
    },
  },
  { text: "", color: "#000000", title: "LBCat" }
);

const warn = (...args: unknown[]) => console.warn("[agent-tab-access]", ...args);

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

// 租约到期不会写入存储，按最早到期时间主动刷新标识
function scheduleExpiryRefresh() {
  clearTimeout(expiryTimer);
  const next = agentTabIndicators.nextExpiry();
  if (next === undefined) return;
  expiryTimer = setTimeout(
    () => {
      agentWindowService.currentIndicators().catch(warn);
    },
    Math.max(0, next - Date.now()) + 50
  );
}

async function handleTabAccess(request: TabAccessRequest): Promise<TabAccessResponse> {
  switch (request.action) {
    case "grant":
      await agentWindowService.setTabGrant(request.tabId, request.grant);
      if (request.grant?.mode === "off") endGuide(request.tabId);
      break;
    case "release":
      await agentWindowService.releaseTab(request.tabId);
      break;
    case "pause":
      await agentWindowService.pauseSession(request.sessionId);
      break;
    case "resume":
      await agentWindowService.resumeSession(request.sessionId);
      break;
    case "end":
      await agentWindowService.closeSession(request.sessionId);
      endSessionGuides(request.sessionId);
      break;
  }
  return { ok: true, data: await agentWindowService.tabAccess(request.tabId) };
}

async function handleNotes(request: NotesRequest): Promise<NotesResponse> {
  switch (request.action) {
    case "acknowledge":
      await agentNotesService.acknowledge(request.id);
      break;
    case "reply":
      await agentNotesService.reply(request.id, request.text);
      break;
    case "resolve":
      await agentNotesService.resolve(request.id);
      break;
    case "remove":
      await agentNotesService.remove(request.id);
      break;
  }
  return { ok: true, data: await agentNotesService.list({ url: request.url }) };
}

// 便签按网址保存，徽标按标签当前网址统计未读数量
async function refreshNoteBadges() {
  const counts = new Map<string, number>();
  for (const note of await agentNotesService.list({ status: "open" })) {
    counts.set(note.url, (counts.get(note.url) ?? 0) + 1);
  }
  const tabs = counts.size ? await chrome.tabs.query({}) : [];
  const byTab = new Map<number, number>();
  for (const tab of tabs) {
    const count = tab.id !== undefined && tab.url ? counts.get(noteUrl(tab.url)) : undefined;
    if (count) byTab.set(tab.id!, count);
  }
  agentTabIndicators.setNotes(byTab);
}

function respondWith<T>(promise: Promise<T>, sendResponse: (response: T | { ok: false; error: string }) => void) {
  promise.then(sendResponse, (error: unknown) =>
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));
}

export function initAgentTabAccess() {
  agentWindowService.subscribe((indicators) => {
    agentTabIndicators.apply(indicators);
    scheduleExpiryRefresh();
  });
  agentWindowService.currentIndicators().catch(warn);
  agentNotesService.subscribe(() => {
    refreshNoteBadges().catch(warn);
  });
  refreshNoteBadges().catch(warn);

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) refreshNoteBadges().catch(warn);
    if (changeInfo.status === "complete") agentTabIndicators.refresh(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    agentTabIndicators.forget(tabId);
    agentWindowService.forgetTab(tabId).catch(warn);
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const type = (message as { type?: string } | null)?.type;
    if (type === AGENT_STOP_TAB_MESSAGE) {
      // 页面覆盖层只能关闭自身所在标签的访问，不能授予权限
      const tabId = sender.tab?.id;
      if (sender.id !== chrome.runtime.id || tabId === undefined) return undefined;
      agentWindowService
        .setTabGrant(tabId, { mode: "off" })
        .then(() => endGuide(tabId))
        .catch(warn);
      return undefined;
    }
    if (!isExtensionPage(sender)) return undefined;
    if (type === AGENT_TAB_ACCESS_MESSAGE) {
      respondWith(handleTabAccess(message as TabAccessRequest), sendResponse);
      return true;
    }
    if (type === AGENT_NOTES_MESSAGE) {
      respondWith(handleNotes(message as NotesRequest), sendResponse);
      return true;
    }
    return undefined;
  });
}
