// AgentDomService — DOM 操作核心逻辑，在 Service Worker 中运行
// 默认模式通过 chrome.scripting.executeScript 操作
// trusted 模式通过 chrome.debugger CDP 操作

import type {
  TabInfo,
  ActionResult,
  PageContent,
  ReadPageOptions,
  DomActionOptions,
  ScreenshotOptions,
  ScreenshotResult,
  NavigateOptions,
  ScrollDirection,
  ScrollOptions,
  ScrollResult,
  NavigateResult,
  WaitForOptions,
  WaitForResult,
  DomApiRequest,
  ExecuteScriptOptions,
} from "@App/app/service/agent/core/types";
import { decodeDataUrl, writeWorkspaceFile } from "@App/app/service/agent/core/opfs_helpers";
import { assertDomUrlAllowed } from "./dom_policy";
import { AgentTaskWindowScope } from "@App/pkg/browser-control/agent-window";
import type { AgentBrowserTaskScope } from "@App/pkg/browser-control/agent-window";
import { captureNativeTab } from "@App/pkg/browser-control/capture";

type ReadPageInjectedOptions = {
  selector: string | undefined | null;
  maxLength: number;
  removeTags: string[];
};
import type { MonitorResult, MonitorStatus } from "@App/app/service/agent/core/types";
import { withDebugger, cdpClick, cdpFill, cdpStartMonitor, cdpStopMonitor, cdpPeekMonitor } from "./dom_cdp";

export class AgentDomService {
  constructor(private readonly windowScope: AgentBrowserTaskScope = new AgentTaskWindowScope()) {}

