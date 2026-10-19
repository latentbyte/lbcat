import type { GuideMark, GuidePageEvent } from "./guide";

export type GuideOverlayView = {
  stepId: number;
  title?: string;
  text: string;
  marks: GuideMark[];
  // preparing：人工已响应或页面已跳转，等待代理给出下一步
  state: "step" | "preparing";
};
export type GuideOverlayOptions = { message: string };
export type GuideOverlayMessage = { type: string; stepId: number; event: GuidePageEvent };

// 在页面隔离世界执行，需保持自包含；与快照共享 __bctlRefs 取回标注元素
// 卡片在封闭 Shadow Root 中，页面脚本无法触达按钮；标注交互只记录可信事件
export function renderGuideOverlay(view: GuideOverlayView | null, options: GuideOverlayOptions): void {
  const store = globalThis as {
    __lbcatGuideTeardown?: () => void;
    __bctlRefs?: Map<string, WeakRef<Element>>;
  };
  store.__lbcatGuideTeardown?.();
  store.__lbcatGuideTeardown = undefined;
  if (!view) return;

  const ACCENT = "#F59E0B";
  const PREPARING = "Got it. The agent is preparing the next step...";
  const PAD = 4;
  const send = (event: GuidePageEvent) => {
    const message: GuideOverlayMessage = { type: options.message, stepId: view.stepId, event };
    void chrome.runtime.sendMessage(message);
  };
  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string) => {
    const element = document.createElement(tag);
    element.style.cssText = css;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const host = document.createElement("lbcat-agent-guide");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  const font = "font: 13px/1.45 system-ui, -apple-system, sans-serif;";

  // 标注框与标签，元素消失或不可见时隐藏
  const marks = view.marks
    .map((mark) => ({ mark, el: store.__bctlRefs?.get(mark.ref)?.deref() }))
    .filter((item): item is { mark: GuideMark; el: Element } => Boolean(item.el?.isConnected))
    .map(({ mark, el }) => {
      const box = create(
        "div",
        `position: fixed; box-sizing: border-box; border: 3px solid ${ACCENT}; border-radius: 6px; ` +
          `box-shadow: 0 0 0 4px rgba(245,158,11,.25), 0 0 18px rgba(245,158,11,.55); pointer-events: none;`
      );
      const label = create(
        "div",
        `position: fixed; max-width: 260px; padding: 2px 8px; border-radius: 4px; background: ${ACCENT}; ` +
          `color: #111827; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; ` +
          `pointer-events: none; ${font}`,
        mark.label
      );
      label.dataset.mark = mark.ref;
      root.append(box, label);
      return { mark, el, box, label };
    });

  const card = create(
    "div",
    `position: fixed; left: 50%; transform: translateX(-50%); width: min(400px, calc(100vw - 24px)); ` +
      `box-sizing: border-box; padding: 12px 14px; border-radius: 10px; background: #111827; color: #F9FAFB; ` +
      `box-shadow: 0 8px 28px rgba(0,0,0,.35); pointer-events: auto; ${font}`
  );
  card.dataset.card = "";
  const header = create(
    "div",
    "display: flex; justify-content: space-between; gap: 8px; color: #FCD34D; font-weight: 600;",
    view.title ? `${view.title} - Step ${view.stepId}` : `Agent walkthrough - Step ${view.stepId}`
  );
  const text = create("div", "margin: 6px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere;");
  text.dataset.text = "";
  const actions = create("div", "display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap;");
  const button = (label: string, primary: boolean, onClick: () => void) => {
    const element = create(
      "button",
      `all: unset; cursor: pointer; padding: 5px 12px; border-radius: 6px; ${font} ` +
        (primary ? `background: ${ACCENT}; color: #111827; font-weight: 600;` : "background: #374151; color: #F9FAFB;"),
      label
    );
    element.addEventListener("click", onClick);
    return element;
  };
  card.append(header, text);

  const shown = (el: Element) => {
    const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
    return el.isConnected && (check ? check.call(el) : el.getClientRects().length > 0);
  };
  type Box = { left: number; top: number; right: number; bottom: number };
  const intersects = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  // 标签依次尝试放在框的上、下、右、左，取第一个不压住其他标注框与已放标签的位置
  const placeLabel = (label: HTMLElement, box: Box, taken: Box[]) => {
    const { width, height } = label.getBoundingClientRect();
    const middle = box.top + (box.bottom - box.top - height) / 2;
    const spots = [
      [Math.max(4, box.left), box.top - height - 2],
      [Math.max(4, box.left), box.bottom + 2],
      [box.right + 4, middle],
      [box.left - width - 4, middle],
    ].map(([left, top]) => ({ left, top, right: left + width, bottom: top + height }));
    const inView = (spot: Box) =>
      spot.left >= 0 && spot.top >= 0 && spot.right <= window.innerWidth && spot.bottom <= window.innerHeight;
    const spot =
      spots.find((item) => inView(item) && !taken.some((other) => intersects(item, other))) ??
      spots.find(inView) ??
      spots[0];
    label.style.left = `${spot.left}px`;
    label.style.top = `${spot.top}px`;
    return spot;
  };
  // 卡片默认在底部，挡住标注时移到顶部
  const layout = () => {
    const placed: Array<{ label: HTMLElement; rect: DOMRect; box: Box }> = [];
    for (const { el, box, label } of marks) {
      const visible = shown(el);
      box.style.display = label.style.display = visible ? "block" : "none";
      if (!visible) continue;
      const rect = el.getBoundingClientRect();
      const area = { left: rect.left - PAD, top: rect.top - PAD, right: rect.right + PAD, bottom: rect.bottom + PAD };
      box.style.left = `${area.left}px`;
      box.style.top = `${area.top}px`;
      box.style.width = `${area.right - area.left}px`;
      box.style.height = `${area.bottom - area.top}px`;
      placed.push({ label, rect, box: area });
    }
    const taken = placed.map((item) => item.box);
    for (const { label, box } of placed) taken.push(placeLabel(label, box, taken));
    const rects = placed.map((item) => item.rect);
    const height = card.getBoundingClientRect().height || 160;
    const zone = window.innerHeight - height - 32;
    const top = rects.some((rect) => rect.bottom > zone && rect.top < window.innerHeight);
    card.style.top = top ? "16px" : "auto";
    card.style.bottom = top ? "auto" : "16px";
  };
  let frame = 0;
  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        layout();
      });
  };

  // 人工响应后卡片改为提示状态；next 与 talk 结束本步，移除标注并允许关闭，代理未继续时卡片不会一直挡住页面
  const settle = (message: string, stepDone: boolean) => {
    text.textContent = message;
    textarea?.remove();
    actions.replaceChildren();
    if (stepDone) {
      actions.append(button("Close", false, () => renderGuideOverlay(null, options)));
      for (const { box, label } of marks.splice(0)) {
        box.remove();
        label.remove();
      }
    }
    schedule();
  };

  let textarea: HTMLTextAreaElement | undefined;
  if (view.state === "preparing") {
    settle(PREPARING, true);
  } else {
    text.textContent = view.text;
    textarea = create(
      "textarea",
      `display: block; box-sizing: border-box; width: 100%; min-height: 34px; margin: 0 0 8px; padding: 6px 8px; ` +
        `resize: vertical; border: 1px solid #4B5563; border-radius: 6px; background: #1F2937; color: #F9FAFB; ${font}`
    );
    textarea.placeholder = "Reply to the agent (optional)";
    const field = textarea;
    const reply = () => field.value.trim();
    const sendReply = button("Send", false, () => {
      if (!reply()) return;
      send({ kind: "reply", reply: reply() });
      settle("Sent. The agent is updating this step...", false);
    });
    const syncReply = () => {
      sendReply.disabled = !reply();
      sendReply.style.opacity = reply() ? "1" : ".5";
    };
    field.addEventListener("input", syncReply);
    syncReply();
    actions.append(
      button("No, let's talk", false, () => {
        send({ kind: "talk", ...(reply() ? { reply: reply() } : {}) });
        settle("Head back to the chat with the agent to talk it through.", true);
      }),
      sendReply,
      button("Got it, next", true, () => {
        send({ kind: "next", ...(reply() ? { reply: reply() } : {}) });
        settle(PREPARING, true);
      })
    );
    card.append(textarea);
  }
  card.append(actions);
  root.append(card);

  // 标注元素上的人工点击与输入，同一元素同一类型每步只上报一次；勾选框与单选框的输入已由点击表示
  const reported = new Set<string>();
  const onInteraction = (event: Event) => {
    if (!event.isTrusted) return;
    const path = event.composedPath();
    if (path.includes(host)) return;
    const target = path[0];
    if (event.type === "input" && target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type))
      return;
    const hit = marks.find(({ el }) => path.includes(el));
    if (!hit) return;
    const type = event.type as "click" | "input";
    const key = `${hit.mark.ref}:${type}`;
    if (reported.has(key)) return;
    reported.add(key);
    send({ kind: "interaction", ref: hit.mark.ref, event: type });
  };
  const resize = new ResizeObserver(schedule);
  for (const { el } of marks) resize.observe(el);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  for (const type of ["click", "input"]) document.addEventListener(type, onInteraction, true);

  store.__lbcatGuideTeardown = () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
    for (const type of ["click", "input"]) document.removeEventListener(type, onInteraction, true);
    host.remove();
  };

  document.documentElement.append(host);
  layout();
  // 第一个标注不在视口内时滚动过去
  const first = marks[0]?.el.getBoundingClientRect();
  if (first && (first.bottom < 0 || first.top > window.innerHeight)) {
    marks[0].el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
