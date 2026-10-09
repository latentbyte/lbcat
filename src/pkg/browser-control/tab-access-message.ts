import type { TabAccessView, TabGrant } from "./agent-window";

// 弹出页与后台之间的标签访问控制消息；页面内覆盖层只能发送 STOP_TAB
export const AGENT_TAB_ACCESS_MESSAGE = "browserControl.TAB_ACCESS";
export const AGENT_STOP_TAB_MESSAGE = "browserControl.STOP_TAB";

export type TabAccessAction =
  | { action: "get"; tabId: number }
  | { action: "grant"; tabId: number; grant?: TabGrant }
  | { action: "release"; tabId: number }
  | { action: "pause" | "resume" | "end"; tabId: number; sessionId: string };

export type TabAccessRequest = { type: typeof AGENT_TAB_ACCESS_MESSAGE } & TabAccessAction;

export type TabAccessResponse = { ok: true; data: TabAccessView } | { ok: false; error: string };
