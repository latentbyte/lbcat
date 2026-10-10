import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

describe("Mozilla 源码审核包", () => {
  // spawns node; exceeds the 500ms CLI timeout under parallel load
  it("应包含构建配置所依赖的 Rspack 插件", { timeout: 10_000 }, () => {
    execFileSync(process.execPath, ["scripts/mozilla-source.mjs"]);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const files = execFileSync("unzip", ["-Z1", `dist/${pkg.name}-${pkg.version}-source.zip`], { encoding: "utf8" });
    expect(files.split("\n")).toContain("rspack-plugins/ZipExecutionPlugin.ts");
  });
});
