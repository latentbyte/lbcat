import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDist } from "./prune-dist.js";

const setup = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "prune-dist-"));
  for (const file of files) {
    writeFileSync(join(dir, file), "");
  }
  return dir;
};

describe("清理旧版本打包产物", () => {
  it("应保留当前版本及之前两个版本，删除更旧的产物", () => {
    const dir = setup([
      "lbcat-4.10.0-chrome.zip",
      "lbcat-4.10.0-source.zip",
      "lbcat-4.9.0-firefox.zip",
      "lbcat-4.17.0-source.zip",
      "lbcat-4.18.0-chrome.crx",
      "lbcat-4.19.0-chrome.zip",
      "lbcat-4.19.0-source.zip",
    ]);
    const removed = pruneDist({ dir, name: "lbcat", currentVersion: "4.19.0" });
    expect(removed.sort()).toEqual(["lbcat-4.10.0-chrome.zip", "lbcat-4.10.0-source.zip", "lbcat-4.9.0-firefox.zip"]);
    expect(readdirSync(dir).sort()).toEqual([
      "lbcat-4.17.0-source.zip",
      "lbcat-4.18.0-chrome.crx",
      "lbcat-4.19.0-chrome.zip",
      "lbcat-4.19.0-source.zip",
    ]);
  });

  it("不应删除其他包名、较新版本或非打包产物的文件", () => {
    const dir = setup([
      "scriptcat-v3.0.0-az-chrome.zip",
      "scriptcat.pem",
      "lbcat-updates.json",
      "lbcat-5.0.0-chrome.zip",
      "lbcat-1.0.0-chrome.zip",
      "lbcat-2.0.0-chrome.zip",
      "lbcat-3.0.0-chrome.zip",
    ]);
    expect(pruneDist({ dir, name: "lbcat", currentVersion: "4.0.0" })).toEqual(["lbcat-1.0.0-chrome.zip"]);
    expect(readdirSync(dir)).toContain("lbcat-5.0.0-chrome.zip");
    expect(readdirSync(dir)).toContain("scriptcat-v3.0.0-az-chrome.zip");
  });
});