  // 列出代理窗口标签页
  async listTabs(): Promise<TabInfo[]> {
    const tabs = await this.windowScope.listTabs();
    return tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({
        tabId: t.id!,
        url: t.url || "",
        title: t.title || "",
        active: t.active || false,
        windowId: t.windowId,
        discarded: t.discarded || false,
      }));
  }

  // 导航到 URL
  async navigate(url: string, options?: NavigateOptions): Promise<NavigateResult> {
    // 校验目标 URL 是否在黑名单中
    assertDomUrlAllowed(url);
    const timeout = options?.timeout ?? 30000;
    const waitUntil = options?.waitUntil ?? true;

    let tabId: number;
    if (options?.tabId !== undefined) {
      await this.windowScope.assertWindowTab(options.tabId);
      await chrome.tabs.update(options.tabId, { url });
      tabId = options.tabId;
    } else {
      const tab = await this.windowScope.createTab(url);
      tabId = tab.id!;
    }

    if (waitUntil) {
      await this.waitForPageLoad(tabId, timeout);
    }

    const tab = await chrome.tabs.get(tabId);
    return {
      tabId,
      url: tab.url || url,
      title: tab.title || "",
    };
  }

  // 读取页面内容，返回原始 HTML
  async readPage(options?: ReadPageOptions): Promise<PageContent> {
    const tabId = await this.resolveTabId(options?.tabId);
    const maxLength = options?.maxLength ?? 200000;
    const selector = options?.selector;
    const removeTags = options?.removeTags ?? ["script", "style", "noscript", "svg", "link[rel=stylesheet]"];

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: readPageContent,
      args: [{ selector, maxLength, removeTags } as ReadPageInjectedOptions],
      world: "ISOLATED",
    });

    if (!results || results.length === 0) {
      throw new Error("Failed to read page content");
    }

    return results[0].result as PageContent;
  }

  // 截图
  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const tabId = await this.resolveTabId(options?.tabId);
    const { dataUrl } = await captureNativeTab(
      tabId,
      {
        format: "jpeg",
        quality: options?.quality ?? 80,
        ...(options?.selector ? { selector: options.selector } : {}),
        ...(options?.fullPage ? { fullPage: true } : {}),
      },
      async () => {
        await this.windowScope.assertWindowTab(tabId);
      }
    );

    const result: ScreenshotResult = { dataUrl };

    // saveTo: 将截图保存到 OPFS workspace
    if (options?.saveTo) {
      const { data } = decodeDataUrl(dataUrl);
      const saved = await writeWorkspaceFile(options.saveTo, data);
      result.path = saved.path;
      result.size = saved.size;
    }

    return result;
  }

  // 点击元素
  async click(selector: string, options?: DomActionOptions): Promise<ActionResult> {
    const tabId = await this.resolveTabId(options?.tabId);

    if (options?.trusted) {
      try {
        return await withDebugger(tabId, (id) => cdpClick(id, selector));
      } catch (e) {
        console.error("[AgentDom] CDP click failed, falling back to non-trusted mode", {
          tabId,
          selector,
          error: e instanceof Error ? e.message : e,
        });
      }
    }

    return this.executeClick(tabId, selector);
  }

  // 填写表单
  async fill(selector: string, value: string, options?: DomActionOptions): Promise<ActionResult> {
    const tabId = await this.resolveTabId(options?.tabId);

    if (options?.trusted) {
      try {
        return await withDebugger(tabId, (id) => cdpFill(id, selector, value));
      } catch (e) {
        console.error("[AgentDom] CDP fill failed, falling back to non-trusted mode", {
          tabId,
          selector,
          error: e instanceof Error ? e.message : e,
        });
      }
    }

    return this.executeFill(tabId, selector, value);
  }

  // 滚动页面
  async scroll(direction: ScrollDirection, options?: ScrollOptions): Promise<ScrollResult> {
    const tabId = await this.resolveTabId(options?.tabId);
    const selector = options?.selector;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: executeScroll,
      args: [direction, selector || null],
      world: "ISOLATED",
    });

    if (!results || results.length === 0) {
      throw new Error("Failed to scroll");
    }

    return results[0].result as ScrollResult;
  }

  // 等待元素出现
  async waitFor(selector: string, options?: WaitForOptions): Promise<WaitForResult> {
    const tabId = await this.resolveTabId(options?.tabId);
    const timeout = options?.timeout ?? 10000;
    const interval = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: checkElement,
        args: [selector],
        world: "ISOLATED",
      });

      if (results?.[0]?.result) {
        return results[0].result as WaitForResult;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return { found: false };
  }

  // 在页面中执行 JavaScript 代码（动态代码必须跑 MAIN world，ISOLATED 会被扩展 CSP 拦截 new Function）
  async executeScript(code: string, options?: ExecuteScriptOptions): Promise<{ result: unknown; tabId: number }> {
    const tabId = await this.resolveTabId(options?.tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (codeStr: string) => {
        // 用 Function 构造器执行代码，支持 return 返回值
        const fn = new Function(codeStr);
        return fn();
      },
      args: [code],
      world: "MAIN",
    });

    if (!results || results.length === 0) {
      throw new Error("Failed to execute script");
    }

    return { result: results[0].result, tabId };
  }

  // 启动页面监控（CDP：dialog 自动处理 + MutationObserver）
  async startMonitor(tabId: number): Promise<void> {
    await this.resolveTabId(tabId);
    return cdpStartMonitor(tabId);
  }

  // 停止监控并返回收集的结果
  async stopMonitor(tabId: number): Promise<MonitorResult> {
    await this.resolveTabId(tabId);
    return cdpStopMonitor(tabId);
  }

  // 查询当前 monitor 状态（不停止监控）
  async peekMonitor(tabId: number): Promise<MonitorStatus> {
    await this.resolveTabId(tabId);
    return cdpPeekMonitor(tabId);
  }

  // 处理 GM API 请求路由
  async handleDomApi(request: DomApiRequest): Promise<unknown> {
    switch (request.action) {
      case "listTabs":
        return this.listTabs();
      case "navigate":
        return this.navigate(request.url, request.options);
      case "readPage":
        return this.readPage(request.options);
      case "screenshot":
        return this.screenshot(request.options);
      case "click":
        return this.click(request.selector, request.options);
      case "fill":
        return this.fill(request.selector, request.value, request.options);
      case "scroll":
        return this.scroll(request.direction, request.options);
      case "waitFor":
        return this.waitFor(request.selector, request.options);
      case "executeScript":
        return this.executeScript(request.code, request.options);
      case "startMonitor":
        return this.startMonitor(request.tabId);
      case "stopMonitor":
        return this.stopMonitor(request.tabId);
      case "peekMonitor":
        return this.peekMonitor(request.tabId);
      default:
        throw new Error(`Unknown DOM action: ${(request as any).action}`);
    }
  }

  // ---- 辅助方法 ----

  // 必须显式指定代理窗口内的标签页，避免误操作个人活动标签
  private async resolveTabId(tabId?: number): Promise<number> {
    if (tabId === undefined) {
      throw new Error("TAB_ID_REQUIRED: choose an agent-window tab from listTabs");
    }
    const tab = await this.windowScope.assertWindowTab(tabId);
    assertDomUrlAllowed(tab.url || "");
    if (tab.discarded) {
      await chrome.tabs.reload(tabId);
      await this.waitForPageLoad(tabId, 30000);
    }
    return tabId;
  }

  // 等待页面加载完成
  private waitForPageLoad(tabId: number, timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Page load timed out"));
      }, timeout);

      const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      // 先检查当前状态
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") {
          clearTimeout(timer);
          resolve();
        } else {
          chrome.tabs.onUpdated.addListener(listener);
        }
      });
    });
  }

  // 默认模式点击
  private async executeClick(tabId: number, selector: string): Promise<ActionResult> {
    const tab = await chrome.tabs.get(tabId);
    const originalUrl = tab.url || "";

    // 监听新 tab 打开
    let newTabInfo: { tabId: number; url: string } | undefined;
    const onCreated = (newTab: chrome.tabs.Tab) => {
      if (newTab.openerTabId === tabId && newTab.id) {
        newTabInfo = { tabId: newTab.id, url: newTab.pendingUrl || newTab.url || "" };
      }
    };
    chrome.tabs.onCreated.addListener(onCreated);

    try {
      // 执行点击
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          (el as HTMLElement).click();
        },
        args: [selector],
        world: "ISOLATED",
      });

      // 等待页面稳定
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 收集结果
      return await this.collectActionResult(tabId, originalUrl, newTabInfo);
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
    }
  }

  // 默认模式填写
  private async executeFill(tabId: number, selector: string, value: string): Promise<ActionResult> {
    const tab = await chrome.tabs.get(tabId);
    const originalUrl = tab.url || "";

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.focus();
        // 清空现有值
        el.value = "";
        // 设置新值
        el.value = val;
        // 触发事件
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      args: [selector, value],
      world: "ISOLATED",
    });

    return {
      success: true,
      url: originalUrl,
    };
  }

  // 收集操作后的状态
  private async collectActionResult(
    tabId: number,
    originalUrl: string,
    newTabInfo?: { tabId: number; url: string }
  ): Promise<ActionResult> {
    let currentUrl = originalUrl;
    try {
      const tab = await chrome.tabs.get(tabId);
      currentUrl = tab.url || originalUrl;
    } catch {
      // tab 可能已关闭
    }

    const navigated = currentUrl !== originalUrl;

    const result: ActionResult = {
      success: true,
      navigated,
      url: currentUrl,
    };

    if (newTabInfo) {
      result.newTab = newTabInfo;
    }

    return result;
  }
}

