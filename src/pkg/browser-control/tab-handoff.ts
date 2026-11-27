import type { TabAccessView, TabGrant } from "./agent-window";

export type TabHandoff = {
  browserName: string;
  // 弹出页为这次交接准备好的任务
  sessionId: string;
  tabId: number;
  title?: string;
  url?: string;
};

// 复制前需要补上的授权；标签已可被代理访问时返回 undefined
export function grantForHandoff(view: Pick<TabAccessView, "grant" | "inAgentWindow">): TabGrant | undefined {
  if (view.grant ? view.grant.mode !== "off" : view.inAgentWindow) return undefined;
  return { mode: "all" };
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

// 粘贴给代理的说明：指向这个已授权的标签和现成的任务，避免代理另开任务、窗口或标签
export function agentTabHandoff({ browserName, sessionId, tabId, title, url }: TabHandoff): string {
  const session = `${browserName}:${sessionId}`;
  const lines = [
    "Use this existing tab in my browser. I granted agent access to it in LBcat and a task session is ready.",
    "Do not run `session begin` or create an agent window for it.",
    "Do not open this URL in a new tab or window, and do not navigate another tab to it.",
    "",
    `Browser: ${browserName}`,
    `Tab ID: ${tabId}`,
    `Session: ${session}`,
  ];
  if (title) lines.push(`Title: ${oneLine(title)}`);
  if (url) lines.push(`URL: ${url}`);
  lines.push(
    "",
    "With the browser-control skill (bctl):",
    `  bctl --session ${session} page content ${tabId}`,
    `Pass --session ${session} and tab ID ${tabId} to page, capture and guide commands. No --personal-tab flag is needed.`,
    "Both stay valid until the tab closes, the browser restarts, or the session sits unused for 4 hours.",
    "If they stop working, ask me for a fresh copy. Leave the tab open when you finish."
  );
  return lines.join("\n");
}
