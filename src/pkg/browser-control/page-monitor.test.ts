import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPageMonitor } from "./page-monitor";

describe("页面监控钩子", () => {
  const alert = vi.fn();
  const confirm = vi.fn(() => true);
  const prompt = vi.fn(() => "typed");
  const consoleError = vi.fn();
  const consoleWarn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, { alert, confirm, prompt });
    console.error = consoleError;
    console.warn = consoleWarn;
  });
  afterEach(() => {
    runPageMonitor("remove", "pass");
  });

  it("记录控制台错误、未捕获异常与未处理的拒绝，且保留原始输出", () => {
    expect(runPageMonitor("install", "pass")).toEqual({ entries: [], dropped: 0 });
    console.error("bad", { a: 1 });
    console.warn("careful");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("boom"),
        message: "boom",
        filename: "https://a.test/app.js",
        lineno: 3,
        colno: 7,
      })
    );
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "nope" }));
    expect(consoleError).toHaveBeenCalledWith("bad", { a: 1 });
    const drained = runPageMonitor("drain", "pass")!;
    expect(drained.entries).toEqual([
      { time: expect.any(Number), type: "console", level: "error", message: 'bad {"a":1}' },
      { time: expect.any(Number), type: "console", level: "warn", message: "careful" },
      {
        time: expect.any(Number),
        type: "error",
        level: "error",
        message: expect.stringContaining("TypeError: boom"),
        url: "https://a.test/app.js:3:7",
      },
      { time: expect.any(Number), type: "rejection", level: "error", message: "nope" },
    ]);
    expect(runPageMonitor("drain", "pass")).toEqual({ entries: [], dropped: 0 });
  });

  it("按模式处理对话框，pass 时仍交给浏览器", () => {
    runPageMonitor("install", "dismiss");
    expect(window.confirm("Leave?")).toBe(false);
    expect(window.prompt("Name?", "x")).toBeNull();
    window.alert("Hi");
    expect(alert).not.toHaveBeenCalled();
    runPageMonitor("install", "accept");
    expect(window.confirm("Leave?")).toBe(true);
    expect(window.prompt("Name?", "x")).toBe("x");
    runPageMonitor("install", "pass");
    expect(window.prompt("Name?")).toBe("typed");
    expect(runPageMonitor("drain", "pass")!.entries.map((entry) => entry.message)).toEqual([
      "confirm: Leave? -> false",
      "prompt: Name? -> null",
      "alert: Hi",
      "confirm: Leave? -> true",
      'prompt: Name? -> "x"',
      "prompt: Name? -> (shown to user)",
    ]);
  });

  it("移除后恢复原始函数，超出上限时丢弃最早条目并计数", () => {
    runPageMonitor("install", "pass");
    for (let i = 0; i < 505; i++) console.error(`e${i}`);
    const drained = runPageMonitor("remove", "pass")!;
    expect(drained.entries).toHaveLength(500);
    expect(drained.entries[0].message).toBe("e5");
    expect(drained.dropped).toBe(5);
    expect(console.error).toBe(consoleError);
    expect(window.alert).toBe(alert);
    expect(runPageMonitor("drain", "pass")).toBeNull();
  });
});
