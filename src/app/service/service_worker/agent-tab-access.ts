// 代理标签可视化与用户访问控制：徽标、页面边框、弹出页授权以及页面内停止按钮

import { agentWindowService } from "@App/pkg/browser-control/agent-window";
import { renderAgentOverlay, TabIndicatorController } from "@App/pkg/browser-control/tab-indicator";
import {
  AGENT_STOP_TAB_MESSAGE,
  AGENT_TAB_ACCESS_MESSAGE,
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
      await chrome.scripting.executeScript({
        target: { tabId },
        func: renderAgentOverlay,
        args: [overlay, AGENT_STOP_TAB_MESSAGE],
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
      break;
  }
  return { ok: true, data: await agentWindowService.tabAccess(request.tabId) };
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

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
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
      agentWindowService.setTabGrant(tabId, { mode: "off" }).catch(warn);
      return undefined;
    }
    if (type !== AGENT_TAB_ACCESS_MESSAGE || !isExtensionPage(sender)) return undefined;
    handleTabAccess(message as TabAccessRequest).then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });
}
