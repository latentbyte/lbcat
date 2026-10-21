// 注入页面隔离世界执行的 DOM 动作；executeScript 会序列化函数，因此 runPageAction 必须完全自包含

export type PageLocator = { selector?: string; text?: string; ref?: string; nth?: number };
export type PageWaitState = "visible" | "attached" | "gone";
// observe 在动作前记录快照基线，供随后的差异快照比较
type PageActionOptions = PageLocator & { observe?: boolean };
export type PageActionRequest =
  | ({ op: "click"; point?: { x: number; y: number } } & PageActionOptions)
  | ({ op: "fill"; value: string } & PageActionOptions)
  | ({ op: "select"; value: string } & PageActionOptions)
  | ({ op: "press"; key: string } & PageActionOptions)
  | { op: "wait"; selector?: string; text?: string; state: PageWaitState; timeoutMs: number }
  | { op: "snapshot"; selector?: string; max: number; diff?: boolean }
  | { op: "resolve"; locators: PageLocator[] }
  | ({ op: "upload"; files: PageUploadFile[] } & PageActionOptions);
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
// 与观察基线相比的变化；changed 给出元素的新状态
export type PageSnapshotChanges = {
  url: string;
  title: string;
  added: PageSnapshotElement[];
  removed: PageSnapshotElement[];
  changed: PageSnapshotElement[];
  total: number;
  // 截断时给出变化总数
  truncated?: boolean;
  count?: number;
};
export type PageActionResult =
  | {
      success: true;
      value: {
        matched?: PageElementSummary;
        selected?: string;
        snapshot?: PageSnapshot;
        changes?: PageSnapshotChanges;
        refs?: string[];
      };
    }
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
    __bctlObserved?: PageSnapshotElement[];
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

  const snapshotTargets = (selector: string | undefined): Element[] => {
    const scope = selector ? queryAll(selector)[0] : undefined;
    if (selector && !scope) throw new ActionError("SELECTOR_NOT_FOUND", `no element matches selector: ${selector}`);
    for (const [id, ref] of refStore.__bctlRefs ?? []) {
      if (!ref.deref()?.isConnected) refStore.__bctlRefs!.delete(id);
    }
    return roots()
      .flatMap((root) => Array.from(root.querySelectorAll(`${CLICKABLE},${EDITABLE},h1,h2,h3,h4,h5,h6`)))
      .filter((el) => {
        if (scope && !inside(scope, el)) return false;
        if (el.tagName === "LABEL" && (el as HTMLLabelElement).control) return false;
        if (el.tagName === "OPTION") return false;
        if (el.getAttribute("tabindex") === "-1" && !el.matches(EDITABLE) && roleOf(el) === el.tagName.toLowerCase())
          return false;
        return visible(el);
      });
  };
  const describe = (el: Element): PageSnapshotElement => {
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
  };
  const snapshot = (selector: string | undefined, max: number): PageSnapshot => {
    const targets = snapshotTargets(selector);
    return {
      url: location.href,
      title: document.title,
      elements: targets.slice(0, max).map(describe),
      total: targets.length,
      ...(targets.length > max ? { truncated: true } : {}),
    };
  };
  // 整页基线（不截断），差异按集合比较才不会因截断位置移动而误报
  const observe = () => {
    refStore.__bctlObserved = snapshotTargets(undefined).map(describe);
  };
  // 有引用的元素按引用比对；标题没有引用，按级别与名称计数比对
  const diffKeys = (elements: PageSnapshotElement[]) => {
    const seen = new Map<string, number>();
    return elements.map((el) => {
      const base = el.ref ?? `h${el.level}:${el.name}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return `${base}#${count}`;
    });
  };
  // 无基线（未观察或已导航到新文档）或变化不少于元素总数时返回完整快照
  const diffSnapshot = (max: number): { snapshot: PageSnapshot } | { changes: PageSnapshotChanges } => {
    const before = refStore.__bctlObserved;
    delete refStore.__bctlObserved;
    if (!before) return { snapshot: snapshot(undefined, max) };
    const current = snapshotTargets(undefined).map(describe);
    const beforeKeys = diffKeys(before);
    const currentKeys = diffKeys(current);
    const previous = new Map(beforeKeys.map((key, i) => [key, before[i]]));
    const kept = new Set(currentKeys);
    const added: PageSnapshotElement[] = [];
    const changed: PageSnapshotElement[] = [];
    current.forEach((el, i) => {
      const old = previous.get(currentKeys[i]);
      if (!old) added.push(el);
      else if (JSON.stringify(old) !== JSON.stringify(el)) changed.push(el);
    });
    const removed = before.filter((_, i) => !kept.has(beforeKeys[i]));
    const count = added.length + removed.length + changed.length;
    if (count && count >= current.length) {
      return {
        snapshot: {
          url: location.href,
          title: document.title,
          elements: current.slice(0, max),
          total: current.length,
          ...(current.length > max ? { truncated: true } : {}),
        },
      };
    }
    let room = max;
    const take = (list: PageSnapshotElement[]) => {
      const shown = list.slice(0, room);
      room -= shown.length;
      return shown;
    };
    return {
      changes: {
        url: location.href,
        title: document.title,
        added: take(added),
        removed: take(removed),
        changed: take(changed),
        total: current.length,
        ...(count > max ? { truncated: true, count } : {}),
      },
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

  // 视口坐标命中的最内层元素：穿透开放 Shadow Root 与同源 iframe，坐标随框架换算
  const elementAt = (x: number, y: number): { el: Element; x: number; y: number } => {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const inner: Element | null = el.shadowRoot?.elementFromPoint(x, y) ?? null;
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
      if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") break;
      const frameDoc = (el as HTMLIFrameElement).contentDocument;
      if (!frameDoc)
        throw new ActionError(
          "CROSS_ORIGIN_FRAME",
          `point ${x},${y} is inside a cross-origin frame (${el.getAttribute("src") ?? "no src"}); open the frame URL in its own tab`
        );
      const rect = el.getBoundingClientRect();
      x -= rect.left + el.clientLeft;
      y -= rect.top + el.clientTop;
      el = frameDoc.elementFromPoint(x, y);
    }
    if (!el)
      throw new ActionError("NO_ELEMENT_AT_POINT", `no element at ${x},${y}; coordinates are viewport CSS pixels`);
    return { el, x, y };
  };
  const clickAt = (point: { x: number; y: number }): Element => {
    const { el, x, y } = elementAt(point.x, point.y);
    const view = el.ownerDocument.defaultView ?? window;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const Pointer = view.PointerEvent ?? view.MouseEvent;
    el.dispatchEvent(new Pointer("pointerdown", { ...init, buttons: 1 }));
    if (el.dispatchEvent(new view.MouseEvent("mousedown", { ...init, buttons: 1, detail: 1 })))
      (el.closest(`${EDITABLE},${CLICKABLE}`) as HTMLElement | null)?.focus?.();
    el.dispatchEvent(new Pointer("pointerup", init));
    el.dispatchEvent(new view.MouseEvent("mouseup", { ...init, detail: 1 }));
    el.dispatchEvent(new view.MouseEvent("click", { ...init, detail: 1 }));
    return el;
  };

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
    if ("observe" in request && request.observe) observe();
    switch (request.op) {
      case "click": {
        if (request.point) return { success: true, value: { matched: summary(clickAt(request.point)) } };
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
        if (request.diff) return { success: true, value: diffSnapshot(request.max) };
        return { success: true, value: { snapshot: snapshot(request.selector, request.max) } };
      // 引导标注：把各种定位统一换成引用，供隔离世界中的标注层取回元素
      case "resolve":
        return { success: true, value: { refs: request.locators.map((locator) => refFor(locate(locator, "click"))) } };
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
