export type PageFetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxChars?: number;
  timeoutMs: number;
};
export type PageFetchResponse = {
  status: number;
  ok: boolean;
  url: string;
  contentType: string;
  body: string;
  truncated?: boolean;
  totalLength?: number;
};
export type PageFetchResult =
  | { success: true; value: PageFetchResponse }
  | { success: false; code: string; error: string };

// 注入隔离世界：以页面源与 Cookie 发起请求，必须自包含
export async function runPageFetch(request: PageFetchRequest): Promise<PageFetchResult> {
  // Firefox 内容脚本的 fetch 带扩展权限，content.fetch 才以页面身份请求
  const content = (globalThis as { content?: { fetch?: typeof fetch } }).content;
  const pageFetch = content?.fetch ? content.fetch.bind(content) : fetch;
  let url: string;
  try {
    url = new URL(request.url, location.href).href;
  } catch {
    return { success: false, code: "INVALID_ARGUMENT", error: `invalid url: ${request.url}` };
  }
  const headers = { ...request.headers };
  const hasType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  if (request.body !== undefined && !hasType && /^\s*[[{]/.test(request.body))
    headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await pageFetch(url, {
      method: request.method || (request.body !== undefined ? "POST" : "GET"),
      headers,
      body: request.body,
      credentials: "include",
      signal: controller.signal,
    });
    let body = await response.text();
    const totalLength = body.length;
    const maxChars = request.maxChars ?? 0;
    const truncated = maxChars > 0 && totalLength > maxChars;
    if (truncated) body = body.slice(0, maxChars);
    return {
      success: true,
      value: {
        status: response.status,
        ok: response.ok,
        url: response.url || url,
        contentType: response.headers.get("content-type") ?? "",
        body,
        ...(truncated ? { truncated: true, totalLength } : {}),
      },
    };
  } catch (error) {
    if (controller.signal.aborted)
      return { success: false, code: "FETCH_TIMEOUT", error: `${url} did not respond within ${request.timeoutMs}ms` };
    return {
      success: false,
      code: "FETCH_FAILED",
      error: `${url}: ${error instanceof Error ? error.message : String(error)} (network error, CORS, or blocked)`,
    };
  } finally {
    clearTimeout(timer);
  }
}
