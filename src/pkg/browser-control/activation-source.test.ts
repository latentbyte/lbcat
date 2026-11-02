import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTabActivations, consumeTabActivation, markTabActivation } from "./activation-source";

describe("标签激活来源标记", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTabActivations();
  });

  afterEach(() => {
    clearTabActivations();
    vi.useRealTimers();
  });

  it("取出标记后归因一次", () => {
    markTabActivation("switcher", 101);

    expect(consumeTabActivation(101)).toBe("switcher");
    expect(consumeTabActivation(101)).toBeUndefined();
  });

  it("只归因匹配的标签", () => {
    markTabActivation("agent", 101);

    expect(consumeTabActivation(102)).toBeUndefined();
    expect(consumeTabActivation(101)).toBe("agent");
  });

  it("过期标记不再归因", () => {
    markTabActivation("agent", 101);

    vi.advanceTimersByTime(5_001);

    expect(consumeTabActivation(101)).toBeUndefined();
  });

  it("同一标签的多个标记按写入顺序取出", () => {
    markTabActivation("agent", 101);
    markTabActivation("switcher", 101);

    expect(consumeTabActivation(101)).toBe("agent");
    expect(consumeTabActivation(101)).toBe("switcher");
  });
});
