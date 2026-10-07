import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

describe("发布版本号", () => {
  it("应使用标准语义版本且不添加四段版本或预发布标签", () => {
    const root = mkdtempSync(join(tmpdir(), "lbcat-version-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lbcat", version: "4.0.0-az" }));
      writeFileSync(join(root, "src/manifest.json"), JSON.stringify({ version: "4.0.0", version_name: "4.0.0-az" }));
      execFileSync(process.execPath, [resolve("scripts/set-version.mjs"), "4.1.0"], { cwd: root });
      expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("4.1.0");
      const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
      expect(manifest.version).toBe("4.1.0");
      expect(manifest.name).toBe("LBcat");
      expect(manifest).not.toHaveProperty("version_name");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
