import { describe, it, expect } from "vitest";
import { isAgentEnabled, resolveAgentEnabled, applyAgentManifest, firefoxRelease } from "./build-config.js";
import { readFileSync } from "node:fs";

describe("Firefox 发布配置", () => {
  it("两个打包入口应使用同一个扩展 ID，且不写入 AMO 上架版本禁止的 update_url", () => {
    expect(firefoxRelease).toEqual({
      addonId: "lbcat@latentbyte.com",
      updateUrl: "https://dl.latentbyte.com/lb/exts/lbcat-updates.json",
      downloadBaseUrl: "https://dl.latentbyte.com/lb/exts/",
    });
    for (const filename of ["rspack.config.ts", "scripts/pack.js"]) {
      const source = readFileSync(filename, "utf8");
      expect(source).toContain("id: firefoxRelease.addonId");
      expect(source).not.toContain("update_url");
    }
  });
});

describe("构建配置 - agent 开关", () => {
  describe("isAgentEnabled", () => {
    it("开发版本应启用 agent", () => {
      expect(isAgentEnabled({ isDev: true, isBeta: false })).toBe(true);
    });

    it("beta 版本应启用 agent", () => {
      expect(isAgentEnabled({ isDev: false, isBeta: true })).toBe(true);
    });

    it("正式版本应禁用 agent", () => {
      expect(isAgentEnabled({ isDev: false, isBeta: false })).toBe(false);
    });
  });

  describe("resolveAgentEnabled - 环境变量覆盖", () => {
    it("未设置环境变量时按版本派生（正式版禁用）", () => {
      expect(resolveAgentEnabled({ isDev: false, isBeta: false, envValue: undefined })).toBe(false);
    });

    it("未设置环境变量时按版本派生（beta 启用）", () => {
      expect(resolveAgentEnabled({ isDev: false, isBeta: true, envValue: undefined })).toBe(true);
    });

    it("环境变量 'true' 可在正式版强制启用 agent（用于 e2e）", () => {
      expect(resolveAgentEnabled({ isDev: false, isBeta: false, envValue: "true" })).toBe(true);
    });

    it("环境变量 'false' 可在 beta 强制禁用 agent", () => {
      expect(resolveAgentEnabled({ isDev: false, isBeta: true, envValue: "false" })).toBe(false);
    });
  });

  describe("applyAgentManifest", () => {
    const makeManifest = () => ({
      permissions: ["tabs", "debugger", "storage"],
      optional_permissions: ["background", "userScripts"],
    });

    it("启用 agent 时原样返回 manifest 且保留 debugger 权限", () => {
      const manifest = makeManifest();
      const result = applyAgentManifest(manifest, true);
      expect(result).toBe(manifest);
      expect(result.permissions).toContain("debugger");
    });

    it("Firefox 启用 agent 时也不请求不支持的 debugger 权限", () => {
      const manifest = makeManifest();
      const result = applyAgentManifest(manifest, true, "firefox");
      expect(result.permissions).toEqual(["tabs", "storage"]);
      expect(result.optional_permissions).toEqual(["background", "userScripts"]);
      expect(manifest.permissions).toContain("debugger");
    });

    it("Chrome 启用 agent 时保留 debugger 权限", () => {
      const manifest = makeManifest();
      expect(applyAgentManifest(manifest, true, "chrome")).toBe(manifest);
    });

    it("禁用 agent 时移除 debugger 权限", () => {
      const result = applyAgentManifest(makeManifest(), false);
      expect(result.permissions).not.toContain("debugger");
      expect(result.permissions).toEqual(["tabs", "storage"]);
    });

    it("禁用 agent 时不改动其它权限", () => {
      const result = applyAgentManifest(makeManifest(), false);
      expect(result.optional_permissions).toEqual(["background", "userScripts"]);
    });

    it("LBcat 浏览器控制在禁用 agent 时仍为 Chrome 保留 debugger 权限", () => {
      const manifest = makeManifest();
      const result = applyAgentManifest(manifest, false, "chrome", { browserControl: true });
      expect(result.permissions).toEqual(["tabs", "debugger", "storage"]);
    });

    it("LBcat 浏览器控制在 Firefox 上仍移除不支持的 debugger 权限", () => {
      const result = applyAgentManifest(makeManifest(), false, "firefox", { browserControl: true });
      expect(result.permissions).toEqual(["tabs", "storage"]);
    });

    it("禁用 agent 时不修改入参 manifest", () => {
      const manifest = makeManifest();
      applyAgentManifest(manifest, false);
      expect(manifest.permissions).toContain("debugger");
    });
  });
});
