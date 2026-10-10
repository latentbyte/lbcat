import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTab, waitForTabComplete, waitForTabUrl } from "./tab-navigation";

type Listener = (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;

describe("标签导航等待", () => {
  let listeners: Set<Listener>;
  let tab: Partial<chrome.tabs.Tab>;

  function update(change: Partial<chrome.tabs.OnUpdatedInfo>, tabId = 5) {
    if (tabId === 5) Object.assign(tab, change);
    for (const listener of [...listeners]) listener(tabId, change as chrome.tabs.OnUpdatedInfo, tab as chrome.tabs.Tab);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Set();
    tab = { id: 5, status: "complete", url: "https://a.test/", title: "A" };
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn(async () => ({ ...tab })),
        onUpdated: {
          addListener: (listener: Listener) => listeners.add(listener),
          removeListener: (listener: Listener) => listeners.delete(listener),
        },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("导航后等待加载完成而非读取旧页面的 complete 状态", async () => {
    const result = navigateTab(5, async () => {}, { wait: "load", timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(50);
    update({ status: "loading", url: "https://b.test/" });
    await vi.advanceTimersByTimeAsync(50);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    update({ status: "complete", title: "B" });
    await expect(result).resolves.toMatchObject({ navigated: true, tab: { url: "https://b.test/", title: "B" } });
    expect(listeners.size).toBe(0);
  });

  it("其他标签的事件不影响等待", async () => {
    const result = navigateTab(5, async () => {}, { wait: "load", timeoutMs: 5000 });
    update({ status: "loading" }, 6);
    update({ status: "complete" }, 6);
    update({ status: "loading" });
    update({ status: "complete" });
    await expect(result).resolves.toMatchObject({ navigated: true });
  });

  it("点击未触发导航时在短暂观察期后返回且不报告导航", async () => {
    const result = navigateTab(5, async () => {}, { wait: "load", timeoutMs: 5000, settleMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toMatchObject({ navigated: false, tab: { url: "https://a.test/" } });
  });

  it("单页应用仅地址变化也视为导航", async () => {
    const result = navigateTab(5, async () => {}, { wait: "load", timeoutMs: 5000, settleMs: 300 });
    update({ url: "https://a.test/#/next" });
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toMatchObject({ navigated: true, tab: { url: "https://a.test/#/next" } });
  });

  it("加载超时返回 LOAD_TIMEOUT", async () => {
    const result = navigateTab(5, async () => {}, { wait: "load", timeoutMs: 1000 });
    update({ status: "loading" });
    const settled = expect(result).rejects.toMatchObject({ code: "LOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1100);
    await settled;
    expect(listeners.size).toBe(0);
  });

  it("不等待时触发后立即返回当前标签", async () => {
    const trigger = vi.fn(async () => {});
    await expect(navigateTab(5, trigger, { wait: "none", timeoutMs: 5000 })).resolves.toMatchObject({
      tab: { id: 5 },
    });
    expect(trigger).toHaveBeenCalled();
  });

  it("等待加载完成与地址匹配", async () => {
    tab.status = "loading";
    const loaded = waitForTabComplete(5, 5000);
    update({ status: "complete" });
    await expect(loaded).resolves.toMatchObject({ status: "complete" });

    const url = waitForTabUrl(5, /\/done$/, 5000);
    update({ url: "https://a.test/step" });
    update({ url: "https://a.test/done" });
    await expect(url).resolves.toMatchObject({ url: "https://a.test/done" });

    const never = waitForTabUrl(5, /nope/, 500);
    const rejected = expect(never).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(600);
    await rejected;
  });
});
