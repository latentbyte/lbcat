import { readdirSync, rmSync } from "node:fs";
import semver from "semver";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 删除 dist 中旧版本的打包产物，保留当前版本及其之前的 keepPrevious 个版本
export function pruneDist({ dir = "dist", name, currentVersion, keepPrevious = 2 }) {
  const pattern = new RegExp(`^${escapeRegExp(name)}-(.+)-(?:chrome|firefox|source)\\.(?:zip|crx)$`);
  const files = readdirSync(dir)
    .map((file) => ({ file, version: semver.valid(pattern.exec(file)?.[1]) }))
    .filter((entry) => entry.version);
  const older = [...new Set(files.map((entry) => entry.version))]
    .filter((version) => semver.lt(version, currentVersion))
    .sort(semver.rcompare);
  const stale = new Set(older.slice(keepPrevious));
  const removed = files.filter((entry) => stale.has(entry.version)).map((entry) => entry.file);
  for (const file of removed) {
    rmSync(`${dir}/${file}`);
  }
  return removed;
}
