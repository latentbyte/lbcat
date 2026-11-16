import { createHmac, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../package.json" with { type: "json" };
import config from "./firefox-release.json" with { type: "json" };
import { download } from "./firefox-release.ts";

const API = "https://addons.mozilla.org/api/v5/";

export interface AmoVersion {
  version: string;
  channel: string;
  file: { status: string; url: string } | null;
}

// AMO API 使用 HS256 JWT，iss 为 API key，有效期不超过 5 分钟
export function amoJwt(key: string, secret: string, now = Math.floor(Date.now() / 1000)): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: key, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

// 只有审核通过的上架版本才有可公开分发的签名文件
export function approvedFileUrl(version: AmoVersion): string {
  if (version.channel !== "listed") throw new Error(`${version.version} is ${version.channel}, not listed`);
  if (version.file?.status !== "public") {
    throw new Error(`${version.version} is not approved yet (file status: ${version.file?.status ?? "none"})`);
  }
  return version.file.url;
}

async function main(args: string[]): Promise<void> {
  const version = args[0] ?? pkg.version;
  const output = `dist/lbcat-${version}.xpi`;
  if (existsSync(output)) throw new Error(`${output} already exists`);
  const key = process.env.WEB_EXT_API_KEY;
  const secret = process.env.WEB_EXT_API_SECRET;
  if (!key || !secret) throw new Error("WEB_EXT_API_KEY and WEB_EXT_API_SECRET are required");
  const response = await fetch(new URL(`addons/addon/${config.addonId}/versions/${version}/`, API), {
    headers: { Authorization: `JWT ${amoJwt(key, secret)}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AMO version lookup HTTP ${response.status}`);
  const url = approvedFileUrl((await response.json()) as AmoVersion);
  writeFileSync(output, new Uint8Array(await (await download(url, "application/x-xpinstall")).arrayBuffer()));
  console.log(`saved ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
