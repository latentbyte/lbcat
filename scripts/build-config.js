import firefoxRelease from "./firefox-release.json" with { type: "json" };

export { firefoxRelease };

/**
 * LBcat 保留 agent；上游仅在开发版与 beta 预发布版本中提供
 * @param {{ isDev: boolean, isBeta: boolean, isFork?: boolean }} env
 * @returns {boolean}
 */
export function isAgentEnabled({ isDev, isBeta, isFork = false }) {
  return Boolean(isDev || isBeta || isFork);
}

/**
 * 解析 agent 开关：环境变量 SC_ENABLE_AGENT 优先（用于 e2e/CI 或手动强制覆盖），
 * 未设置时按构建身份派生（LBcat/dev/beta 启用，上游正式版屏蔽）
 * @param {{ isDev: boolean, isBeta: boolean, isFork?: boolean, envValue: string | undefined }} param
 * @returns {boolean}
 */
export function resolveAgentEnabled({ isDev, isBeta, isFork = false, envValue }) {
  if (envValue !== undefined) return envValue === "true";
  return isAgentEnabled({ isDev, isBeta, isFork });
}

/**
 * agent 禁用或 Firefox 不支持 debugger 时移除该权限
 * 其余权限保持不变，不修改入参。
 * @template {{ permissions?: string[] }} T
 * @param {T} manifest
 * @param {boolean} agentEnabled
 * @param {string} [targetBrowser="chrome"]
 * @returns {T}
 */
export function applyAgentManifest(manifest, agentEnabled, targetBrowser = "chrome") {
  if (agentEnabled && targetBrowser !== "firefox") return manifest;
  return {
    ...manifest,
    permissions: (manifest.permissions || []).filter((permission) => permission !== "debugger"),
  };
}
