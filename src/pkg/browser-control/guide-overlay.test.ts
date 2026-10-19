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

  it("点击下一步发送回复并进入等待状态，标注随之移除", () => {
    const root = render(view)!;
    root.querySelector("textarea")!.value = "copied it";
    button(root, "Got it, next").click();
    expect(send).toHaveBeenCalledWith({ type: MESSAGE, stepId: 3, event: { kind: "next", reply: "copied it" } });
    expect(root.querySelector("[data-text]")!.textContent).toContain("preparing the next step");
    expect(root.querySelectorAll("[data-mark]")).toHaveLength(0);
    expect(Array.from(root.querySelectorAll("button")).map((item) => item.textContent)).toEqual(["Close"]);
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
  });

  it("选择讨论时通知代理并提示回到对话", () => {
    const root = render(view)!;
    button(root, "No, let's talk").click();
    expect(send).toHaveBeenCalledWith({ type: MESSAGE, stepId: 3, event: { kind: "talk" } });
    expect(root.querySelector("[data-text]")!.textContent).toContain("chat");
    button(root, "Close").click();
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
  });

  it("准备状态只显示等待提示", () => {
    const root = render({ stepId: 4, text: "", marks: [], state: "preparing" })!;
    expect(root.querySelector("[data-text]")!.textContent).toContain("preparing the next step");
    expect(root.querySelector("textarea")).toBeNull();
    button(root, "Close").click();
    expect(document.querySelector("lbcat-agent-guide")).toBeNull();
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
});