// ---- 注入到页面中执行的函数 ----

// 读取页面 HTML（注入到页面执行）
function readPageContent(options: ReadPageInjectedOptions): PageContent {
  const { selector, maxLength, removeTags } = options;

  const root = selector ? document.querySelector(selector) : document.documentElement;
  if (!root) {
    return {
      title: document.title,
      url: location.href,
      html: `<error>Element not found: ${selector}</error>`,
    };
  }

  // 克隆节点并移除指定标签
  const clone = root.cloneNode(true) as Element;
  if (removeTags && removeTags.length > 0) {
    for (const tag of removeTags) {
      clone.querySelectorAll(tag).forEach((el) => el.remove());
    }
  }

  const html = clone.outerHTML;
  const result: PageContent = {
    title: document.title,
    url: location.href,
    html,
  };

  if (html.length > maxLength) {
    result.truncated = true;
    result.totalLength = html.length;
    result.html = html.slice(0, maxLength);
  }

  return result;
}

// 滚动操作（注入到页面执行）
function executeScroll(direction: string, selector: string | null): ScrollResult {
  const target = selector ? document.querySelector(selector) : document.documentElement;
  if (!target) throw new Error(`Element not found: ${selector}`);

  const el = selector ? (target as HTMLElement) : document.documentElement;
  const scrollAmount = window.innerHeight * 0.8;

  switch (direction) {
    case "up":
      if (selector) {
        el.scrollBy(0, -scrollAmount);
      } else {
        window.scrollBy(0, -scrollAmount);
      }
      break;
    case "down":
      if (selector) {
        el.scrollBy(0, scrollAmount);
      } else {
        window.scrollBy(0, scrollAmount);
      }
      break;
    case "top":
      if (selector) {
        el.scrollTop = 0;
      } else {
        window.scrollTo(0, 0);
      }
      break;
    case "bottom":
      if (selector) {
        el.scrollTop = el.scrollHeight;
      } else {
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      break;
  }

  const scrollEl = selector ? el : document.documentElement;
  return {
    scrollTop: scrollEl.scrollTop || window.scrollY,
    scrollHeight: scrollEl.scrollHeight,
    clientHeight: scrollEl.clientHeight || window.innerHeight,
    atBottom: scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 10,
  };
}

// 检查元素是否存在（注入到页面执行）
function checkElement(selector: string): WaitForResult | null {
  const el = document.querySelector(selector);
  if (!el) return null;

  const htmlEl = el as HTMLElement;
  const style = window.getComputedStyle(el);
  const visible = style.display !== "none" && style.visibility !== "hidden";

  // 生成选择器
  const getSelector = (e: Element): string => {
    if (e.id) return `#${e.id}`;
    const tag = e.tagName.toLowerCase();
    const parent = e.parentElement;
    if (!parent) return tag;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === e.tagName);
    if (siblings.length === 1) return `${getSelector(parent)} > ${tag}`;
    const index = siblings.indexOf(e) + 1;
    return `${getSelector(parent)} > ${tag}:nth-of-type(${index})`;
  };

  return {
    found: true,
    element: {
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      text: (htmlEl.textContent || "").trim().slice(0, 100),
      role: el.getAttribute("role") || undefined,
      type: el.getAttribute("type") || undefined,
      visible,
    },
  };
}
