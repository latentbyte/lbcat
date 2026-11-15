import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

describe("页面标题品牌", () => {
  it("扩展页面标题使用 LBcat 而不是上游名称 ScriptCat", () => {
    const offenders = sourceFiles("src/pages").filter((path) =>
      /document\.title\s*=.*ScriptCat/.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
