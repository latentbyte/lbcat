import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { amoJwt, approvedFileUrl } from "./amo-fetch.ts";

describe("AMO 上架版本下载", () => {
  it("生成 60 秒有效、可用密钥验证的 HS256 JWT", () => {
    const token = amoJwt("user:1:2", "secret", 1_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: "user:1:2",
      iat: 1_000,
      exp: 1_060,
    });
    expect(signature).toBe(createHmac("sha256", "secret").update(`${header}.${payload}`).digest("base64url"));
  });

  it("审核通过的上架版本返回签名文件地址", () => {
    const url = "https://addons.mozilla.org/firefox/downloads/file/1/lbcat-4.36.0.xpi";
    expect(approvedFileUrl({ version: "4.36.0", channel: "listed", file: { status: "public", url } })).toBe(url);
  });

  it.each([
    { version: "4.36.0", channel: "listed", file: { status: "awaiting_review", url: "https://a/b.xpi" } },
    { version: "4.36.0", channel: "listed", file: null },
    { version: "4.35.6", channel: "unlisted", file: { status: "public", url: "https://a/b.xpi" } },
  ])("拒绝未审核或非上架版本 %#", (version) => {
    expect(() => approvedFileUrl(version)).toThrow();
  });
});
