import { afterEach, describe, expect, it, vi } from "vitest";
import { runPageFetch } from "./page-fetch";

describe("页面身份请求", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("相对地址按页面解析并携带 Cookie，JSON 请求体自动设置类型", async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPageFetch({ url: "/api/items", body: '{"a":1}', timeoutMs: 5000 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/items", location.href).href,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      })
    );
    expect(result).toMatchObject({
      success: true,
      value: { status: 201, ok: true, contentType: "application/json", body: '{"ok":true}' },
    });
  });

  it("优先使用 Firefox 的 content.fetch 以页面身份请求", async () => {
    const pageFetch = vi.fn(async () => new Response("page"));
    vi.stubGlobal("content", { fetch: pageFetch });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("extension"))
    );
    await expect(runPageFetch({ url: "https://a.test/x", timeoutMs: 5000 })).resolves.toMatchObject({
      value: { body: "page" },
    });
    expect(pageFetch).toHaveBeenCalledWith("https://a.test/x", expect.objectContaining({ method: "GET" }));
  });

  it("非 2xx 仍返回状态与正文，超长正文截断", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found here", { status: 404 }))
    );
    await expect(runPageFetch({ url: "https://a.test/x", maxChars: 3, timeoutMs: 5000 })).resolves.toMatchObject({
      success: true,
      value: { status: 404, ok: false, body: "not", truncated: true, totalLength: 14 },
    });
  });

  it("网络错误与超时返回明确错误码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(runPageFetch({ url: "https://a.test/x", timeoutMs: 5000 })).resolves.toMatchObject({
      code: "FETCH_FAILED",
    });
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
      )
    );
    const pending = runPageFetch({ url: "https://a.test/x", timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await expect(pending).resolves.toMatchObject({ code: "FETCH_TIMEOUT" });
  });
});
