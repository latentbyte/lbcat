import type { MessageSend } from "@Packages/message/types";
import { AgentTaskWindowScope } from "@App/pkg/browser-control/agent-window";
import type { AgentBrowserTaskScope } from "@App/pkg/browser-control/agent-window";
import { AgentDomService } from "@App/app/service/agent/service_worker/dom";
import type { SessionBuiltinGroup } from "../tool_registry";
import { createTabTools } from "./tab_tools";
import { createExecuteScriptTool } from "./execute_script";

export function createBrowserTaskTools(deps: {
  sender: MessageSend;
  summarize: (content: string, prompt: string) => Promise<string>;
  executeInSandbox: (code: string) => Promise<unknown>;
  windowScope?: AgentBrowserTaskScope & { close(): Promise<void> };
}): SessionBuiltinGroup {
  const windowScope = deps.windowScope ?? new AgentTaskWindowScope();
  const dom = new AgentDomService(windowScope);
  const pageTool = createExecuteScriptTool({
    executeInPage: (code, options) => dom.executeScript(code, options),
    executeInSandbox: deps.executeInSandbox,
  });
  return {
    tools: [...createTabTools({ ...deps, windowScope }).tools, pageTool],
    close: () => windowScope.close(),
  };
}
