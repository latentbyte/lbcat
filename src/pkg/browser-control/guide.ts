import { BrowserControlError } from "./errors";

export type GuideMark = { ref: string; label: string };
export type GuideStep = { text: string; title?: string; marks: GuideMark[] };
export type GuideInteractionEvent = "click" | "input" | "change";
export type GuideInteraction = { ref: string; label: string; event: GuideInteractionEvent };
// 页面引导卡片发回的事件
export type GuidePageEvent =
  | { kind: "next" | "talk" | "reply"; reply?: string }
  | { kind: "interaction"; ref: string; event: GuideInteractionEvent };
export type GuideAction = "next" | "talk" | "reply" | "navigated" | "closed" | "timeout";
export type GuideOutcome = {
  step: number;
  action: GuideAction;
  reply?: string;
  url?: string;
  interactions: GuideInteraction[];
};

type Settled = Pick<GuideOutcome, "action" | "reply" | "url">;
type TabGuide = {
  step: GuideStep & { id: number };
  // 已发生但尚未交给代理的人工操作；等待开始前的点击也不会丢失
  queue: Settled[];
  interactions: GuideInteraction[];
  waiter?: { resolve: (outcome: GuideOutcome) => void; timer: ReturnType<typeof setTimeout> };
};

const MAX_REPLY = 2000;

// 引导模式：代理逐步在页面上展示说明，人工操作后阻塞中的等待返回结果
export class GuideService {
  private readonly guides = new Map<number, TabGuide>();

  begin(tabId: number, step: GuideStep): number {
    const previous = this.guides.get(tabId);
    const id = (previous?.step.id ?? 0) + 1;
    this.guides.set(tabId, { step: { ...step, id }, queue: [], interactions: [], waiter: previous?.waiter });
    return id;
  }

  current(tabId: number): (GuideStep & { id: number }) | undefined {
    return this.guides.get(tabId)?.step;
  }

  active(): number[] {
    return [...this.guides.keys()];
  }

  record(tabId: number, stepId: number, event: GuidePageEvent): void {
    const guide = this.guides.get(tabId);
    if (!guide || guide.step.id !== stepId) return;
    if (event.kind === "interaction") {
      const mark = guide.step.marks.find((item) => item.ref === event.ref);
      if (mark) guide.interactions.push({ ref: mark.ref, label: mark.label, event: event.event });
      return;
    }
    const reply = event.reply?.trim().slice(0, MAX_REPLY);
    if (event.kind === "reply" && !reply) return;
    this.settle(guide, { action: event.kind, ...(reply ? { reply } : {}) });
  }

  navigated(tabId: number, url: string): void {
    const guide = this.guides.get(tabId);
    if (guide) this.settle(guide, { action: "navigated", url });
  }

  // 标签关闭或代理清除引导时结束，正在等待的代理收到 closed
  close(tabId: number): void {
    const guide = this.guides.get(tabId);
    if (!guide) return;
    this.guides.delete(tabId);
    this.settle(guide, { action: "closed" });
  }

  wait(tabId: number, timeoutMs: number): Promise<GuideOutcome> {
    const guide = this.guides.get(tabId);
    if (!guide)
      return Promise.reject(
        new BrowserControlError("GUIDE_NOT_STARTED", `no guide on tab ${tabId}; run guide step first`)
      );
    // 同一标签只保留一个等待，旧的按超时返回
    if (guide.waiter) this.resolve(guide, { action: "timeout" });
    const queued = guide.queue.shift();
    if (queued) return Promise.resolve(this.outcome(guide, queued));
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(guide, { action: "timeout" }), timeoutMs);
      guide.waiter = { resolve, timer };
    });
  }

  private settle(guide: TabGuide, settled: Settled) {
    if (guide.waiter) this.resolve(guide, settled);
    else guide.queue.push(settled);
  }

  private resolve(guide: TabGuide, settled: Settled) {
    const waiter = guide.waiter;
    if (!waiter) return;
    guide.waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(this.outcome(guide, settled));
  }

  // 每次返回带走此前累积的标注交互，下次等待不重复
  private outcome(guide: TabGuide, settled: Settled): GuideOutcome {
    const interactions = guide.interactions;
    guide.interactions = [];
    return { step: guide.step.id, ...settled, interactions };
  }
}

export const guideService = new GuideService();
