import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPageAction } from "./page-actions";

// jsdom 无布局：以 hidden 属性与内联 display:none 模拟不可见
function stubVisibility() {
  const proto = Element.prototype as Element & { checkVisibility?: () => boolean };
  proto.checkVisibility = function (this: Element) {
    return !this.closest("[hidden], [style*='display: none']");
  };
}

describe("页面动作", () => {
  beforeEach(() => {
    stubVisibility();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  });

  describe("定位", () => {
    it("按选择器点击唯一可见元素并返回元素描述", async () => {
      document.body.innerHTML = `<button id="a" hidden>Save</button><button id="b">Save</button>`;
      const clicked = vi.fn();
      document.getElementById("b")!.addEventListener("click", clicked);
      const result = await runPageAction({ op: "click", selector: "button" });
      expect(result).toEqual({ success: true, value: { matched: { tag: "button", id: "b", text: "Save" } } });
      expect(clicked).toHaveBeenCalledTimes(1);
    });

    it("按可见文本优先精确匹配并点击可交互祖先", async () => {
      document.body.innerHTML = `<a href="#x">Save draft</a><button><span>Save</span></button>`;
      const clicked = vi.fn();
      document.querySelector("button")!.addEventListener("click", clicked);
      const result = await runPageAction({ op: "click", text: "save" });
      expect(result).toMatchObject({ success: true, value: { matched: { tag: "button", text: "Save" } } });
      expect(clicked).toHaveBeenCalledTimes(1);
    });

    it("多个匹配时报告歧义并列出候选，指定序号后执行", async () => {
      document.body.innerHTML = `<button>Go</button><button>Go</button>`;
      const result = await runPageAction({ op: "click", text: "Go" });
      expect(result).toMatchObject({ success: false, code: "AMBIGUOUS_MATCH" });
      expect((result as { error: string }).error).toContain("2 elements");
      const second = vi.fn();
      document.querySelectorAll("button")[1].addEventListener("click", second);
      await expect(runPageAction({ op: "click", text: "Go", nth: 2 })).resolves.toMatchObject({ success: true });
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("无匹配、无效选择器、缺少定位条件时返回明确错误码", async () => {
      await expect(runPageAction({ op: "click", selector: "#none" })).resolves.toMatchObject({
        success: false,
        code: "SELECTOR_NOT_FOUND",
      });
      await expect(runPageAction({ op: "click", text: "Nope" })).resolves.toMatchObject({
        success: false,
        code: "SELECTOR_NOT_FOUND",
      });
      await expect(runPageAction({ op: "click", selector: "[" })).resolves.toMatchObject({
        success: false,
        code: "INVALID_SELECTOR",
      });
      await expect(runPageAction({ op: "click" })).resolves.toMatchObject({
        success: false,
        code: "INVALID_ARGUMENT",
      });
    });

    it("穿透开放 Shadow DOM 查找元素", async () => {
      const host = document.createElement("div");
      document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML = `<button>Inside</button>`;
      await expect(runPageAction({ op: "click", text: "Inside" })).resolves.toMatchObject({
        success: true,
        value: { matched: { tag: "button", text: "Inside" } },
      });
    });
  });

  describe("填写与选择", () => {
    it("填写输入框时绕过框架的实例 value 并触发 input 与 change", async () => {
      document.body.innerHTML = `<label for="e">Email</label><input id="e">`;
      const input = document.querySelector("input")!;
      // 模拟 React 在实例上覆盖 value，直接赋值会被追踪器吞掉
      let tracked = "";
      Object.defineProperty(input, "value", {
        configurable: true,
        get: () => tracked,
        set: (value: string) => {
          tracked = value;
        },
      });
      const events: string[] = [];
      input.addEventListener("input", () => events.push("input"));
      input.addEventListener("change", () => events.push("change"));
      const result = await runPageAction({ op: "fill", text: "Email", value: "a@b.c" });
      expect(result).toMatchObject({ success: true, value: { matched: { tag: "input", id: "e" } } });
      expect(tracked).toBe("");
      expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(input)).toBe("a@b.c");
      expect(events).toEqual(["input", "change"]);
    });

    it("按占位符定位文本域并填写", async () => {
      document.body.innerHTML = `<textarea placeholder="Message"></textarea>`;
      await runPageAction({ op: "fill", text: "message", value: "hi" });
      expect(document.querySelector("textarea")!.value).toBe("hi");
    });

    it("填写非输入元素时拒绝", async () => {
      document.body.innerHTML = `<div id="d">x</div>`;
      await expect(runPageAction({ op: "fill", selector: "#d", value: "y" })).resolves.toMatchObject({
        success: false,
        code: "NOT_EDITABLE",
      });
    });

    it("按选项值或文本选择下拉项", async () => {
      document.body.innerHTML = `<select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>`;
      const changed = vi.fn();
      document.querySelector("select")!.addEventListener("change", changed);
      await expect(runPageAction({ op: "select", selector: "#s", value: "Banana" })).resolves.toMatchObject({
        success: true,
        value: { selected: "b" },
      });
      expect(document.querySelector("select")!.value).toBe("b");
      expect(changed).toHaveBeenCalledTimes(1);
      await expect(runPageAction({ op: "select", selector: "#s", value: "Cherry" })).resolves.toMatchObject({
        success: false,
        code: "OPTION_NOT_FOUND",
      });
    });
  });

  describe("按键", () => {
    it("在输入框按 Enter 时提交所在表单", async () => {
      document.body.innerHTML = `<form><input id="q"></form>`;
      const form = document.querySelector("form")!;
      const submitted = vi.fn((event: Event) => event.preventDefault());
      form.addEventListener("submit", submitted);
      const keys: string[] = [];
      document.getElementById("q")!.addEventListener("keydown", (event) => keys.push(event.key));
      await expect(runPageAction({ op: "press", key: "Enter", selector: "#q" })).resolves.toMatchObject({
        success: true,
      });
      expect(keys).toEqual(["Enter"]);
      expect(submitted).toHaveBeenCalledTimes(1);
    });

    it("支持修饰键组合并默认作用于当前焦点元素", async () => {
      document.body.innerHTML = `<input id="q">`;
      document.getElementById("q")!.focus();
      const seen: Array<{ key: string; ctrl: boolean }> = [];
      document
        .getElementById("q")!
        .addEventListener("keydown", (event) => seen.push({ key: event.key, ctrl: event.ctrlKey }));
      await runPageAction({ op: "press", key: "Control+a" });
      expect(seen).toEqual([{ key: "a", ctrl: true }]);
    });
  });

  describe("快照", () => {
    afterEach(() => {
      const store = globalThis as { __bctlRefs?: unknown; __bctlRefIds?: unknown; __bctlRefSeq?: unknown };
      delete store.__bctlRefs;
      delete store.__bctlRefIds;
      delete store.__bctlRefSeq;
    });

    it("列出可见的可交互元素与标题并分配引用", async () => {
      document.title = "Shop";
      document.body.innerHTML = `
        <h2>Checkout</h2>
        <a href="/cart">Cart</a>
        <label for="e">Email</label><input id="e" value="a@b.c">
        <label><input type="checkbox" checked> Remember</label>
        <input type="password" placeholder="Password" value="secret">
        <select aria-label="Country"><option>Canada</option><option selected>Japan</option></select>
        <button disabled>Pay</button>
        <button hidden>Hidden</button>
        <div tabindex="-1">Dialog</div>`;
      const result = await runPageAction({ op: "snapshot", max: 50 });
      expect(result).toMatchObject({ success: true });
      const snapshot = (result as { value: { snapshot: { elements: unknown[]; total: number } } }).value.snapshot;
      expect(snapshot).toMatchObject({ title: "Shop", total: 7 });
      expect(snapshot.elements).toEqual([
        { role: "heading", name: "Checkout", level: 2 },
        { ref: "e1", role: "link", name: "Cart", href: "/cart" },
        { ref: "e2", role: "textbox", name: "Email", value: "a@b.c" },
        { ref: "e3", role: "checkbox", name: "Remember", checked: true },
        { ref: "e4", role: "textbox", name: "Password", value: "***" },
        { ref: "e5", role: "combobox", name: "Country", value: "Japan" },
        { ref: "e6", role: "button", name: "Pay", disabled: true },
      ]);
    });

    it("引用在多次快照间保持稳定并可用于动作，元素移除后失效", async () => {
      document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
      await runPageAction({ op: "snapshot", max: 50 });
      document.body.insertAdjacentHTML("afterbegin", `<button id="c">C</button>`);
      const again = await runPageAction({ op: "snapshot", max: 50 });
      const refs = (again as { value: { snapshot: { elements: Array<{ ref: string; name: string }> } } }).value.snapshot
        .elements;
      expect(refs.map(({ ref, name }) => `${ref}:${name}`)).toEqual(["e3:C", "e1:A", "e2:B"]);
      const clicked = vi.fn();
      document.getElementById("b")!.addEventListener("click", clicked);
      await expect(runPageAction({ op: "click", ref: "e2" })).resolves.toMatchObject({ success: true });
      expect(clicked).toHaveBeenCalledTimes(1);
      document.getElementById("b")!.remove();
      await expect(runPageAction({ op: "click", ref: "e2" })).resolves.toMatchObject({ code: "REF_NOT_FOUND" });
    });

    it("限定范围并按上限截断", async () => {
      document.body.innerHTML = `<nav><a href="/x">X</a></nav><form><button>1</button><button>2</button><button>3</button></form>`;
      const result = await runPageAction({ op: "snapshot", selector: "form", max: 2 });
      expect(result).toMatchObject({
        success: true,
        value: { snapshot: { total: 3, truncated: true, elements: [{ name: "1" }, { name: "2" }] } },
      });
      await expect(runPageAction({ op: "snapshot", selector: "#none", max: 2 })).resolves.toMatchObject({
        code: "SELECTOR_NOT_FOUND",
      });
    });
  });

  describe("等待", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("等待元素出现后返回", async () => {
      const pending = runPageAction({ op: "wait", selector: ".done", state: "visible", timeoutMs: 5000 });
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<p class="done">ok</p>`), 300);
      await vi.advanceTimersByTimeAsync(400);
      await expect(pending).resolves.toMatchObject({ success: true, value: { matched: { tag: "p" } } });
    });

    it("等待元素消失与文本出现", async () => {
      document.body.innerHTML = `<div class="spinner">Loading</div>`;
      const gone = runPageAction({ op: "wait", selector: ".spinner", state: "gone", timeoutMs: 5000 });
      setTimeout(() => document.querySelector(".spinner")!.remove(), 200);
      await vi.advanceTimersByTimeAsync(300);
      await expect(gone).resolves.toMatchObject({ success: true });
      const text = runPageAction({ op: "wait", text: "all set", state: "visible", timeoutMs: 5000 });
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<p>All set!</p>`), 200);
      await vi.advanceTimersByTimeAsync(300);
      await expect(text).resolves.toMatchObject({ success: true });
    });

    it("超时返回 WAIT_TIMEOUT", async () => {
      const pending = runPageAction({ op: "wait", selector: ".never", state: "visible", timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1100);
      await expect(pending).resolves.toMatchObject({ success: false, code: "WAIT_TIMEOUT" });
    });
  });

  describe("上传文件", () => {
    const file = (name: string, text: string) => ({ name, type: "text/plain", data: btoa(text) });
    // jsdom 没有 DataTransfer，且 files 只接受真实 FileList：替换为可观察的实现
    const captureFiles = (input: HTMLInputElement) => {
      const assigned: File[][] = [];
      Object.defineProperty(input, "files", {
        configurable: true,
        get: () => assigned.at(-1) ?? [],
        set: (files: File[]) => assigned.push(Array.from(files)),
      });
      return assigned;
    };
    beforeEach(() => {
      vi.stubGlobal(
        "DataTransfer",
        class {
          readonly list: File[] = [];
          readonly items = { add: (item: File) => this.list.push(item) };
          get files() {
            return this.list;
          }
        }
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("按标签文本找到隐藏的文件输入并触发 input 与 change", async () => {
      document.body.innerHTML = `<label for="cv">Resume</label><input id="cv" type="file" hidden>`;
      const input = document.getElementById("cv") as HTMLInputElement;
      const assigned = captureFiles(input);
      const events: string[] = [];
      for (const type of ["input", "change"]) input.addEventListener(type, () => events.push(type));
      const result = await runPageAction({ op: "upload", text: "Resume", files: [file("cv.txt", "hello")] });
      expect(result).toEqual({ success: true, value: { matched: { tag: "input", id: "cv" } } });
      expect(assigned).toHaveLength(1);
      expect(assigned[0][0]).toMatchObject({ name: "cv.txt", type: "text/plain" });
      const reader = new FileReader();
      const read = new Promise((resolve) => reader.addEventListener("load", () => resolve(reader.result)));
      reader.readAsText(assigned[0][0]);
      expect(await read).toBe("hello");
      expect(events).toEqual(["input", "change"]);
    });

    it("未指定定位时使用页面唯一的文件输入，多个时要求明确", async () => {
      document.body.innerHTML = `<div id="drop"><input type="file" multiple></div>`;
      const assigned = captureFiles(document.querySelector("input")!);
      await expect(
        runPageAction({ op: "upload", files: [file("a.txt", "a"), file("b.txt", "b")] })
      ).resolves.toMatchObject({ success: true });
      expect(assigned[0].map((item) => item.name)).toEqual(["a.txt", "b.txt"]);
      document.body.insertAdjacentHTML("beforeend", `<input type="file">`);
      await expect(runPageAction({ op: "upload", files: [file("a.txt", "a")] })).resolves.toMatchObject({
        code: "AMBIGUOUS_MATCH",
      });
    });

    it("选择器指向容器时使用其中的文件输入，找不到或数量超限时报错", async () => {
      document.body.innerHTML = `<div id="drop"><input id="one" type="file"></div><button id="plain">Go</button>`;
      captureFiles(document.getElementById("one") as HTMLInputElement);
      await expect(runPageAction({ op: "upload", selector: "#drop", files: [file("a.txt", "a")] })).resolves.toEqual({
        success: true,
        value: { matched: { tag: "input", id: "one" } },
      });
      await expect(
        runPageAction({ op: "upload", selector: "#plain", files: [file("a.txt", "a")] })
      ).resolves.toMatchObject({ code: "NOT_FILE_INPUT" });
      await expect(
        runPageAction({ op: "upload", selector: "#drop", files: [file("a.txt", "a"), file("b.txt", "b")] })
      ).resolves.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
  });
});
