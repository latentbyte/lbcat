import type { TabIndicator } from "./agent-window";

const PALETTE = ["#E53935", "#8E24AA", "#3949AB", "#039BE5", "#00897B", "#D81B60", "#FB8C00", "#6D4C41"];
const PAUSED_COLOR = "#9E9E9E";
const OFF_COLOR = "#616161";

export type BadgeView = { text: string; color: string; title: string };
export type OverlayView = { label: string; color: string; paused: boolean };
export type IndicatorPresentation = { text: string; color: string; title: string; label: string; paused: boolean };

export interface TabIndicatorDependencies {
  setBadge(tabId: number, badge: BadgeView): Promise<void>;
  setOverlay(tabId: number, overlay: OverlayView | null): Promise<void>;
}

function sessionColor(sessionId: string): string {
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function initials(label: string): string {
  const words = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  const chars = words.length > 1 ? words.slice(0, 2).map((word) => Array.from(word)[0]) : Array.from(words[0] ?? "");
  return chars.slice(0, 2).join("").toUpperCase();
}

export function presentIndicator(indicator: TabIndicator): IndicatorPresentation {
  if (indicator.kind === "off") {
    return { text: "OFF", color: OFF_COLOR, title: "Agent access is off for this tab", label: "off", paused: false };
  }
  const label = indicator.label ?? `agent ${indicator.sessionId.slice(0, 8)}`;
  return {
    text: indicator.label ? initials(indicator.label) : indicator.sessionId.slice(0, 2).toUpperCase(),
    color: indicator.paused ? PAUSED_COLOR : sessionColor(indicator.sessionId),
    title: `Agent: ${label}${indicator.paused ? " (paused)" : ""}`,
    label,
    paused: indicator.paused,
  };
}

const log = (...args: unknown[]) => console.warn("[agent-tab-indicator]", ...args);

// 将任务租约同步为工具栏徽标与页面边框；只更新变化的标签
export class TabIndicatorController {
  private current = new Map<number, TabIndicator>();
  // 曾设置过标签专属徽标、现已恢复默认的标签，需要跟随全局徽标颜色
  private restored = new Set<number>();

  constructor(
    private readonly deps: TabIndicatorDependencies,
    private defaults: BadgeView
  ) {}

  apply(next: Map<number, TabIndicator>): void {
    for (const tabId of this.current.keys()) {
      if (!next.has(tabId)) this.clear(tabId);
    }
    for (const [tabId, indicator] of next) {
      if (JSON.stringify(this.current.get(tabId)) === JSON.stringify(indicator)) continue;
      this.current.set(tabId, indicator);
      this.restored.delete(tabId);
      this.draw(tabId, indicator);
    }
  }

  refresh(tabId: number): void {
    const indicator = this.current.get(tabId);
    if (indicator) this.draw(tabId, indicator);
  }

  forget(tabId: number): void {
    this.current.delete(tabId);
    this.restored.delete(tabId);
  }

  setDefaults(defaults: BadgeView): void {
    this.defaults = defaults;
    for (const tabId of this.restored) this.run(this.deps.setBadge(tabId, this.defaultBadge()));
  }

  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (const indicator of this.current.values()) {
      if (indicator.kind === "owned" && (next === undefined || indicator.expiresAt < next)) next = indicator.expiresAt;
    }
    return next;
  }

  private defaultBadge(): BadgeView {
    return { ...this.defaults };
  }

  private clear(tabId: number): void {
    this.current.delete(tabId);
    this.restored.add(tabId);
    this.run(this.deps.setBadge(tabId, this.defaultBadge()));
    this.run(this.deps.setOverlay(tabId, null));
  }

  private draw(tabId: number, indicator: TabIndicator): void {
    const { text, color, title, label, paused } = presentIndicator(indicator);
    this.run(this.deps.setBadge(tabId, { text, color, title }));
    this.run(this.deps.setOverlay(tabId, indicator.kind === "owned" ? { label, color, paused } : null));
  }

  private run(promise: Promise<void>): void {
    promise.catch((error: unknown) => log(String(error)));
  }
}

// 在页面隔离环境中执行，需保持自包含；页面只能通过可信点击收回访问
export function renderAgentOverlay(view: OverlayView | null, stopMessage: string): void {
  const id = "lbcat-agent-indicator";
  document.getElementById(id)?.remove();
  if (!view) return;
  const host = document.createElement("lbcat-agent-indicator");
  host.id = id;
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("div");
  frame.style.cssText = `position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 3px ${view.color};`;
  const pill = document.createElement("div");
  pill.style.cssText =
    `position: fixed; right: 10px; bottom: 10px; pointer-events: auto; display: flex; align-items: center; ` +
    `gap: 6px; padding: 3px 4px 3px 10px; border-radius: 999px; background: ${view.color}; color: #fff; ` +
    `font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.3); opacity: .92;`;
  const text = document.createElement("span");
  text.textContent = `Agent: ${view.label}${view.paused ? " (paused)" : ""}`;
  const button = (label: string, title: string, onClick: () => void) => {
    const element = document.createElement("button");
    element.textContent = label;
    element.title = title;
    element.style.cssText =
      "all: unset; cursor: pointer; padding: 1px 8px; border-radius: 999px; background: rgba(0,0,0,.25); color: #fff;";
    element.addEventListener("click", (event) => {
      if (event.isTrusted) onClick();
    });
    return element;
  };
  const stop = button("Stop", "Turn off agent access for this tab", () => {
    void chrome.runtime.sendMessage({ type: stopMessage });
  });
  const hide = button("×", "Hide this label", () => pill.remove());
  pill.append(text, stop, hide);
  root.append(frame, pill);
  document.documentElement.append(host);
}
