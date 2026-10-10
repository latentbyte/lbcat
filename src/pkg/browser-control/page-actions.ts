// 注入页面隔离世界执行的 DOM 动作；executeScript 会序列化函数，因此 runPageAction 必须完全自包含

export type PageLocator = { selector?: string; text?: string; ref?: string; nth?: number };
export type PageWaitState = "visible" | "attached" | "gone";
export type PageActionRequest =
  | ({ op: "click" } & PageLocator)
  | ({ op: "fill"; value: string } & PageLocator)
  | ({ op: "select"; value: string } & PageLocator)
  | ({ op: "press"; key: string } & PageLocator)
  | { op: "wait"; selector?: string; text?: string; state: PageWaitState; timeoutMs: number }
  | { op: "snapshot"; selector?: string; max: number }
  | ({ op: "upload"; files: PageUploadFile[] } & PageLocator);
// data 为 base64 编码的文件内容
export type PageUploadFile = { name: string; type: string; data: string };
export type PageElementSummary = { tag: string; id?: string; text?: string };
export type PageSnapshotElement = {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  level?: number;
};
export type PageSnapshot = {
  url: string;
  title: string;
  elements: PageSnapshotElement[];
  total: number;
  truncated?: boolean;
};
export type PageActionResult =
  | { success: true; value: { matched?: PageElementSummary; selected?: string; snapshot?: PageSnapshot } }
  | { success: false; code: string; error: string };

