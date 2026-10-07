import type { ToolDefinition } from "@App/app/service/agent/core/types";
import type { ToolExecutor } from "@App/app/service/agent/core/tool_registry";
import type { MessageSend } from "@Packages/message/types";
import { extractHtmlWithSelectors } from "@App/app/service/offscreen/client";
import { AgentTaskWindowScope } from "@App/pkg/browser-control/agent-window";
import type { AgentBrowserTaskScope } from "@App/pkg/browser-control/agent-window";
import { assertDomUrlAllowed } from "@App/app/service/agent/service_worker/dom_policy";
import { stripHtmlTags } from "./web_fetch";
import { requireNumber, requireString, optionalString, optionalNumber, optionalBoolean } from "./param_utils";

// ---- Tool Definitions ----

const GET_TAB_CONTENT_DEFINITION: ToolDefinition = {
  name: "get_tab_content",
  description:
    "Read page content and extract information via LLM. Returns markdown with CSS selector annotations (as `<!-- selector -->` comments) for key elements. " +
    "Use this BEFORE execute_script to understand page structure and discover correct selectors. " +
    "Provide a prompt describing what to extract — e.g., 'find the title input, content editor, and submit button — return their CSS selectors and current state'. " +
    "Use selector parameter to narrow scope to a specific section.",
  parameters: {
    type: "object",
    properties: {
      tab_id: { type: "number", description: "Target tab ID (use list_tabs to find)" },
      prompt: {
        type: "string",
        description:
          "Describe what information to extract/summarize from the page content. Required for efficient context usage.",
      },
      selector: {
        type: "string",
        description: "CSS selector to extract only matching element's content (e.g. '#main', '.article-body')",
      },
      max_length: { type: "number", description: "Max characters to return (default: no limit)" },
    },
    required: ["tab_id", "prompt"],
  },
};

const LIST_TABS_DEFINITION: ToolDefinition = {
  name: "list_tabs",
  description: "List available tabs in the registered agent window with their IDs, URLs, titles, and status.",
  parameters: {
    type: "object",
    properties: {
      url_pattern: { type: "string", description: "Regex pattern to filter tabs by URL" },
      title_pattern: { type: "string", description: "Regex pattern to filter tabs by title" },
      active: { type: "boolean", description: "Filter by active/inactive state" },
      window_id: { type: "number", description: "Filter by window ID" },
      audible: { type: "boolean", description: "Filter tabs playing audio" },
    },
  },
};

const OPEN_TAB_DEFINITION: ToolDefinition = {
  name: "open_tab",
  description:
    "Open a background tab in the registered agent window or navigate an available agent-window tab to a URL. " +
    "If tab_id is provided, navigates that tab; otherwise opens a new tab. Waits for page load by default when navigating.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open" },
      tab_id: { type: "number", description: "Existing tab ID to navigate (omit to open a new tab)" },
      active: {
        type: "boolean",
        description: "Whether to activate the tab (default: false; foreground access requires operator permission)",
      },
      window_id: { type: "number", description: "Window to open the tab in (only for new tabs)" },
      wait_until_loaded: {
        type: "boolean",
        description: "Wait for page to finish loading when navigating existing tab (default: true)",
      },
    },
    required: ["url"],
  },
};

const CLOSE_TAB_DEFINITION: ToolDefinition = {
  name: "close_tab",
  description: "Close a tab available to this browser task in the registered agent window.",
  parameters: {
    type: "object",
    properties: {
      tab_id: { type: "number", description: "Tab ID to close" },
    },
    required: ["tab_id"],
  },
};

const ACTIVATE_TAB_DEFINITION: ToolDefinition = {
  name: "activate_tab",
  description:
    "Request tab activation. Foreground access requires explicit operator permission through browser control.",
  parameters: {
    type: "object",
    properties: {
      tab_id: { type: "number", description: "Tab ID to activate" },
    },
    required: ["tab_id"],
  },
};

// ---- Factory ----

