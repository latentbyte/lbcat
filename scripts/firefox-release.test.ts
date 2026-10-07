import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipWriter } from "web-jszipp";
import config from "./firefox-release.json" with { type: "json" };
import { checkUpdateFeed, emptyUpdateFeed, generateUpdateFeed } from "./firefox-release.ts";

const gecko = { id: config.addonId, update_url: config.updateUrl, strict_min_version: "128.0" };
const manifest = { manifest_version: 3, version: "4.1.0", browser_specific_settings: { gecko } };

async function packageBytes(value: unknown = manifest, signed = true): Promise<ArrayBuffer> {
  const zip = new ZipWriter({ outputAs: "arraybuffer" });
  await zip.add({ path: "manifest.json", data: JSON.stringify(value), method: "store" });
  if (signed) {
    for (const path of ["META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"]) {
      await zip.add({ path, data: "signature fixture", method: "store" });
    }
  }
  return zip.close();
}

function response(body: BodyInit, mime: string): Response {
  return new Response(body, { headers: { "content-type": mime } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Firefox 离线更新清单", () => {
  it("初始清单只包含指定扩展且没有可安装版本", () => {
    expect(emptyUpdateFeed()).toEqual({ addons: { [config.addonId]: { updates: [] } } });
  });

  it("从签名包读取版本和兼容范围并计算完整文件哈希", async () => {
    const bytes = await packageBytes({
      ...manifest,
      browser_specific_settings: { gecko: { ...gecko, strict_max_version: "150.*" } },
    });
    const feed = await generateUpdateFeed(bytes);
    expect(feed.addons[config.addonId].updates).toEqual([
      {
        version: "4.1.0",
        update_link: new URL("lbcat-4.1.0.xpi", config.downloadBaseUrl).href,
        update_hash: `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`,
        applications: { gecko: { strict_min_version: "128.0", strict_max_version: "150.*" } },
      },
    ]);
  });

  it("拒绝损坏归档和未签名归档", async () => {
    await expect(generateUpdateFeed(new ArrayBuffer(3))).rejects.toThrow();
    await expect(generateUpdateFeed(await packageBytes(manifest, false))).rejects.toThrow(/signature/i);
  });

  it("首次发行包缺少更新地址时要求重新构建和签名", async () => {
    const bytes = await packageBytes({
      ...manifest,
      browser_specific_settings: { gecko: { id: config.addonId, strict_min_version: "142.0" } },
    });
    await expect(generateUpdateFeed(bytes)).rejects.toThrow(/rebuild before Mozilla signing/);
  });

  it.each([
    { ...manifest, version: "4.0.0-beta.1" },
    { ...manifest, version: "3.0.9.1900" },
    { ...manifest, version: "65536.0.0" },
    { ...manifest, version: 4 },
    { ...manifest, browser_specific_settings: { gecko: { ...gecko, id: "other@example.com" } } },
    { ...manifest, browser_specific_settings: { gecko: { ...gecko, update_url: "https://example.com/a" } } },
    { ...manifest, browser_specific_settings: { gecko: { ...gecko, strict_min_version: 128 } } },
    null,
  ])("拒绝无效版本、身份和更新配置 %#", async (value) => {
    await expect(generateUpdateFeed(await packageBytes(value))).rejects.toThrow();
  });
});

describe("Firefox 公共更新检查", () => {
  it("空清单可以发布且不请求安装包", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify(emptyUpdateFeed()), "application/json"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkUpdateFeed()).resolves.toEqual(emptyUpdateFeed());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("检查 HTTPS 重定向及最终下载的内容和哈希", async () => {
    const bytes = await packageBytes();
    const feed = await generateUpdateFeed(bytes);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example/feed" } }))
      .mockResolvedValueOnce(response(JSON.stringify(feed), "application/json; charset=utf-8"))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://cdn.example/package" } }))
      .mockResolvedValueOnce(response(bytes, "application/x-xpinstall"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(checkUpdateFeed()).resolves.toEqual(feed);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["http://example.com/feed", "https://user:password@example.com/feed"])(
    "拒绝不安全更新地址 %s",
    async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(checkUpdateFeed(url)).rejects.toThrow(/HTTPS/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("拒绝降级重定向、循环重定向、失败响应和错误清单类型", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://example.com" } }))
    );
    await expect(checkUpdateFeed()).rejects.toThrow(/HTTPS/);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: config.updateUrl } }))
    );
    await expect(checkUpdateFeed()).rejects.toThrow(/redirect/i);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(checkUpdateFeed()).rejects.toThrow(/404/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("{}", "text/html")));
    await expect(checkUpdateFeed()).rejects.toThrow(/Content-Type/);
  });

  it.each([
    { addons: {} },
    { addons: { other: { updates: [] } } },
    { addons: { [config.addonId]: { updates: "bad" } } },
  ])("拒绝错误扩展清单 %#", async (feed) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(JSON.stringify(feed), "application/json")));
    await expect(checkUpdateFeed()).rejects.toThrow();
  });

  it.each(["mime", "hash", "version", "compatibility", "link", "unsigned"])(
    "拒绝安装包与清单不一致 %s",
    async (issue) => {
      const bytes = await packageBytes();
      const feed = await generateUpdateFeed(bytes);
      const entry = feed.addons[config.addonId].updates[0];
      let servedBytes = bytes;
      if (issue === "hash") entry.update_hash = `sha256:${"0".repeat(64)}`;
      if (issue === "version") entry.version = "4.0.2";
      if (issue === "compatibility") entry.applications.gecko.strict_min_version = "130.0";
      if (issue === "link") entry.update_link = "http://example.com/package.xpi";
      if (issue === "unsigned") {
        servedBytes = await packageBytes(manifest, false);
        entry.update_hash = `sha256:${createHash("sha256").update(new Uint8Array(servedBytes)).digest("hex")}`;
      }
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(response(JSON.stringify(feed), "application/json"))
          .mockResolvedValueOnce(
            response(servedBytes, issue === "mime" ? "application/octet-stream" : "application/x-xpinstall")
          )
      );
      await expect(checkUpdateFeed()).rejects.toThrow();
    }
  );

  it("逐项检查清单而不只检查第一个版本", async () => {
    const bytes = await packageBytes();
    const feed = await generateUpdateFeed(bytes);
    const updates = feed.addons[config.addonId].updates;
    updates.push({ ...updates[0], update_hash: `sha256:${"0".repeat(64)}` });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(JSON.stringify(feed), "application/json"))
        .mockResolvedValueOnce(response(bytes, "application/x-xpinstall"))
        .mockResolvedValueOnce(response(bytes, "application/x-xpinstall"))
    );
    await expect(checkUpdateFeed()).rejects.toThrow(/SHA-256 mismatch/);
  });
});