export async function runPageAction(request: PageActionRequest): Promise<PageActionResult> {
  class ActionError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  const CONTENT_EDITABLE = "[contenteditable=''],[contenteditable=true]";
  const INTERACTIVE_ROLES =
    "button,link,menuitem,menuitemcheckbox,menuitemradio,tab,checkbox,radio,option,switch,combobox,textbox,searchbox,treeitem";
  const CLICKABLE = [
    "a",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "label",
    "option",
    "[onclick]",
    "[tabindex]",
    CONTENT_EDITABLE,
    ...INTERACTIVE_ROLES.split(",").map((role) => `[role=${role}]`),
  ].join(",");
  const EDITABLE = `input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select,${CONTENT_EDITABLE}`;

  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const textOf = (el: Element) => (el as HTMLElement).innerText ?? el.textContent ?? "";

  // 文档与所有开放 Shadow Root
  const roots = (): Array<Document | ShadowRoot> => {
    const found: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < found.length; i++) {
      for (const el of Array.from(found[i].querySelectorAll("*"))) if (el.shadowRoot) found.push(el.shadowRoot);
    }
    return found;
  };
  const queryAll = (selector: string): Element[] => {
    try {
      return roots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
    } catch (error) {
      throw new ActionError("INVALID_SELECTOR", `invalid selector ${selector}: ${(error as Error).message}`);
    }
  };
  const visible = (el: Element) => {
    const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
    return el.isConnected && (check ? check.call(el) : el.getClientRects().length > 0);
  };
  const summary = (el: Element): PageElementSummary => {
    const text = (
      el.getAttribute("aria-label") ||
      textOf(el) ||
      (el as HTMLInputElement).value ||
      el.getAttribute("placeholder") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return { tag: el.tagName.toLowerCase(), ...(el.id ? { id: el.id } : {}), ...(text ? { text } : {}) };
  };

  // 可点击元素的可读名称
  const clickLabel = (el: Element) =>
    normalize(
      el.getAttribute("aria-label") ||
        textOf(el) ||
        (el as HTMLInputElement).value ||
        el.getAttribute("title") ||
        el.getAttribute("alt")
    );
  // 输入框的可读名称：关联 label、aria、占位符、name
  const fieldLabels = (el: Element): string[] => {
    const labels = Array.from((el as HTMLInputElement).labels ?? []).map((label) => textOf(label));
    const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? textOf(document.getElementById(id) ?? document.createElement("i")) : ""));
    return [
      ...labels,
      ...labelledBy,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("title"),
    ]
      .map(normalize)
      .filter(Boolean);
  };

  // 精确匹配优先于包含匹配；包含其他匹配的祖先被剔除，保留最内层
  const byText = (elements: Element[], labels: (el: Element) => string[], text: string): Element[] => {
    const wanted = normalize(text);
    const pick = (test: (label: string) => boolean) => {
      const matches = elements.filter((el) => labels(el).some(test));
      return matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    };
    const exact = pick((label) => label === wanted);
    return exact.length ? exact : pick((label) => label.includes(wanted));
  };

  // 引用保存在隔离世界全局，同一元素多次快照保持同一引用，导航后随文档失效
  const refStore = globalThis as {
    __bctlRefs?: Map<string, WeakRef<Element>>;
    __bctlRefIds?: WeakMap<Element, string>;
    __bctlRefSeq?: number;
  };
  const refFor = (el: Element): string => {
    const refs = (refStore.__bctlRefs ??= new Map());
    const ids = (refStore.__bctlRefIds ??= new WeakMap());
    let id = ids.get(el);
    if (!id) {
      refStore.__bctlRefSeq = (refStore.__bctlRefSeq ?? 0) + 1;
      id = `e${refStore.__bctlRefSeq}`;
      ids.set(el, id);
    }
    refs.set(id, new WeakRef(el));
    return id;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      return type === "search" ? "searchbox" : "textbox";
    }
    if ((el as HTMLElement).isContentEditable || el.matches(CONTENT_EDITABLE)) return "textbox";
    return /^h[1-6]$/.test(tag) ? "heading" : tag;
  };
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const nameOf = (el: Element): string => {
    const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((item): item is HTMLElement => Boolean(item))
      .map(textOf)
      .join(" ");
    const labels = Array.from((el as HTMLInputElement).labels ?? [])
      .map(textOf)
      .join(" ");
    const editable = el.matches(EDITABLE);
    return clean(
      el.getAttribute("aria-label") ||
        labelledBy ||
        labels ||
        (editable ? "" : textOf(el)) ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        (editable ? "" : (el as HTMLInputElement).value)
    );
  };
  const inside = (scope: Element, el: Element) => {
    for (let node: Node | null = el; node; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
      if (node === scope) return true;
    }
    return false;
  };

  const snapshot = (selector: string | undefined, max: number): PageSnapshot => {
    const scope = selector ? queryAll(selector)[0] : undefined;
    if (selector && !scope) throw new ActionError("SELECTOR_NOT_FOUND", `no element matches selector: ${selector}`);
    for (const [id, ref] of refStore.__bctlRefs ?? []) {
      if (!ref.deref()?.isConnected) refStore.__bctlRefs!.delete(id);
    }
    const candidates = roots()
      .flatMap((root) => Array.from(root.querySelectorAll(`${CLICKABLE},${EDITABLE},h1,h2,h3,h4,h5,h6`)))
      .filter((el) => {
        if (scope && !inside(scope, el)) return false;
        if (el.tagName === "LABEL" && (el as HTMLLabelElement).control) return false;
        if (el.tagName === "OPTION") return false;
        if (el.getAttribute("tabindex") === "-1" && !el.matches(EDITABLE) && roleOf(el) === el.tagName.toLowerCase())
          return false;
        return visible(el);
      });
    const elements = candidates.slice(0, max).map((el): PageSnapshotElement => {
      const role = roleOf(el);
      const entry: PageSnapshotElement = { role, name: nameOf(el) };
      if (role === "heading") {
        entry.level = Number(el.tagName[1]) || Number(el.getAttribute("aria-level")) || 2;
        return entry;
      }
      entry.ref = refFor(el);
      if (el instanceof HTMLSelectElement) entry.value = clean(el.selectedOptions[0]?.text ?? el.value);
      else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
        entry.checked = el.checked;
      else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.value) entry.value = el instanceof HTMLInputElement && el.type === "password" ? "***" : clean(el.value);
      }
      const ariaChecked = el.getAttribute("aria-checked");
      if (ariaChecked) entry.checked = ariaChecked === "true";
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
      const href = el.tagName === "A" ? el.getAttribute("href") : null;
      if (href && !href.startsWith("javascript:")) entry.href = href;
      return entry;
    });
    return {
      url: location.href,
      title: document.title,
      elements,
      total: candidates.length,
      ...(candidates.length > max ? { truncated: true } : {}),
    };
  };

  // 文件输入常被隐藏并由 label 或拖放区代替，定位到这些元素时取其关联或包含的文件输入
  const FILE_INPUT = "input[type=file]";
  const fileInputOf = (el: Element): HTMLInputElement | undefined => {
    if (el.matches(FILE_INPUT)) return el as HTMLInputElement;
    const control = el instanceof HTMLLabelElement ? el.control : null;
    if (control?.matches(FILE_INPUT)) return control as HTMLInputElement;
    return el.querySelector<HTMLInputElement>(FILE_INPUT) ?? undefined;
  };

  const locate = (locator: PageLocator, kind: "click" | "edit" | "upload"): Element => {
    let matches: Element[];
    if (locator.ref) {
      const refs = (globalThis as { __bctlRefs?: Map<string, WeakRef<Element>> }).__bctlRefs;
      const el = refs?.get(locator.ref)?.deref();
      if (!el || !el.isConnected)
        throw new ActionError("REF_NOT_FOUND", `ref ${locator.ref} is stale; take a new snapshot`);
      matches = [el];
    } else if (locator.selector) {
      matches = queryAll(locator.selector);
      if (locator.text) matches = byText(matches, (el) => [clickLabel(el), ...fieldLabels(el)], locator.text);
    } else if (locator.text) {
      const all = roots().flatMap((root) => Array.from(root.querySelectorAll("*")));
      if (kind === "upload") {
        matches = byText(
          all.filter((el) => el.matches(`${FILE_INPUT},${CLICKABLE}`)),
          (el) => [clickLabel(el), ...fieldLabels(el)],
          locator.text
        );
      } else if (kind === "edit") {
        matches = byText(
          all.filter((el) => el.matches(EDITABLE)),
          fieldLabels,
          locator.text
        );
      } else {
        matches = byText(
          all.filter((el) => el.matches(CLICKABLE)),
          (el) => [clickLabel(el)],
          locator.text
        );
        // 无可交互元素命中时，按文本找最内层元素再上溯到可点击祖先
        if (!matches.length) {
          matches = byText(all, (el) => [normalize(textOf(el))], locator.text).map((el) => el.closest(CLICKABLE) ?? el);
        }
      }
    } else if (kind === "upload") {
      matches = queryAll(FILE_INPUT);
    } else {
      throw new ActionError("INVALID_ARGUMENT", "provide a selector, --text, or a ref");
    }
    if (kind === "upload") {
      const inputs = matches.map(fileInputOf).filter((el): el is HTMLInputElement => Boolean(el));
      if (matches.length && !inputs.length)
        throw new ActionError(
          "NOT_FILE_INPUT",
          `no file input at or inside ${locator.selector ?? `text "${locator.text}"`}`
        );
      matches = inputs;
    }
    const shown = [...new Set(matches)].filter(kind === "upload" ? (el: Element) => el.isConnected : visible);
    const target = locator.selector ?? (locator.text ? `text "${locator.text}"` : "file input");
    if (!shown.length) throw new ActionError("SELECTOR_NOT_FOUND", `no visible element matches ${target}`);
    if (locator.nth !== undefined) {
      const el = shown[locator.nth - 1];
      if (!el) throw new ActionError("SELECTOR_NOT_FOUND", `${target} has ${shown.length} matches, not ${locator.nth}`);
      return el;
    }
    if (shown.length > 1) {
      const candidates = shown
        .slice(0, 5)
        .map((el, i) => `${i + 1}: <${summary(el).tag}> ${summary(el).text ?? ""}`.trim())
        .join("; ");
      throw new ActionError("AMBIGUOUS_MATCH", `${shown.length} elements match ${target}; pass --nth (${candidates})`);
    }
    return shown[0];
  };

  const setNative = (el: Element, prop: "value", value: string) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, prop)?.set;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
  };
  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));

  const selectOption = (el: Element, value: string): string => {
    if (!(el instanceof HTMLSelectElement))
      throw new ActionError("NOT_EDITABLE", `<${el.tagName.toLowerCase()}> is not a select`);
    const option =
      Array.from(el.options).find((item) => item.value === value) ??
      Array.from(el.options).find((item) => normalize(item.text) === normalize(value));
    if (!option) throw new ActionError("OPTION_NOT_FOUND", `no option matches ${value}`);
    setNative(el, "value", option.value);
    fire(el, "input");
    fire(el, "change");
    return option.value;
  };

  const pressKey = (target: Element, combo: string) => {
    const parts = combo.split("+");
    const key = parts.pop() || combo;
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    const init: KeyboardEventInit = {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt") || mods.has("option"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    };
    const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
    // 合成 Enter 不会触发浏览器默认提交，显式提交所在表单
    if (proceed && key === "Enter" && target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  };

  const waitFor = (selector: string | undefined, text: string | undefined, state: PageWaitState, timeoutMs: number) =>
    new Promise<PageElementSummary | undefined>((resolve, reject) => {
      const wanted = normalize(text);
      const evaluate = (): { done: boolean; el?: Element } => {
        if (selector) {
          let matches = queryAll(selector);
          if (wanted) matches = matches.filter((el) => normalize(textOf(el)).includes(wanted));
          const hit = state === "attached" ? matches[0] : matches.find(visible);
          return { done: state === "gone" ? !hit : Boolean(hit), el: hit };
        }
        const present = normalize(textOf(document.body)).includes(wanted);
        return { done: state === "gone" ? !present : present };
      };
      const done = (el?: Element) => resolve(el && state !== "gone" ? summary(el) : undefined);
      const initial = evaluate();
      if (initial.done) return done(initial.el);
      const finish = (error?: unknown, el?: Element) => {
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(timer);
        if (error) reject(error);
        else done(el);
      };
      const check = () => {
        try {
          const result = evaluate();
          if (result.done) finish(undefined, result.el);
        } catch (error) {
          finish(error);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      // 样式变化不一定产生变更记录，定时补充检查
      const interval = setInterval(check, 100);
      const timer = setTimeout(() => {
        const target = selector ?? `text "${text}"`;
        finish(new ActionError("WAIT_TIMEOUT", `${target} not ${state} after ${timeoutMs}ms`));
      }, timeoutMs);
    });

  try {
    switch (request.op) {
      case "click": {
        const el = locate(request, "click");
        el.scrollIntoView?.({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        (el as HTMLElement).click();
        return { success: true, value: { matched: summary(el) } };
      }
      case "fill": {
        const el = locate(request, "edit");
        if (el instanceof HTMLSelectElement) {
          return { success: true, value: { matched: summary(el), selected: selectOption(el, request.value) } };
        }
        (el as HTMLElement).focus?.();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          setNative(el, "value", request.value);
        } else if ((el as HTMLElement).isContentEditable || el.matches(CONTENT_EDITABLE)) {
          el.textContent = request.value;
        } else {
          throw new ActionError("NOT_EDITABLE", `<${el.tagName.toLowerCase()}> is not editable`);
        }
        fire(el, "input");
        fire(el, "change");
        return { success: true, value: { matched: summary(el) } };
      }
      case "select": {
        const el = locate(request, "edit");
        return { success: true, value: { matched: summary(el), selected: selectOption(el, request.value) } };
      }
      case "press": {
        const located = request.selector || request.text || request.ref ? locate(request, "click") : undefined;
        if (located) (located as HTMLElement).focus?.();
        const target = located ?? document.activeElement ?? document.body;
        pressKey(target, request.key);
        return { success: true, value: { matched: summary(target) } };
      }
      case "wait": {
        if (!request.selector && !request.text)
          throw new ActionError("INVALID_ARGUMENT", "wait needs --selector or --text");
        const matched = await waitFor(request.selector, request.text, request.state, request.timeoutMs);
        return { success: true, value: matched ? { matched } : {} };
      }
      case "snapshot":
        return { success: true, value: { snapshot: snapshot(request.selector, request.max) } };
      case "upload": {
        const input = locate(request, "upload") as HTMLInputElement;
        if (request.files.length > 1 && !input.multiple)
          throw new ActionError("INVALID_ARGUMENT", `${request.files.length} files given but the input takes one`);
        const transfer = new DataTransfer();
        for (const file of request.files) {
          const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
          transfer.items.add(new File([bytes], file.name, { type: file.type }));
        }
        input.files = transfer.files;
        fire(input, "input");
        fire(input, "change");
        return { success: true, value: { matched: summary(input) } };
      }
    }
  } catch (error) {
    if (error instanceof ActionError) return { success: false, code: error.code, error: error.message };
    return {
      success: false,
      code: "PAGE_ACTION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
