export type PageExecResult =
  | { success: true; value: unknown; truncated?: true; totalLength?: number }
  | { success: false; code: string; error: string };

// 通过 executeScript 注入页面主世界：必须自包含，不能引用模块作用域
// compiledKey：页面 CSP 禁止 eval 时，代码已由 userScripts 编译为 globalThis[Symbol.for(compiledKey)]
export async function runPageExec(code: string, maxChars?: number, compiledKey?: string): Promise<PageExecResult> {
  const fail = (failure: string, error: string): PageExecResult => ({ success: false, code: failure, error });
  const AsyncFunction = (async () => {}).constructor as new (body: string) => () => Promise<unknown>;
  // 解析失败不会执行任何代码，可安全换一种形式重试
  const NEEDS_FUNCTION_BODY = /Illegal return|return not in function|await is only valid/i;

  const evaluate = async (): Promise<unknown> => {
    if (compiledKey) return compiled!();
    let expression: (() => Promise<unknown>) | undefined;
    try {
      expression = new AsyncFunction(`return (\n${code.replace(/[\s;]+$/, "")}\n)`);
    } catch {
      // 不是单个表达式，按脚本执行
    }
    if (expression) return expression();
    try {
      return (0, eval)(code);
    } catch (error) {
      if (error instanceof SyntaxError && NEEDS_FUNCTION_BODY.test(error.message)) return new AsyncFunction(code)();
      throw error;
    }
  };

  // 只等待顶层对象或数组成员中的 Promise
  const settle = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await item]));
      return Object.fromEntries(entries);
    }
    return value;
  };

  let compiled: (() => Promise<unknown>) | undefined;
  if (compiledKey) {
    const host = globalThis as unknown as Record<symbol, (() => Promise<unknown>) | undefined>;
    const key = Symbol.for(compiledKey);
    compiled = host[key];
    delete host[key];
    // 源码解析失败时不会写入，由调用方换一种形式重试
    if (typeof compiled !== "function") return fail("NOT_COMPILED", "code did not compile in this form");
  }

  let value: unknown;
  try {
    value = await settle(await evaluate());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof EvalError || /unsafe-eval|Content Security Policy|TrustedScript/i.test(message))
      return fail("CSP_BLOCKED", `page Content Security Policy blocks evaluating code: ${message}`);
    return fail("SCRIPT_ERROR", message);
  }

  let json: string;
  try {
    json =
      JSON.stringify(value ?? null, (key, item: unknown) => {
        const where = key ? ` at "${key}"` : "";
        if (typeof Node !== "undefined" && item instanceof Node) {
          const el = item as Element;
          const label = el.tagName ? `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}>` : item.nodeName;
          throw new TypeError(`DOM node ${label}${where}; return its text, attributes, or a plain object instead`);
        }
        if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint")
          throw new TypeError(`${typeof item}${where} cannot be returned; convert it to a string first`);
        if (item instanceof Map) return Object.fromEntries(item);
        if (item instanceof Set) return Array.from(item);
        return item;
      }) ?? "null";
  } catch (error) {
    return fail("RESULT_NOT_SERIALIZABLE", error instanceof Error ? error.message : String(error));
  }

  const plain: unknown = JSON.parse(json);
  if (maxChars && maxChars > 0) {
    const text = typeof plain === "string" ? plain : json;
    if (text.length > maxChars)
      return { success: true, value: text.slice(0, maxChars), truncated: true, totalLength: text.length };
  }
  return { success: true, value: plain };
}
