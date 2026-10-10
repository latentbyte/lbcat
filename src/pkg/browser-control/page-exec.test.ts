import { describe, expect, it } from "vitest";
import { runPageExec } from "./page-exec";

describe("页面脚本执行结果", () => {
  it("表达式直接返回值，对象字面量不被当作代码块", async () => {
    await expect(runPageExec("1 + 1")).resolves.toEqual({ success: true, value: 2 });
    await expect(runPageExec("{a: 1, b: [2]}")).resolves.toEqual({ success: true, value: { a: 1, b: [2] } });
    await expect(runPageExec("document.title = 'T'; document.title;")).resolves.toEqual({ success: true, value: "T" });
  });

  it("支持顶层 await 与 return，且语法错误时代码不被执行两次", async () => {
    await expect(runPageExec("await Promise.resolve(3)")).resolves.toEqual({ success: true, value: 3 });
    const globals = globalThis as { __execRuns?: number };
    globals.__execRuns = 0;
    await expect(
      runPageExec("globalThis.__execRuns++;\nconst x = await Promise.resolve(4);\nreturn x * 2;")
    ).resolves.toEqual({ success: true, value: 8 });
    expect(globals.__execRuns).toBe(1);
    delete globals.__execRuns;
  });

  it("等待返回对象与数组中的 Promise", async () => {
    await expect(runPageExec("({a: Promise.resolve(1), b: 2})")).resolves.toEqual({
      success: true,
      value: { a: 1, b: 2 },
    });
    await expect(runPageExec("[Promise.resolve('x'), 'y']")).resolves.toEqual({ success: true, value: ["x", "y"] });
  });

  it("undefined 映射为 null，Map 与 Set 转为普通结构", async () => {
    await expect(runPageExec("undefined")).resolves.toEqual({ success: true, value: null });
    await expect(runPageExec("new Map([['k', new Set([1, 2])]])")).resolves.toEqual({
      success: true,
      value: { k: [1, 2] },
    });
  });

  it("DOM 节点、函数与循环引用返回 RESULT_NOT_SERIALIZABLE", async () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const node = await runPageExec("({el: document.getElementById('b')})");
    expect(node).toMatchObject({ success: false, code: "RESULT_NOT_SERIALIZABLE" });
    expect((node as { error: string }).error).toContain('<button#b> at "el"');
    await expect(runPageExec("({f: () => 1})")).resolves.toMatchObject({ code: "RESULT_NOT_SERIALIZABLE" });
    await expect(runPageExec("const o = {}; o.self = o; o")).resolves.toMatchObject({
      code: "RESULT_NOT_SERIALIZABLE",
    });
  });

  it("脚本异常返回 SCRIPT_ERROR", async () => {
    await expect(runPageExec("throw new Error('boom')")).resolves.toEqual({
      success: false,
      code: "SCRIPT_ERROR",
      error: "boom",
    });
    await expect(runPageExec("JSON.parse('return')")).resolves.toMatchObject({ code: "SCRIPT_ERROR" });
  });

  it("超过字符上限时截断并报告总长度", async () => {
    await expect(runPageExec("'abcdef'", 3)).resolves.toEqual({
      success: true,
      value: "abc",
      truncated: true,
      totalLength: 6,
    });
    await expect(runPageExec("[1, 2, 3]", 4)).resolves.toEqual({
      success: true,
      value: "[1,2",
      truncated: true,
      totalLength: 7,
    });
    await expect(runPageExec("'ab'", 3)).resolves.toEqual({ success: true, value: "ab" });
  });

  it("使用预编译函数时调用并移除它，缺失时返回 NOT_COMPILED", async () => {
    const key = Symbol.for("bctl.exec.test");
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[key] = async () => ({ answer: Promise.resolve(42) });
    await expect(runPageExec("ignored", 0, "bctl.exec.test")).resolves.toEqual({
      success: true,
      value: { answer: 42 },
    });
    expect(host[key]).toBeUndefined();
    await expect(runPageExec("ignored", 0, "bctl.exec.test")).resolves.toMatchObject({ code: "NOT_COMPILED" });
  });
});
