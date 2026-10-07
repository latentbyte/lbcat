import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openZip } from "web-jszipp";
import config from "./firefox-release.json" with { type: "json" };

export interface FirefoxCompatibility {
  strict_min_version?: string;
  strict_max_version?: string;
}

export interface FirefoxUpdate {
  version: string;
  update_link: string;
  update_hash: string;
  applications: { gecko: FirefoxCompatibility };
}

export interface FirefoxUpdateFeed {
  addons: Record<string, { updates: FirefoxUpdate[] }>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty string");
  return value;
}

function version(value: unknown): string {
  const result = text(value);
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(result) || result.split(".").some((n) => Number(n) > 65535)) {
    throw new Error("Packaged manifest version must be plain x.y.z with components <= 65535");
  }
  return result;
}

function compatibility(value: unknown): FirefoxCompatibility {
  const source = object(value);
  const result: FirefoxCompatibility = {};
  if (source.strict_min_version !== undefined) result.strict_min_version = text(source.strict_min_version);
  if (source.strict_max_version !== undefined) result.strict_max_version = text(source.strict_max_version);
  return result;
}

function https(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Public HTTPS URL required");
  return url;
}

function hash(bytes: ArrayBuffer): string {
  return `sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}`;
}

export function emptyUpdateFeed(): FirefoxUpdateFeed {
  return { addons: { [config.addonId]: { updates: [] } } };
}

export async function generateUpdateFeed(bytes: ArrayBuffer): Promise<FirefoxUpdateFeed> {
  const zip = await openZip(bytes);
  try {
    const signatureSets = [
      ["META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"],
      ["META-INF/cose.manifest", "META-INF/cose.sig"],
    ];
    if (!signatureSets.some((paths) => paths.every((path) => (zip.get(path)?.size ?? 0) > 0))) {
      throw new Error("Mozilla signature metadata missing; Firefox verifies signature authenticity on installation");
    }
    const file = zip.get("manifest.json");
    if (!file) throw new Error("manifest.json missing from XPI");
    const manifest = object(JSON.parse(await file.text()));
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error("Invalid manifest_version");
    const gecko = object(object(manifest.browser_specific_settings).gecko);
    if (gecko.id !== config.addonId) throw new Error("XPI add-on identity mismatch");
    if (gecko.update_url !== config.updateUrl)
      throw new Error("XPI update URL mismatch; rebuild before Mozilla signing");
    const manifestVersion = version(manifest.version);
    const feed = emptyUpdateFeed();
    feed.addons[config.addonId].updates.push({
      version: manifestVersion,
      update_link: new URL(`lbcat-${manifestVersion}.xpi`, https(config.downloadBaseUrl)).href,
      update_hash: hash(bytes),
      applications: { gecko: compatibility(gecko) },
    });
    return feed;
  } finally {
    await zip.close();
  }
}

async function download(url: string, mime: string): Promise<Response> {
  let target = https(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(target.href, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect Location missing");
      target = https(new URL(location, target).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    if (response.url) https(response.url);
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== mime) {
      throw new Error(`Expected Content-Type ${mime}`);
    }
    return response;
  }
  throw new Error("Too many redirects");
}

export async function checkUpdateFeed(url: string = config.updateUrl): Promise<FirefoxUpdateFeed> {
  const addons = object(object(await (await download(url, "application/json")).json()).addons);
  if (Object.keys(addons).length !== 1 || !Object.hasOwn(addons, config.addonId)) {
    throw new Error("Update feed must contain only configured add-on ID");
  }
  const updates = object(addons[config.addonId]).updates;
  if (!Array.isArray(updates)) throw new Error("Update entries must be an array");
  const checked = emptyUpdateFeed();
  for (const value of updates) {
    const source = object(value);
    const entry: FirefoxUpdate = {
      version: version(source.version),
      update_link: https(text(source.update_link)).href,
      update_hash: text(source.update_hash),
      applications: { gecko: compatibility(object(source.applications).gecko) },
    };
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.update_hash)) throw new Error("Invalid SHA-256 update hash");
    const bytes = await (await download(entry.update_link, "application/x-xpinstall")).arrayBuffer();
    if (hash(bytes) !== entry.update_hash) throw new Error("XPI SHA-256 mismatch");
    const expected = (await generateUpdateFeed(bytes)).addons[config.addonId].updates[0];
    if (entry.version !== expected.version || entry.update_link !== expected.update_link) {
      throw new Error("Feed version or artifact URL differs from packaged manifest");
    }
    if (JSON.stringify(entry.applications.gecko) !== JSON.stringify(expected.applications.gecko)) {
      throw new Error("Firefox compatibility differs from packaged manifest");
    }
    checked.addons[config.addonId].updates.push(entry);
  }
  return checked;
}

async function main(args: string[]): Promise<void> {
  let feed: FirefoxUpdateFeed;
  if (args[0] === "init" && args.length === 1) feed = emptyUpdateFeed();
  else if (args[0] === "generate" && args.length === 2) {
    const bytes = await readFile(args[1]);
    feed = await generateUpdateFeed(Uint8Array.from(bytes).buffer);
  } else if (args[0] === "check" && args.length <= 2) feed = await checkUpdateFeed(args[1]);
  else throw new Error("Usage: firefox-release.ts init | generate <signed.xpi> | check [feed-url]");
  console.log(JSON.stringify(feed, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
