import type { TabAccessView, TabGrant } from "./agent-window";

export type TabHandoff = {
  browserName: string;
  tabId: number;
  title?: string;
  url?: string;
  // 标签仅限该任务使用时填写
  sessionId?: string;
};

// 复制前需要补上的授权；标签已可被代理访问时返回 undefined
export function grantForHandoff(view: Pick<TabAccessView, "grant" | "inAgentWindow">): TabGrant | undefined {
  if (view.grant ? view.grant.mode !== "off" : view.inAgentWindow) return undefined;
  return { mode: "all" };
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

// 粘贴给代理的说明：指向这个已授权的标签，避免代理另开窗口或标签
export function agentTabHandoff({ browserName, tabId, title, url, sessionId }: TabHandoff): string {
  const handle = sessionId ? `${browserName}:${sessionId}` : undefined;
  const lines = [
    "Use this existing tab in my browser. I already granted agent access to it in LBcat.",
    "Do not open this URL in a new tab or window, and do not navigate another tab to it.",
    "",
    `Browser: ${browserName}`,
    `Tab ID: ${tabId}`,
  ];
  if (title) lines.push(`Title: ${oneLine(title)}`);
  if (url) lines.push(`URL: ${url}`);
  lines.push("", "With the browser-control skill (bctl):");
  if (handle) {
    lines.push(
      `  bctl --session ${handle} page content ${tabId}`,
      "",
      `Access is reserved for task session ${handle}; other sessions get TAB_ACCESS_DENIED.`
    );
  } else {
    lines.push(
      `  bctl --browser ${browserName} session begin --label "<agent>: <task>"   # prints <s>; reuse your session if you have one`,
      `  bctl --session <s> page content ${tabId}`
    );
  }
  lines.push(
    `Pass tab ID ${tabId} to page, capture and guide commands. No --personal-tab flag is needed.`,
    "The ID stays valid until the tab closes or the browser restarts. Leave the tab open when you finish."
  );
  return lines.join("\n");
}
