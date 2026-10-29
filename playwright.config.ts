import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // 一次性验证脚本放在 e2e/scratch/（已 gitignore），不纳入正式 E2E 套件/CI。
  // 单跑请用 playwright.scratch.config.ts：见 docs/VERIFICATION.md。
  testIgnore: ["**/scratch/**"],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  outputDir: "test-results",
  // Playwright's bundled Chromium (`pnpm run test:e2e:install`), not system Chrome: macOS
  // force-quits a windowless Chrome.app ~30s after launch unless it may run in the background
  use: {
    actionTimeout: 10_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
  },
});