export function createTabTools(deps: {
  sender: MessageSend;
  summarize: (content: string, prompt: string) => Promise<string>;
  windowScope?: AgentBrowserTaskScope;
}): { tools: Array<{ definition: ToolDefinition; executor: ToolExecutor }> } {
  const { sender, summarize, windowScope = new AgentTaskWindowScope() } = deps;

  const getTabContentExecutor: ToolExecutor = {
    execute: async (args: Record<string, unknown>) => {
      const tabId = requireNumber(args, "tab_id");
      const prompt = args.prompt as string | undefined;
      const selector = optionalString(args, "selector");
      const maxLength = optionalNumber(args, "max_length");

      // 校验目标 tab URL 是否允许操作
      const tabInfo = await windowScope.assertWindowTab(tabId);
      assertDomUrlAllowed(tabInfo.url || "");

      // 注入脚本获取页面 HTML
      const removeTags = ["script", "style", "noscript", "svg", "link[rel=stylesheet]", "iframe"];

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (opts: { selector?: string; removeTags: string[] }) => {
          const root = opts.selector ? document.querySelector(opts.selector) : document.documentElement;
          if (!root) {
            return {
              html: null,
              title: document.title,
              url: location.href,
              error: `Element not found: ${opts.selector}`,
            };
          }
          const clone = root.cloneNode(true) as Element;
          for (const tag of opts.removeTags) {
            clone.querySelectorAll(tag).forEach((el) => el.remove());
          }
          return { html: clone.outerHTML, title: document.title, url: location.href };
        },
        args: [{ selector, removeTags }],
        world: "MAIN" as chrome.scripting.ExecutionWorld,
      });

      if (!results || results.length === 0) {
        throw new Error("Failed to read tab content");
      }

      const pageData = results[0].result as { html: string | null; title: string; url: string; error?: string };

      if (pageData.error || !pageData.html) {
        return JSON.stringify({
          tab_id: tabId,
          url: pageData.url,
          title: pageData.title,
          content: pageData.error || "No content",
          truncated: false,
          used_selector: selector || null,
        });
      }

      // 通过 Offscreen 提取 markdown（带 selector 标注）
      let content: string;
      try {
        const extracted = await extractHtmlWithSelectors(sender, pageData.html);
        content = extracted && extracted.length > 20 ? extracted : pageData.html;
      } catch {
        // 降级：简单去标签
        content = stripHtmlTags(pageData.html);
      }

      // 截断
      let truncated = false;
      if (maxLength != null && content.length > maxLength) {
        content = content.slice(0, maxLength);
        truncated = true;
      }

      // LLM 摘要
      if (prompt) {
        content = await summarize(content, prompt);
        truncated = false; // 摘要后不再截断
      }

      return JSON.stringify({
        tab_id: tabId,
        url: pageData.url,
        title: pageData.title,
        content,
        truncated,
        used_selector: selector || null,
      });
    },
  };

  const listTabsExecutor: ToolExecutor = {
    execute: async (args: Record<string, unknown>) => {
      const urlPattern = optionalString(args, "url_pattern");
      const titlePattern = optionalString(args, "title_pattern");
      const active = optionalBoolean(args, "active");
      const windowId = optionalNumber(args, "window_id");
      const audible = optionalBoolean(args, "audible");

      const scope = await windowScope.status();
      if (windowId !== undefined && windowId !== scope.windowId) {
        throw new Error("TAB_OUTSIDE_AGENT_WINDOW: requested window is not the registered agent window");
      }
      let tabs = (await windowScope.listTabs()).filter(
        (tab) =>
          (active === undefined || tab.active === active) && (audible === undefined || Boolean(tab.audible) === audible)
      );

      // 正则过滤
      if (urlPattern) {
        let re: RegExp;
        try {
          re = new RegExp(urlPattern, "i");
        } catch {
          throw new Error(`Invalid url_pattern regex: "${urlPattern}"`);
        }
        tabs = tabs.filter((t) => re.test(t.url || ""));
      }
      if (titlePattern) {
        let re: RegExp;
        try {
          re = new RegExp(titlePattern, "i");
        } catch {
          throw new Error(`Invalid title_pattern regex: "${titlePattern}"`);
        }
        tabs = tabs.filter((t) => re.test(t.title || ""));
      }

      return JSON.stringify(
        tabs
          .filter((t) => t.id != null)
          .map((t) => ({
            id: t.id,
            url: t.url || "",
            title: t.title || "",
            active: t.active || false,
            windowId: t.windowId,
            index: t.index,
            audible: t.audible || false,
            status: t.status || "unknown",
          }))
      );
    },
  };

  const openTabExecutor: ToolExecutor = {
    execute: async (args: Record<string, unknown>) => {
      const url = requireString(args, "url");
      const tabId = optionalNumber(args, "tab_id");
      if (optionalBoolean(args, "active", false)) {
        throw new Error("FOREGROUND_PERMISSION_REQUIRED: ask the operator to allow foreground access");
      }
      const scope = await windowScope.status();
      const requestedWindowId = optionalNumber(args, "window_id");
      if (requestedWindowId !== undefined && requestedWindowId !== scope.windowId) {
        throw new Error("TAB_OUTSIDE_AGENT_WINDOW: requested window is not the registered agent window");
      }
      assertDomUrlAllowed(url);

      // 有 tab_id → 导航已有标签页
      if (tabId != null) {
        const waitUntilLoaded = optionalBoolean(args, "wait_until_loaded", true)!;

        await windowScope.assertWindowTab(tabId);
        await chrome.tabs.update(tabId, { url });

        if (waitUntilLoaded) {
          await new Promise<void>((resolve) => {
            const timerId = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 30_000);
            const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
              if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timerId);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }

        const tab = await chrome.tabs.get(tabId);
        return JSON.stringify({
          id: tab.id,
          url: tab.url || tab.pendingUrl || url,
          title: tab.title || "",
          status: tab.status || "unknown",
        });
      }

      // 无 tab_id → 开新标签页
      const tab = await windowScope.createTab(url);
      return JSON.stringify({
        id: tab.id,
        url: tab.url || tab.pendingUrl || url,
        title: tab.title || "",
        windowId: tab.windowId,
        index: tab.index,
      });
    },
  };

  const closeTabExecutor: ToolExecutor = {
    execute: async (args: Record<string, unknown>) => {
      const tabId = requireNumber(args, "tab_id");
      await windowScope.assertWindowTab(tabId);
      await chrome.tabs.remove(tabId);
      return JSON.stringify({ success: true, tab_id: tabId });
    },
  };

  const activateTabExecutor: ToolExecutor = {
    execute: async (args: Record<string, unknown>) => {
      requireNumber(args, "tab_id");
      throw new Error("FOREGROUND_PERMISSION_REQUIRED: ask the operator to allow foreground access");
    },
  };

  return {
    tools: [
      { definition: GET_TAB_CONTENT_DEFINITION, executor: getTabContentExecutor },
      { definition: LIST_TABS_DEFINITION, executor: listTabsExecutor },
      { definition: OPEN_TAB_DEFINITION, executor: openTabExecutor },
      { definition: CLOSE_TAB_DEFINITION, executor: closeTabExecutor },
      { definition: ACTIVATE_TAB_DEFINITION, executor: activateTabExecutor },
    ],
  };
}
