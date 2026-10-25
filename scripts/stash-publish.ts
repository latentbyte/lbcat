import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import config from "./firefox-release.json" with { type: "json" };
import { checkUpdateFeed, download, generateUpdateFeed } from "./firefox-release.ts";

const XPI = /^lbcat-(\d+\.\d+\.\d+)\.xpi$/;
const FEED = "lbcat-updates.json";

export interface PublishPlan {
  upload: string[];
  promote: string | undefined;
}

// 本地已签名但 Stash 上没有的版本需要上传；Stash 上的最高版本高于线上清单时提升清单
export function planPublish(input: { local: string[]; stash: string[]; feedVersion: string | undefined }): PublishPlan {
  const versions = (names: string[]) => names.flatMap((name) => XPI.exec(name)?.[1] ?? []);
  const published = new Set(versions(input.stash));
  const upload = versions(input.local)
    .filter((version) => !published.has(version))
    .sort(semver.compare);
  const latest = [...published, ...upload].sort(semver.rcompare)[0];
  const promote = latest && (!input.feedVersion || semver.gt(latest, input.feedVersion)) ? latest : undefined;
  return { upload, promote };
}

interface Entry {
  id: string;
  name: string;
  kind: "file" | "folder";
  status: string;
  permission: string | null;
}

interface UploadIntent {
  entry_id: string;
  method: string;
  upload_url: string;
  headers: Record<string, string>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class Stash {
  private readonly namespace: string;
  private readonly folder: string;

  private constructor(namespace: string, folder: string) {
    this.namespace = namespace;
    this.folder = folder;
  }

  private static call(args: string[], body?: unknown): unknown {
    const output = execFileSync("lb", ["api", "call", ...args, ...(body === undefined ? [] : ["--body", "-"])], {
      env: { ...process.env, LB_API_BASE_URL: new URL(config.downloadBaseUrl).origin },
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
    return output.trim() ? JSON.parse(output) : undefined;
  }

  // 下载地址 /<username>/<folder...>/ 对应 Stash 命名空间与文件夹
  static open(): Stash {
    const [username, ...folders] = new URL(config.downloadBaseUrl).pathname.split("/").filter(Boolean);
    const { namespaces } = Stash.call(["list-namespaces"]) as { namespaces: { id: string; username: string }[] };
    const namespace = namespaces.find((item) => item.username === username);
    if (!namespace) throw new Error(`Stash namespace ${username} not found`);
    let stash = new Stash(namespace.id, "");
    for (const name of folders) {
      const folder = stash.list().find((entry) => entry.kind === "folder" && entry.name === name);
      if (!folder) throw new Error(`Stash folder ${name} not found`);
      stash = new Stash(namespace.id, folder.id);
    }
    return stash;
  }

  private call(args: string[], body?: unknown): unknown {
    return Stash.call([...args, "--header", `X-Stash-Namespace=${this.namespace}`], body);
  }

  list(): Entry[] {
    const entries: Entry[] = [];
    for (let page = 0; ; page++) {
      const query = ["--query", `page=${page}`, ...(this.folder ? ["--query", `parentId=${this.folder}`] : [])];
      const result = this.call(["list-entries", ...query]) as { entries: Entry[]; hasMore: boolean };
      entries.push(...result.entries);
      if (!result.hasMore) return entries;
    }
  }

  // 上传意图只写入私有临时文件，预签名地址不输出
  async upload(name: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "stash-upload-"));
    let intent: UploadIntent;
    try {
      const sink = join(dir, "intent.json");
      this.call(["create-upload", "--sink", sink], {
        filename: name,
        permission: "public",
        size: bytes.byteLength,
        mimeType,
        idempotencyKey: randomUUID(),
        parentId: this.folder,
      });
      intent = JSON.parse(readFileSync(sink, "utf8")) as UploadIntent;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // PUT 失败时存储可能已写入，仍尝试完成；完成接口对已可用文件幂等
    const put = await fetch(intent.upload_url, { method: intent.method || "PUT", headers: intent.headers, body: bytes })
      .then((response) => response.status)
      .catch((error: unknown) => String(error));
    try {
      this.call(["complete-upload", "--path", `id=${intent.entry_id}`]);
    } catch (error) {
      throw new Error(`Completing ${name} (entry ${intent.entry_id}) failed after storage PUT ${put}`, {
        cause: error,
      });
    }
  }

  swap(first: Entry, second: Entry): void {
    this.call(["swap-entry-names"], {
      firstId: first.id,
      firstName: first.name,
      secondId: second.id,
      secondName: second.name,
    });
  }
}

const publicUrl = (name: string) => new URL(name, config.downloadBaseUrl).href;

async function verifyPublic(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  const served = new Uint8Array(await (await download(publicUrl(name), mime)).arrayBuffer());
  if (sha256(served) !== sha256(bytes)) throw new Error(`${publicUrl(name)} serves different bytes`);
}

async function main(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: stash-publish.ts [--dry-run]");
  const stash = Stash.open();
  const entries = () => stash.list().filter((entry) => entry.kind === "file");
  const feed = await checkUpdateFeed();
  const feedVersion = feed.addons[config.addonId].updates.map((update) => update.version).sort(semver.rcompare)[0];
  const plan = planPublish({ local: readdirSync("dist"), stash: entries().map((entry) => entry.name), feedVersion });
  console.log(`live feed: ${feedVersion ?? "empty"}`);
  console.log(`upload: ${plan.upload.join(", ") || "nothing"}`);
  console.log(`promote feed to: ${plan.promote ?? "nothing"}`);
  if (dryRun) return;

  for (const version of plan.upload) {
    const name = `lbcat-${version}.xpi`;
    const bytes = readFileSync(join("dist", name));
    // 先确认是带签名、身份正确的 XPI，再公开上传
    await generateUpdateFeed(Uint8Array.from(bytes).buffer);
    await stash.upload(name, bytes, "application/x-xpinstall");
    await verifyPublic(name, bytes, "application/x-xpinstall");
    console.log(`published ${publicUrl(name)}`);
  }
  if (!plan.promote) return;

  const xpi = `lbcat-${plan.promote}.xpi`;
  const bytes = await (await download(publicUrl(xpi), "application/x-xpinstall")).arrayBuffer();
  const json = new TextEncoder().encode(`${JSON.stringify(await generateUpdateFeed(bytes), null, 2)}\n`);
  const staged = `lbcat-updates-${plan.promote}.json`;
  if (entries().some((entry) => entry.name === staged)) {
    // 上次运行在提升前中断：已暂存的清单必须与本次生成的一致
    await verifyPublic(staged, json, "application/json");
  } else {
    await stash.upload(staged, json, "application/json");
  }
  await checkUpdateFeed(publicUrl(staged));
  const current = entries();
  const find = (name: string) => {
    const entry = current.find((item) => item.name === name);
    if (!entry || entry.status !== "available" || entry.permission !== "public") {
      throw new Error(`${name} is not an available public Stash file`);
    }
    return entry;
  };
  stash.swap(find(staged), find(FEED));
  await checkUpdateFeed();
  console.log(`promoted ${publicUrl(FEED)} to ${plan.promote}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
