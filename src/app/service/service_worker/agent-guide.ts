// 引导模式：在页面绘制步骤卡片与标注，并把人工响应、导航与关闭转交给等待中的代理

import { guideService, type GuidePageEvent } from "@App/pkg/browser-control/guide";
import {
  renderGuideOverlay,
  type GuideOverlayMessage,
  type GuideOverlayView,
} from "@App/pkg/browser-control/guide-overlay";
import { AGENT_GUIDE_MESSAGE } from "@App/pkg/browser-control/tab-access-message";

const warn = (...args: unknown[]) => console.warn("[agent-guide]", ...args);

export async function drawGuide(tabId: number, view: GuideOverlayView | null): Promise<void> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: renderGuideOverlay,
    args: [view, { message: AGENT_GUIDE_MESSAGE }],
  });
  if (injection && "error" in injection && injection.error) {
    const error = injection.error;
    throw new Error(typeof error === "object" && "message" in error ? String(error.message) : String(error));
  }
}

// 代理失去标签访问或会话结束时移除引导，等待中的代理收到 closed
export function endGuide(tabId: number): void {
  if (!guideService.current(tabId)) return;
  guideService.close(tabId);
  drawGuide(tabId, null).catch(warn);
}

export function endSessionGuides(sessionId: string): void {
  for (const tabId of guideService.owned(sessionId)) endGuide(tabId);
}

function isGuideEvent(event: unknown): event is GuidePageEvent {
  const value = event as Partial<Record<string, unknown>> | null;
  if (!value || typeof value !== "object") return false;
  if (value.kind === "interaction")
    return typeof value.ref === "string" && ["click", "input"].includes(value.event as string);
  return (
    ["next", "talk", "reply", "delegate"].includes(value.kind as string) &&
    (value.reply === undefined || typeof value.reply === "string")
  );
}

export function initAgentGuide() {
  // 导航提交时记录当前步骤，加载完成后若代理仍未给出新步骤则显示准备状态
  const redraw = new Map<number, number>();

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    const data = message as Partial<GuideOverlayMessage> | null;
    if (data?.type !== AGENT_GUIDE_MESSAGE) return undefined;
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0) return undefined;
    if (typeof data.stepId === "number" && isGuideEvent(data.event))
      guideService.record(tabId, data.stepId, data.event);
    return undefined;
  });
  const onCommitted = ({ tabId, frameId, url }: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    const step = guideService.current(tabId);
    if (frameId !== 0 || !step) return;
    redraw.set(tabId, step.id);
    guideService.navigated(tabId, url);
  };
  const onCompleted = ({ tabId, frameId }: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
    if (frameId !== 0) return;
    const stepId = redraw.get(tabId);
    redraw.delete(tabId);
    const step = guideService.current(tabId);
    if (!step || step.id !== stepId) return;
    drawGuide(tabId, { stepId: step.id, title: step.title, text: "", marks: [], state: "preparing" }).catch(warn);
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  chrome.webNavigation.onCompleted.addListener(onCompleted);
  chrome.tabs.onRemoved.addListener((tabId) => {
    redraw.delete(tabId);
    guideService.close(tabId);
  });
}
