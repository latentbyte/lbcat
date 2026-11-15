import firefoxRelease from "./firefox-release.json" with { type: "json" };

export { firefoxRelease };

/**
 * agent 仅在开发版与 beta 预发布版本中提供；LBcat 与上游正式版本一样不包含 agent，
 * 以免商店版本带上未披露的 AI 聊天功能
 * @param {{ isDev: boolean, isBeta: boolean }} env
 * @returns {boolean}
 */
export function isAgentEnabled({ isDev, isBeta }) {
  return Boolean(isDev || isBeta);
}

/**
 * 解析 agent 开关：环境变量 SC_ENABLE_AGENT 优先（用于 e2e/CI 或手动强制覆盖），
 * 未设置时按构建身份派生（dev/beta 启用，正式版屏蔽）
 * @param {{ isDev: boolean, isBeta: boolean, envValue: string | undefined }} param
 * @returns {boolean}
 */
export function resolveAgentEnabled({ isDev, isBeta, envValue }) {
  if (envValue !== undefined) return envValue === "true";
  return isAgentEnabled({ isDev, isBeta });
}

/**
 * 既没有 agent 也没有浏览器控制（LBcat 的截图与视口模拟）需要 debugger，或 Firefox 不支持 debugger 时移除该权限
 * 其余权限保持不变，不修改入参。
 * @template {{ permissions?: string[] }} T
 * @param {T} manifest
 * @param {boolean} agentEnabled
 * @param {string} [targetBrowser="chrome"]
 * @param {{ browserControl?: boolean }} [options]
 * @returns {T}
 */
export function applyAgentManifest(manifest, agentEnabled, targetBrowser = "chrome", { browserControl = false } = {}) {
  if ((agentEnabled || browserControl) && targetBrowser !== "firefox") return manifest;
  return {
    ...manifest,
    permissions: (manifest.permissions || []).filter((permission) => permission !== "debugger"),
  };
}
