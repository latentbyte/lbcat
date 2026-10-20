import type { GuideMark, GuidePageEvent } from "./guide";

export type GuideOverlayView = {
  stepId: number;
  title?: string;
  text: string;
  marks: GuideMark[];
  // preparing：人工已响应或页面已跳转，等待代理给出下一步
  // moved：代理在 target 标签给出了下一步，本标签的引导已结束
  state: "step" | "preparing" | "moved";
  target?: { tabId: number; title: string };
};
export type GuideOverlayOptions = { message: string };
// 人工请求切换到下一步所在的标签
export type GuideGotoEvent = { kind: "goto"; tabId: number };
export type GuideOverlayMessage = { type: string; stepId: number; event: GuidePageEvent | GuideGotoEvent };

// 在页面隔离世界执行，需保持自包含；与快照共享 __bctlRefs 取回标注元素
// 卡片在封闭 Shadow Root 中，页面脚本无法触达按钮；标注交互只记录可信事件
export function renderGuideOverlay(view: GuideOverlayView | null, options: GuideOverlayOptions): void {
  const store = globalThis as {
    __lbcatGuideTeardown?: () => void;
    // 人工拖动后的卡片位置，同一页面后续步骤沿用
    __lbcatGuidePosition?: { left: number; top: number };
    __bctlRefs?: Map<string, WeakRef<Element>>;
  };
  store.__lbcatGuideTeardown?.();
  store.__lbcatGuideTeardown = undefined;
  if (!view) return;

  const ACCENT = "#F59E0B";
  const PREPARING = "Got it. The agent is preparing the next step";
  const PAD = 4;
  const send = (event: GuideOverlayMessage["event"]) => {
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
  // 标题栏可拖动卡片，右侧按钮折叠或展开正文；新步骤总是展开显示
  const header = create(
    "div",
    "display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #FCD34D; " +
      "font-weight: 600; cursor: move; user-select: none; touch-action: none;"
  );
  header.dataset.handle = "";
  header.append(
    create(
      "span",
      "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
      view.title ? `${view.title} - Step ${view.stepId}` : `Agent walkthrough - Step ${view.stepId}`
    )
  );
  const body = create("div", "");
  const fold = create(
    "button",
    `all: unset; cursor: pointer; flex: none; width: 22px; text-align: center; border-radius: 4px; ` +
      `color: #F9FAFB; background: #374151; ${font}`
  );
  fold.dataset.fold = "";
  const setFolded = (folded: boolean) => {
    body.style.display = folded ? "none" : "block";
    fold.textContent = folded ? "+" : "-";
    fold.title = folded ? "Show the step" : "Fold the step";
    fold.setAttribute("aria-expanded", String(!folded));
    schedule();
  };
  fold.addEventListener("click", () => setFolded(body.style.display !== "none"));
  header.append(fold);
  // 说明支持 Markdown 子集：段落、标题、- / 1. 列表、**粗体**、*斜体*、`代码`、``` 围栏代码块；只用 DOM 构建，不解析 HTML
  // 不支持 _ 强调，避免 snake_case 名称被误解析
  const inline = (parent: HTMLElement, source: string) => {
    let last = 0;
    for (const match of source.matchAll(/`([^`]+)`|\*\*(.+?)\*\*|\*(\S(?:[^*]*\S)?)\*/g)) {
      parent.append(source.slice(last, match.index));
      last = match.index + match[0].length;
      if (match[1] !== undefined) {
        parent.append(
          create(
            "code",
            "padding: 0 4px; border-radius: 4px; background: #374151; font: 12px ui-monospace, Menlo, monospace;",
            match[1]
          )
        );
      } else {
        const element = create(
          match[2] !== undefined ? "strong" : "em",
          match[2] !== undefined ? "font-weight: 700;" : "font-style: italic;"
        );
        inline(element, match[2] ?? match[3]);
        parent.append(element);
      }
    }
    parent.append(source.slice(last));
  };
  // 图标只用 DOM 构建：剪贴板与对勾
  const icon = (paths: string[]) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({
      viewBox: "0 0 24 24",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }))
      svg.setAttribute(name, value);
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  };
  const CLIPBOARD = ["M9 9h11v11H9z", "M5 15H4V4h11v1"];
  const CHECK = ["M5 12l5 5L20 7"];
  // 围栏代码块是供人工复制粘贴的文本，旁边的按钮一键复制；剪贴板不可用时选中文本供手动复制
  const copyBlock = (value: string) => {
    const block = create(
      "div",
      "display: flex; align-items: flex-start; gap: 6px; margin: 0 0 6px; padding: 6px 8px; border-radius: 6px; " +
        "background: #1F2937; border: 1px solid #374151;"
    );
    block.dataset.copy = "";
    const pre = create(
      "pre",
      "flex: 1; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, Menlo, monospace;",
      value
    );
    const copy = create(
      "button",
      "all: unset; flex: none; display: flex; padding: 3px; border-radius: 4px; cursor: pointer; color: #FCD34D; " +
        "background: #374151;"
    );
    let reset = 0;
    const show = (title: string, paths: string[]) => {
      copy.title = title;
      copy.setAttribute("aria-label", title);
      copy.replaceChildren(icon(paths));
    };
    show("Copy", CLIPBOARD);
    copy.addEventListener("click", () => {
      clearTimeout(reset);
      navigator.clipboard.writeText(value).then(
        () => {
          show("Copied", CHECK);
          reset = window.setTimeout(() => show("Copy", CLIPBOARD), 1500);
        },
        () => {
          getSelection()?.selectAllChildren(pre);
          show("Press Ctrl+C or Cmd+C to copy", CLIPBOARD);
        }
      );
    });
    block.append(pre, copy);
    return block;
  };
  const markdown = (source: string) => {
    const blocks: HTMLElement[] = [];
    let list: HTMLElement | undefined;
    let paragraph: HTMLElement | undefined;
    // 进行中的围栏代码块：去掉开头围栏的缩进
    let fence: { indent: number; lines: string[] } | undefined;
    for (const line of source.split(/\r?\n/)) {
      const fenceLine = /^(\s*)```/.exec(line);
      if (fence) {
        if (fenceLine) {
          blocks.push(copyBlock(fence.lines.join("\n")));
          fence = undefined;
        } else fence.lines.push(line.slice(Math.min(fence.indent, /^\s*/.exec(line)![0].length)));
        continue;
      }
      if (fenceLine) {
        fence = { indent: fenceLine[1].length, lines: [] };
        list = paragraph = undefined;
        continue;
      }
      const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (item) {
        const tag = item[1] ? "ul" : "ol";
        if (list?.localName !== tag) {
          list = create(tag, "margin: 0 0 6px; padding-left: 20px;");
          if (item[2]) list.setAttribute("start", item[2]);
          blocks.push(list);
        }
        const entry = create("li", "margin: 1px 0;");
        inline(entry, item[3]);
        list.append(entry);
        paragraph = undefined;
      } else if (list && /^\s+\S/.test(line)) {
        // 缩进行接续上一列表项
        const entry = list.lastElementChild as HTMLElement;
        entry.append(" ");
        inline(entry, line.trim());
      } else if (heading) {
        const element = create("div", "margin: 0 0 6px; font-weight: 700;");
        inline(element, heading[1]);
        blocks.push(element);
        list = paragraph = undefined;
      } else if (!line.trim()) {
        list = paragraph = undefined;
      } else {
        list = undefined;
        if (paragraph) paragraph.append(create("br", ""));
        else blocks.push((paragraph = create("p", "margin: 0 0 6px;")));
        inline(paragraph, line);
      }
    }
    if (fence) blocks.push(copyBlock(fence.lines.join("\n")));
    return blocks;
  };

  const text = create(
    "div",
    "margin: 6px 0 10px; max-height: 50vh; overflow-y: auto; overflow-wrap: anywhere; overscroll-behavior: contain;"
  );
  text.dataset.text = "";
  const actions = create("div", "display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap;");
  actions.dataset.actions = "";
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
  body.append(text);
  card.append(header, body);

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
  // 卡片保持在视口内
  const place = (left: number, top: number) => {
    const { width, height } = card.getBoundingClientRect();
    const position = {
      left: Math.max(0, Math.min(left, window.innerWidth - width)),
      top: Math.max(0, Math.min(top, window.innerHeight - height)),
    };
    Object.assign(card.style, {
      left: `${position.left}px`,
      top: `${position.top}px`,
      bottom: "auto",
      transform: "none",
    });
    return position;
  };
  // 卡片默认在底部，挡住标注时移到顶部；人工拖动过则留在拖到的位置
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
    if (store.__lbcatGuidePosition) {
      place(store.__lbcatGuidePosition.left, store.__lbcatGuidePosition.top);
      return;
    }
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

  setFolded(false);

  // 人工响应后卡片改为提示状态；next 与 talk 结束本步，移除标注并允许关闭，代理未继续时卡片不会一直挡住页面
  // busy：代理正在处理，文字前显示转圈
  const settle = (message: string, stepDone: boolean, busy = false) => {
    text.textContent = message;
    if (busy) {
      const spinner = create(
        "span",
        "display: inline-block; box-sizing: border-box; width: 11px; height: 11px; margin-right: 8px; " +
          "vertical-align: -1px; border: 2px solid rgba(252,211,77,.25); border-top-color: #FCD34D; " +
          "border-radius: 50%; animation: lbcat-guide-spin .8s linear infinite;"
      );
      spinner.dataset.busy = "";
      text.prepend(spinner);
    }
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
    settle(PREPARING, true, true);
  } else if (view.state === "moved") {
    const target = view.target;
    settle(`The next step is in another tab: ${target?.title || "untitled"}`, true);
    if (target)
      actions.append(
        button("Go to that tab", true, () => {
          send({ kind: "goto", tabId: target.tabId });
          renderGuideOverlay(null, options);
        })
      );
  } else {
    text.replaceChildren(...markdown(view.text));
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
      settle("Sent. The agent is updating this step", false, true);
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
      // 人工把本步交给代理代为操作
      button("Do it for me", false, () => {
        send({ kind: "delegate", ...(reply() ? { reply: reply() } : {}) });
        settle("Over to the agent. The agent is doing this step", true, true);
      }),
      button("Got it, next", true, () => {
        send({ kind: "next", ...(reply() ? { reply: reply() } : {}) });
        settle(PREPARING, true, true);
      })
    );
    body.append(textarea);
  }
  body.append(actions);
  root.append(create("style", "", "@keyframes lbcat-guide-spin { to { transform: rotate(360deg); } }"), card);

  let drag: { x: number; y: number } | undefined;
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.composedPath().includes(fold)) return;
    const rect = card.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  header.addEventListener("pointermove", (event) => {
    if (drag) store.__lbcatGuidePosition = place(event.clientX - drag.x, event.clientY - drag.y);
  });
  const drop = () => (drag = undefined);
  header.addEventListener("pointerup", drop);
  header.addEventListener("pointercancel", drop);

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
