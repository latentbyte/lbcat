import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const output = `dist/${pkg.name}-${pkg.version}-source.zip`;
mkdirSync("dist", { recursive: true });
rmSync(output, { force: true });
execFileSync("zip", [
  "-qr",
  output,
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "rspack.config.ts",
  "rspack-plugins",
  "postcss.config.mjs",
  "uno.config.ts",
  "tsconfig.json",
  "scripts",
  "src",
  "packages",
  "README.md",
  "LICENSE",
  "env.example",
]);
console.log(output);
