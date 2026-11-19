import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

const filesUnder = (dir: string, pattern: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, pattern);
    return pattern.test(name) ? [path] : [];
  });

// 用户可见文案里的产品名是 LBcat。上游标识符（`scriptHandler: "ScriptCat"`、GM_info 兼容值）、
// scriptcat.org / docs.scriptcat.org 链接、云同步目录 ScriptCat 和 backup 文件名保留不动。
const upstreamBrand = /Script(C|c)at/;

describe("页面标题品牌", () => {
  it("扩展页面标题使用 LBcat 而不是上游名称 ScriptCat", () => {
    const offenders = sourceFiles("src/pages").filter((path) =>
      /document\.title\s*=.*ScriptCat/.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});

describe("用户可见文案品牌", () => {
  it("界面翻译文案只使用 LBcat", () => {
    const offenders = filesUnder("src/locales", /\.json$/).filter((path) =>
      upstreamBrand.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("扩展显示名称使用 LBcat", () => {
    const offenders = filesUnder("src/assets/_locales", /messages\.json$/).filter((path) =>
      upstreamBrand.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("内置 agent 提示词使用 LBcat", () => {
    expect(readFileSync("src/app/service/agent/core/system_prompt.ts", "utf8")).not.toMatch(upstreamBrand);
  });
});
