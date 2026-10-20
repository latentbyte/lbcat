import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderGuideOverlay, type GuideOverlayView } from "./guide-overlay";

const MESSAGE = "test.guide";

function refs(entries: Record<string, Element>) {
  (globalThis as { __bctlRefs?: Map<string, WeakRef<Element>> }).__bctlRefs = new Map(
    Object.entries(entries).map(([id, el]) => [id, new WeakRef(el)])
  );
}

function render(view: GuideOverlayView | null) {
  let root: ShadowRoot | undefined;
  const attach = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
    root = attach.call(this, init);
    return root;
  });
  renderGuideOverlay(view, { message: MESSAGE });
  spy.mockRestore();
  return root;
}

const button = (root: ShadowRoot, name: string) =>
  Array.from(root.querySelectorAll("button")).find((item) => item.textContent === name)!;

describe("引导覆盖层", () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = `<code id="key">sk-123</code><input id="box" type="checkbox">`;
    refs({ e1: document.getElementById("key")!, e2: document.getElementById("box")! });
    // jsdom 未实现 ResizeObserver
    Object.assign(globalThis, {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    send = vi.fn(() => Promise.resolve());
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(send as never);
  });
  afterEach(() => {
    renderGuideOverlay(null, { message: MESSAGE });
    vi.restoreAllMocks();
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    delete (globalThis as { __bctlRefs?: unknown }).__bctlRefs;
    delete (globalThis as { __lbcatGuidePosition?: unknown }).__lbcatGuidePosition;
  });

  const view: GuideOverlayView = {
    stepId: 3,
    text: "Copy the key, then tick the box",
    marks: [
      { ref: "e1", label: "copy this" },
      { ref: "e2", label: "1" },
      { ref: "e9", label: "gone" },
    ],
    state: "step",
  };

  it("显示步骤说明并为仍在页面上的标注绘制框与标签", () => {
    const root = render(view)!;
    expect(root.querySelector("[data-card]")!.textContent).toContain("Step 3");
    expect(root.querySelector("[data-text]")!.textContent).toBe(view.text);
    const labels = Array.from(root.querySelectorAll("[data-mark]")).map((mark) => mark.textContent);
    expect(labels).toEqual(["copy this", "1"]);
  });

  it("说明按 Markdown 渲染列表、粗体、斜体与代码，snake_case 保持原样", () => {
    const root = render({
      ...view,
      text: "## Events\nTick **these** *two*:\n- `checkout.session.completed`\n- invoice_payment_succeeded\n  (v2)\n\n2. Press next",
    })!;
    const text = root.querySelector("[data-text]")!;
    expect(text.querySelector("div")!.textContent).toBe("Events");
    expect(text.querySelector("p strong")!.textContent).toBe("these");
    expect(text.querySelector("p em")!.textContent).toBe("two");
    expect(Array.from(text.querySelectorAll("ul > li")).map((item) => item.textContent)).toEqual([
      "checkout.session.completed",
      "invoice_payment_succeeded (v2)",
    ]);
    expect(text.querySelector("li code")!.textContent).toBe("checkout.session.completed");
    expect(text.querySelector("ol")!.getAttribute("start")).toBe("2");
    expect(text.querySelector("ol > li")!.textContent).toBe("Press next");
  });

  it("说明中的 HTML 按纯文本显示", () => {
    const root = render({ ...view, text: '<img src=x onerror="alert(1)"> **<b>hi</b>**' })!;
    const text = root.querySelector("[data-text]")!;
    expect(text.querySelector("img, b")).toBeNull();
    expect(text.textContent).toBe('<img src=x onerror="alert(1)"> <b>hi</b>');
  });

  it("围栏代码块渲染为可复制块，列表内缩进的围栏同样生效，未闭合的围栏延续到末尾", () => {
    const root = render({
      ...view,
      text: "Paste this webhook URL:\n```\nhttps://example.com/hook\n```\n- Then the secret:\n  ```\n  line one\n    line two\n  ```\n```\nunclosed `x`",
    })!;
    const blocks = Array.from(root.querySelectorAll("[data-text] [data-copy]"));
    expect(blocks.map((block) => block.querySelector("pre")!.textContent)).toEqual([
      "https://example.com/hook",
      "line one\n  line two",
      "unclosed `x`",
    ]);
    expect(blocks.every((block) => block.querySelector("button[title='Copy']"))).toBe(true);
    expect(root.querySelector("[data-text] p")!.textContent).toBe("Paste this webhook URL:");
    expect(root.querySelector("[data-text] li")!.textContent).toBe("Then the secret:");
  });

  it("点击复制按钮写入剪贴板并提示已复制，不通知代理", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = render({ ...view, text: "```\nsk-123\n```" })!;
    const copy = root.querySelector<HTMLButtonElement>("[data-copy] button")!;
    copy.click();
    await vi.waitFor(() => expect(copy.title).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("sk-123");
    expect(send).not.toHaveBeenCalled();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("剪贴板写入失败时选中文本供手动复制", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    // jsdom 无法选中 Shadow Root 内的节点，只断言选中了代码文本
    const select = vi.spyOn(Selection.prototype, "selectAllChildren").mockImplementation(() => {});
    const root = render({ ...view, text: "```\nsk-123\n```" })!;
    const copy = root.querySelector<HTMLButtonElement>("[data-copy] button")!;
    copy.click();
    await vi.waitFor(() => expect(copy.title).toBe("Press Ctrl+C or Cmd+C to copy"));
    expect(select).toHaveBeenCalledWith(root.querySelector("[data-copy] pre"));
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it("点击下一步发送回复并进入等待状态，标注随之移除", () => {
    const root = render(view)!;
    root.querySelector("textarea")!.value = "copied it";
    button(root, "Got it, next").click();
    expect(send).toHaveBeenCalledWith({ type: MESSAGE, stepId: 3, event: { kind: "next", reply: "copied it" } });
    expect(root.querySelector("[data-text]")!.textContent).toContain("preparing the next step");
    expect(root.querySelector("[data-text] [data-busy]")).not.toBeNull();
    expect(root.querySelectorAll("[data-mark]")).toHaveLength(0);
    expect(Array.from(root.querySelectorAll("[data-actions] button")).map((item) => item.textContent)).toEqual([
      "Close",
    ]);
  });

  it("发送按钮仅在有内容时可用，发送回复后保留标注等待代理调整", () => {
    const root = render(view)!;
    const textarea = root.querySelector("textarea")!;
    const reply = button(root, "Send");
    expect(reply.disabled).toBe(true);
    textarea.value = "I don't see the box";
    textarea.dispatchEvent(new Event("input"));
    expect(reply.disabled).toBe(false);
    reply.click();
    expect(send).toHaveBeenCalledWith({
      type: MESSAGE,
      stepId: 3,
      event: { kind: "reply", reply: "I don't see the box" },
    });
    expect(root.querySelectorAll("[data-mark]")).toHaveLength(2);
    expect(root.querySelector("[data-text]")!.textContent).toContain("updating this step");
    expect(root.querySelector("[data-text] [data-busy]")).not.toBeNull();
  });

  it("选择讨论时通知代理并提示回到对话", () => {
    const root = render(view)!;
    button(root, "No, let's talk").click();
    expect(send).toHaveBeenCalledWith({ type: MESSAGE, stepId: 3, event: { kind: "talk" } });
    expect(root.querySelector("[data-text]")!.textContent).toContain("chat");
    expect(root.querySelector("[data-busy]")).toBeNull();
    button(root, "Close").click();
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
  });

  it("选择交给代理时带上回复通知代理，标注移除并提示代理正在操作", () => {
    const root = render(view)!;
    root.querySelector("textarea")!.value = "only the first box";
    button(root, "Do it for me").click();
    expect(send).toHaveBeenCalledWith({
      type: MESSAGE,
      stepId: 3,
      event: { kind: "delegate", reply: "only the first box" },
    });
    expect(root.querySelector("[data-text]")!.textContent).toContain("agent is doing this step");
    expect(root.querySelector("[data-text] [data-busy]")).not.toBeNull();
    expect(root.querySelectorAll("[data-mark]")).toHaveLength(0);
  });

  it("准备状态只显示等待提示", () => {
    const root = render({ stepId: 4, text: "", marks: [], state: "preparing" })!;
    expect(root.querySelector("[data-text]")!.textContent).toContain("preparing the next step");
    expect(root.querySelector("[data-text] [data-busy]")).not.toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    button(root, "Close").click();
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
  });

  it("下一步转到其他标签时提示去向，点击后请求切换到该标签", () => {
    const root = render({ stepId: 4, text: "", marks: [], state: "moved", target: { tabId: 9, title: "Billing" } })!;
    expect(root.querySelector("[data-text]")!.textContent).toContain("another tab: Billing");
    expect(root.querySelector("[data-busy]")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    button(root, "Go to that tab").click();
    expect(send).toHaveBeenCalledWith({ type: MESSAGE, stepId: 4, event: { kind: "goto", tabId: 9 } });
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
  });

  it("折叠按钮隐藏与恢复正文，新步骤重新展开", () => {
    const root = render(view)!;
    const fold = root.querySelector<HTMLElement>("[data-fold]")!;
    const body = root.querySelector<HTMLElement>("[data-text]")!.parentElement!;
    fold.click();
    expect(body.style.display).toBe("none");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fold.click();
    expect(body.style.display).toBe("block");
    fold.click();
    const next = render({ ...view, stepId: 4 })!;
    expect(next.querySelector<HTMLElement>("[data-text]")!.parentElement!.style.display).toBe("block");
  });

  it("拖动标题栏移动卡片，位置限制在视口内并沿用到下一步", () => {
    const capture = vi.fn();
    Object.assign(Element.prototype, { setPointerCapture: capture });
    const root = render(view)!;
    const handle = root.querySelector<HTMLElement>("[data-handle]")!;
    const card = root.querySelector<HTMLElement>("[data-card]")!;
    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 210, 110);
    pointer("pointerup", 210, 110);
    expect(capture).toHaveBeenCalled();
    expect([card.style.left, card.style.top, card.style.bottom]).toEqual(["200px", "100px", "auto"]);
    pointer("pointermove", 500, 500);
    expect(card.style.left).toBe("200px");

    pointer("pointerdown", 0, 0);
    pointer("pointermove", -50, 99999);
    pointer("pointerup", 0, 0);
    expect([card.style.left, card.style.top]).toEqual(["0px", `${window.innerHeight}px`]);

    const next = render({ ...view, stepId: 4 })!.querySelector<HTMLElement>("[data-card]")!;
    expect([next.style.left, next.style.top]).toEqual(["0px", `${window.innerHeight}px`]);
    delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  });

  it("点击折叠按钮不触发拖动", () => {
    const root = render(view)!;
    const fold = root.querySelector<HTMLElement>("[data-fold]")!;
    fold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true, button: 0 }));
    fold.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true, clientX: 300, clientY: 300 }));
    expect((globalThis as { __lbcatGuidePosition?: unknown }).__lbcatGuidePosition).toBeUndefined();
  });

  it("重绘替换旧的覆盖层，传入 null 时移除，页面合成的交互不上报", () => {
    render(view);
    render(view);
    expect(document.querySelectorAll("lbcat-agent-guide")).toHaveLength(1);
    document.getElementById("key")!.click();
    expect(send).not.toHaveBeenCalled();
    render(null);
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
  });

  it("勾选框的输入与 change 不单独上报，由点击表示", () => {
    // jsdom 中 click() 合成的点击不可信，但勾选框随之触发的 input/change 可信
    document.body.innerHTML = `<input id="box" type="checkbox">`;
    refs({ e1: document.getElementById("box")! });
    render({ ...view, marks: [{ ref: "e1", label: "1" }] });
    const changes = vi.fn((event: Event) => event.isTrusted);
    document.addEventListener("change", changes);
    document.getElementById("box")!.click();
    document.removeEventListener("change", changes);
    expect(changes).toHaveReturnedWith(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("相邻标注的标签不遮挡其他标注元素", () => {
    document.body.innerHTML = `<input id="a" type="checkbox"><input id="b" type="checkbox">`;
    refs({ e1: document.getElementById("a")!, e2: document.getElementById("b")! });
    const rects: Record<string, DOMRect> = {
      a: new DOMRect(32, 151, 13, 13),
      b: new DOMRect(32, 172, 13, 13),
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.id in rects) return rects[this.id];
      if ((this as HTMLElement).dataset?.mark) return new DOMRect(0, 0, 20, 22);
      return new DOMRect(0, 0, 0, 0);
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList
    );
    const root = render({
      ...view,
      marks: [
        { ref: "e1", label: "2" },
        { ref: "e2", label: "3" },
      ],
    })!;
    const labels = Array.from(root.querySelectorAll<HTMLElement>("[data-mark]")).map((label) => {
      const left = parseFloat(label.style.left);
      const top = parseFloat(label.style.top);
      return { left, top, right: left + 20, bottom: top + 22 };
    });
    const boxes = Object.values(rects).map((rect) => ({
      left: rect.left - 4,
      top: rect.top - 4,
      right: rect.right + 4,
      bottom: rect.bottom + 4,
    }));
    const overlaps = (a: (typeof boxes)[0], b: (typeof boxes)[0]) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const label of labels) for (const box of boxes) expect(overlaps(label, box)).toBe(false);
    expect(overlaps(labels[0], labels[1])).toBe(false);
  });
});
