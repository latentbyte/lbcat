import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guideService } from "@App/pkg/browser-control/guide";
import { AGENT_GUIDE_MESSAGE } from "@App/pkg/browser-control/tab-access-message";
import { initAgentGuide } from "./agent-guide";

type Listener = (...args: never[]) => unknown;

describe("引导模式后台接线", () => {
  const listeners: Record<string, Listener> = {};
  const executeScript = vi.fn();
  const on = (name: string) => ({
    addListener: (listener: Listener) => {
      listeners[name] = listener;
    },
  });
  const message = (body: unknown, sender: Partial<chrome.runtime.MessageSender>) =>
    (listeners.message as (body: unknown, sender: chrome.runtime.MessageSender) => void)(
      body,
      sender as chrome.runtime.MessageSender
    );
  const fromPage = { id: "ext", tab: { id: 5 } as chrome.tabs.Tab, frameId: 0 };

  beforeEach(() => {
    executeScript.mockReset().mockResolvedValue([{ result: undefined }]);
    vi.stubGlobal("chrome", {
      runtime: { id: "ext", onMessage: on("message") },
      webNavigation: { onCommitted: on("committed"), onCompleted: on("completed") },
      tabs: { onRemoved: on("removed") },
      scripting: { executeScript },
    });
    initAgentGuide();
    guideService.begin(5, { text: "Click save", marks: [{ ref: "e1", label: "here" }] });
  });
  afterEach(() => {
    guideService.close(5);
    vi.unstubAllGlobals();
  });

  it("只接受本扩展在标签主框架发出的引导事件", async () => {
    const step = guideService.current(5)!.id;
    const waiting = guideService.wait(5, 60_000);
    message({ type: AGENT_GUIDE_MESSAGE, stepId: step, event: { kind: "next" } }, { ...fromPage, id: "other" });
    message({ type: AGENT_GUIDE_MESSAGE, stepId: step, event: { kind: "next" } }, { ...fromPage, frameId: 2 });
    message({ type: AGENT_GUIDE_MESSAGE, stepId: step, event: { kind: "bogus" } }, fromPage);
    message(
      { type: AGENT_GUIDE_MESSAGE, stepId: step, event: { kind: "interaction", ref: "e1", event: "click" } },
      fromPage
    );
    message({ type: AGENT_GUIDE_MESSAGE, stepId: step, event: { kind: "next", reply: "ok" } }, fromPage);
    await expect(waiting).resolves.toEqual({
      step,
      action: "next",
      reply: "ok",
      interactions: [{ ref: "e1", label: "here", event: "click" }],
    });
  });

  it("主框架导航结束等待，加载完成后在新页面显示准备状态；新步骤已开始时不覆盖", async () => {
    const step = guideService.current(5)!.id;
    (listeners.committed as Listener)({ tabId: 5, frameId: 1, url: "https://a.test/frame" } as never);
    (listeners.committed as Listener)({ tabId: 5, frameId: 0, url: "https://a.test/next" } as never);
    await expect(guideService.wait(5, 60_000)).resolves.toMatchObject({
      action: "navigated",
      url: "https://a.test/next",
    });
    (listeners.completed as Listener)({ tabId: 5, frameId: 0 } as never);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 5 },
        args: [expect.objectContaining({ stepId: step, state: "preparing" }), { message: AGENT_GUIDE_MESSAGE }],
      })
    );
    executeScript.mockClear();
    (listeners.committed as Listener)({ tabId: 5, frameId: 0, url: "https://a.test/again" } as never);
    guideService.begin(5, { text: "next", marks: [] });
    (listeners.completed as Listener)({ tabId: 5, frameId: 0 } as never);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("标签关闭时结束引导", async () => {
    const waiting = guideService.wait(5, 60_000);
    (listeners.removed as Listener)(5 as never);
    await expect(waiting).resolves.toMatchObject({ action: "closed" });
    expect(guideService.current(5)).toBeUndefined();
  });
});
