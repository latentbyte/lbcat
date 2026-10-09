import type { AgentNote } from "./agent-notes";
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

// 弹出页处理代理便签；只接受扩展页面发送
export const AGENT_NOTES_MESSAGE = "browserControl.NOTES";

export type NotesAction =
  | { action: "list"; url: string }
  | { action: "acknowledge" | "resolve" | "remove"; url: string; id: string }
  | { action: "reply"; url: string; id: string; text: string };

export type NotesRequest = { type: typeof AGENT_NOTES_MESSAGE } & NotesAction;

export type NotesResponse = { ok: true; data: AgentNote[] } | { ok: false; error: string };
