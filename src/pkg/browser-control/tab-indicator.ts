import type { TabIndicator } from "./agent-window";

const PALETTE = ["#E53935", "#8E24AA", "#3949AB", "#039BE5", "#00897B", "#D81B60", "#FB8C00", "#6D4C41"];
const PAUSED_COLOR = "#9E9E9E";
const OFF_COLOR = "#616161";
const NOTE_COLOR = "#F57C00";
export const AGENT_OVERLAY_CORNER_KEY = "browserControl.overlayCorner";

export type BadgeView = { text: string; color: string; title: string };
export type OverlayView = { label: string; color: string; paused: boolean };
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type OverlayOptions = { stopMessage: string; corner?: OverlayCorner; cornerKey: string };
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

// 将任务租约与未读便签同步为工具栏徽标与页面边框；只更新变化的标签
export class TabIndicatorController {
  private current = new Map<number, TabIndicator>();
  private notes = new Map<number, number>();
  // 曾设置过标签专属徽标、现已恢复默认的标签，需要跟随全局徽标颜色
  private restored = new Set<number>();

  constructor(
    private readonly deps: TabIndicatorDependencies,
    private defaults: BadgeView
  ) {}

  apply(next: Map<number, TabIndicator>): void {
    for (const tabId of [...this.current.keys()]) {
      if (next.has(tabId)) continue;
      this.current.delete(tabId);
      this.drawBadge(tabId);
      this.run(this.deps.setOverlay(tabId, null));
    }
    for (const [tabId, indicator] of next) {
      if (JSON.stringify(this.current.get(tabId)) === JSON.stringify(indicator)) continue;
      this.current.set(tabId, indicator);
      this.drawBadge(tabId);
      this.drawOverlay(tabId, indicator);
    }
  }

  // 每个标签当前网址上的未读便签数量
  setNotes(next: Map<number, number>): void {
    for (const tabId of [...this.notes.keys()]) {
      if (next.has(tabId)) continue;
      this.notes.delete(tabId);
      this.drawBadge(tabId);
    }
    for (const [tabId, count] of next) {
      if (this.notes.get(tabId) === count) continue;
      this.notes.set(tabId, count);
      this.drawBadge(tabId);
    }
  }

  refresh(tabId: number): void {
    const indicator = this.current.get(tabId);
    if (indicator || this.notes.has(tabId)) this.drawBadge(tabId);
    if (indicator) this.drawOverlay(tabId, indicator);
  }

  forget(tabId: number): void {
    this.current.delete(tabId);
    this.notes.delete(tabId);
    this.restored.delete(tabId);
  }

  setDefaults(defaults: BadgeView): void {
    this.defaults = defaults;
    for (const tabId of this.restored) this.run(this.deps.setBadge(tabId, { ...this.defaults }));
  }

  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (const indicator of this.current.values()) {
      if (indicator.kind === "owned" && (next === undefined || indicator.expiresAt < next)) next = indicator.expiresAt;
    }
    return next;
  }

  private badge(tabId: number): BadgeView | undefined {
    const indicator = this.current.get(tabId);
    const view = indicator && presentIndicator(indicator);
    const count = this.notes.get(tabId) ?? 0;
    if (!count) return view && { text: view.text, color: view.color, title: view.title };
    const notes = count === 1 ? "1 agent note needs attention" : `${count} agent notes need attention`;
    return {
      text: count > 9 ? "9+" : String(count),
      color: NOTE_COLOR,
      title: view ? `${notes}\n${view.title}` : notes,
    };
  }

  private drawBadge(tabId: number): void {
    const badge = this.badge(tabId);
    if (badge) this.restored.delete(tabId);
    else this.restored.add(tabId);
    this.run(this.deps.setBadge(tabId, badge ?? { ...this.defaults }));
  }

  private drawOverlay(tabId: number, indicator: TabIndicator): void {
    const { label, color, paused } = presentIndicator(indicator);
    this.run(this.deps.setOverlay(tabId, indicator.kind === "owned" ? { label, color, paused } : null));
  }

  private run(promise: Promise<void>): void {
    promise.catch((error: unknown) => log(String(error)));
  }
}

// 在页面隔离环境中执行，需保持自包含；页面只能通过可信点击收回访问
// 标签可拖动或甩向任一角落停靠，角落保存在扩展存储中，供后续重绘沿用
export function renderAgentOverlay(view: OverlayView | null, options: OverlayOptions): void {
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
  pill.dataset.pill = "";
  pill.title = "Drag or toss to another corner";
  pill.style.cssText =
    `position: fixed; pointer-events: auto; display: flex; align-items: center; cursor: grab; ` +
    `user-select: none; touch-action: none; ` +
    `gap: 6px; padding: 3px 4px 3px 10px; border-radius: 999px; background: ${view.color}; color: #fff; ` +
    `font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.3); opacity: .92;`;
  const dock = (corner: OverlayCorner) => {
    const [vertical, horizontal] = corner.split("-");
    pill.style.top = vertical === "top" ? "10px" : "auto";
    pill.style.bottom = vertical === "bottom" ? "10px" : "auto";
    pill.style.left = horizontal === "left" ? "10px" : "auto";
    pill.style.right = horizontal === "right" ? "10px" : "auto";
  };
  dock(options.corner ?? "bottom-right");

  // 拖动时只做平移；松开后按位置加上近 100ms 的速度外推选择角落，再从当前位置动画过去
  let drag: { x: number; y: number; samples: { x: number; y: number; t: number }[] } | undefined;
  const sample = (event: PointerEvent) => {
    if (!drag) return;
    const t = performance.now();
    drag.samples = [...drag.samples.filter((point) => t - point.t <= 100), { x: event.clientX, y: event.clientY, t }];
  };
  pill.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button")) return;
    drag = { x: event.clientX, y: event.clientY, samples: [] };
    sample(event);
    pill.setPointerCapture(event.pointerId);
    pill.style.transition = "none";
    pill.style.cursor = "grabbing";
  });
  pill.addEventListener("pointermove", (event) => {
    if (!drag) return;
    sample(event);
    pill.style.transform = `translate(${event.clientX - drag.x}px, ${event.clientY - drag.y}px)`;
  });
  const release = (event: PointerEvent) => {
    if (!drag) return;
    sample(event);
    const { samples } = drag;
    drag = undefined;
    pill.style.cursor = "grab";
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = last.t - first.t;
    const throwMs = 200;
    const before = pill.getBoundingClientRect();
    const x = before.left + before.width / 2 + (elapsed ? ((last.x - first.x) / elapsed) * throwMs : 0);
    const y = before.top + before.height / 2 + (elapsed ? ((last.y - first.y) / elapsed) * throwMs : 0);
    const corner: OverlayCorner = `${y < window.innerHeight / 2 ? "top" : "bottom"}-${
      x < window.innerWidth / 2 ? "left" : "right"
    }`;
    pill.style.transform = "";
    dock(corner);
    const after = pill.getBoundingClientRect();
    pill.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px)`;
    void pill.offsetWidth;
    pill.style.transition = "transform .25s cubic-bezier(.2,.8,.3,1)";
    pill.style.transform = "";
    void chrome.storage.local.set({ [options.cornerKey]: corner });
  };
  pill.addEventListener("pointerup", release);
  pill.addEventListener("pointercancel", release);

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
    void chrome.runtime.sendMessage({ type: options.stopMessage });
  });
  const hide = button("×", "Hide this label", () => pill.remove());
  pill.append(text, stop, hide);
  root.append(frame, pill);
  document.documentElement.append(host);
}
