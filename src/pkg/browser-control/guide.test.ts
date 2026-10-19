import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideService, type GuideStep } from "./guide";

const step: GuideStep = {
  text: "Copy the key, then tick both boxes",
  marks: [
    { ref: "e1", label: "copy this" },
    { ref: "e2", label: "1" },
  ],
};

describe("引导模式", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("每一步编号递增，等待返回人工点击的下一步与回复", async () => {
    const guide = new GuideService();
    expect(guide.begin(1, step)).toBe(1);
    const waiting = guide.wait(1, 60_000);
    guide.record(1, 1, { kind: "next", reply: "  done  " });
    await expect(waiting).resolves.toEqual({ step: 1, action: "next", reply: "done", interactions: [] });
    expect(guide.begin(1, step)).toBe(2);
    expect(guide.current(1)).toMatchObject({ id: 2, text: step.text });
  });

  it("等待开始前发生的操作不会丢失", async () => {
    const guide = new GuideService();
    guide.begin(1, step);
    guide.record(1, 1, { kind: "interaction", ref: "e2", event: "click" });
    guide.record(1, 1, { kind: "talk" });
    await expect(guide.wait(1, 60_000)).resolves.toEqual({
      step: 1,
      action: "talk",
      interactions: [{ ref: "e2", label: "1", event: "click" }],
    });
  });

  it("超时只带回期间的标注交互，界面保留，继续等待时不重复返回", async () => {
    vi.useFakeTimers();
    const guide = new GuideService();
    guide.begin(1, step);
    const first = guide.wait(1, 1_000);
    guide.record(1, 1, { kind: "interaction", ref: "e1", event: "click" });
    vi.advanceTimersByTime(1_000);
    await expect(first).resolves.toEqual({
      step: 1,
      action: "timeout",
      interactions: [{ ref: "e1", label: "copy this", event: "click" }],
    });
    const second = guide.wait(1, 1_000);
    guide.record(1, 1, { kind: "reply", reply: "I don't see it" });
    await expect(second).resolves.toEqual({ step: 1, action: "reply", reply: "I don't see it", interactions: [] });
  });

  it("忽略旧步骤、未知标注与空回复", async () => {
    vi.useFakeTimers();
    const guide = new GuideService();
    guide.begin(1, step);
    guide.begin(1, step);
    guide.record(1, 1, { kind: "next" });
    guide.record(1, 2, { kind: "interaction", ref: "e9", event: "click" });
    guide.record(1, 2, { kind: "reply", reply: "   " });
    guide.record(2, 1, { kind: "next" });
    const waiting = guide.wait(1, 500);
    vi.advanceTimersByTime(500);
    await expect(waiting).resolves.toEqual({ step: 2, action: "timeout", interactions: [] });
  });

  it("页面导航与标签关闭会结束等待", async () => {
    const guide = new GuideService();
    guide.begin(1, step);
    guide.navigated(1, "https://example.com/next");
    await expect(guide.wait(1, 60_000)).resolves.toEqual({
      step: 1,
      action: "navigated",
      url: "https://example.com/next",
      interactions: [],
    });
    const waiting = guide.wait(1, 60_000);
    guide.close(1);
    await expect(waiting).resolves.toEqual({ step: 1, action: "closed", interactions: [] });
    expect(guide.current(1)).toBeUndefined();
  });

  it("未开始引导时等待报错，清除后同样报错，新的等待取代旧的等待", async () => {
    vi.useFakeTimers();
    const guide = new GuideService();
    await expect(guide.wait(1, 1_000)).rejects.toMatchObject({ code: "GUIDE_NOT_STARTED" });
    guide.begin(1, step);
    const stale = guide.wait(1, 60_000);
    const fresh = guide.wait(1, 60_000);
    await expect(stale).resolves.toMatchObject({ action: "timeout" });
    guide.record(1, 1, { kind: "next" });
    await expect(fresh).resolves.toMatchObject({ action: "next" });
    guide.close(1);
    await expect(guide.wait(1, 1_000)).rejects.toMatchObject({ code: "GUIDE_NOT_STARTED" });
  });

  it("按会话列出引导所在标签，新步骤归属最新的会话", () => {
    const guide = new GuideService();
    guide.begin(1, step, "s1");
    guide.begin(2, step, "s2");
    guide.begin(3, step, "s1");
    guide.begin(4, step);
    expect(guide.owned("s1")).toEqual([1, 3]);
    guide.begin(3, step, "s2");
    expect(guide.owned("s1")).toEqual([1]);
    guide.close(1);
    expect(guide.owned("s1")).toEqual([]);
  });
});
