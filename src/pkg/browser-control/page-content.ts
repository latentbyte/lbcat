export type PageContentFormat = "text" | "html" | "markdown";
export type PageContentRequest = { selector: string; format: PageContentFormat; maxChars?: number };
export type PageContentResult = { success: true; value: string } | { success: false; code: string; error: string };

// 通过 executeScript 注入：必须自包含，不能引用模块作用域
export function runPageContent(request: PageContentRequest): PageContentResult {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "HEAD", "LINK", "META"]);
  const BLOCK = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DETAILS",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "UL",
  ]);

  const hidden = (el: Element): boolean => {
    if (SKIP.has(el.tagName.toUpperCase())) return true;
    if ((el as HTMLElement).hidden) return true;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  };
  const collapse = (text: string) => text.replace(/\s+/g, " ");

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return collapse(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (hidden(el)) return "";
    const inner = () => Array.from(el.childNodes).map(inline).join("");
    switch (el.tagName) {
      case "BR":
        return "\n";
      case "IMG": {
        const alt = el.getAttribute("alt")?.trim();
        return alt ? `![${alt}](${(el as HTMLImageElement).src})` : "";
      }
      case "A": {
        const text = inner().trim();
        const href = (el as HTMLAnchorElement).href;
        return text && href && !href.startsWith("javascript:") ? `[${text}](${href})` : text;
      }
      case "CODE":
        return "`" + (el.textContent ?? "") + "`";
      case "STRONG":
      case "B": {
        const text = inner().trim();
        return text ? `**${text}**` : "";
      }
      case "EM":
      case "I": {
        const text = inner().trim();
        return text ? `*${text}*` : "";
      }
      default:
        return inner();
    }
  };

  const tidy = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim();

  const list = (el: Element, depth: number): string => {
    const ordered = el.tagName === "OL";
    let n = 0;
    const lines: string[] = [];
    for (const item of Array.from(el.children)) {
      if (item.tagName !== "LI" || hidden(item)) continue;
      n++;
      const nested: string[] = [];
      const text = Array.from(item.childNodes)
        .filter((child) => {
          const sub = child as Element;
          if (sub.tagName === "UL" || sub.tagName === "OL") {
            if (!hidden(sub)) nested.push(list(sub, depth + 1));
            return false;
          }
          return true;
        })
        .map(inline)
        .join("");
      lines.push(`${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${tidy(collapse(text))}`);
      lines.push(...nested.filter(Boolean));
    }
    return lines.join("\n");
  };

  const table = (el: HTMLTableElement): string => {
    const rows = Array.from(el.rows)
      .filter((row) => !hidden(row))
      .map(
        (row) =>
          `| ${Array.from(row.cells)
            .map((cell) => tidy(collapse(inline(cell))))
            .join(" | ")} |`
      );
    if (rows.length === 0) return "";
    const columns = el.rows[0].cells.length;
    return [rows[0], `| ${Array(columns).fill("---").join(" | ")} |`, ...rows.slice(1)].join("\n");
  };

  const blocks = (container: Element, out: string[]) => {
    let run = "";
    const flush = () => {
      const text = tidy(run);
      if (text) out.push(text);
      run = "";
    };
    for (const child of Array.from(container.childNodes)) {
      const el = child as Element;
      if (child.nodeType !== Node.ELEMENT_NODE || !BLOCK.has(el.tagName)) {
        run += inline(child);
        continue;
      }
      if (hidden(el)) continue;
      flush();
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const text = tidy(collapse(inline(el)));
        if (text) out.push(`${"#".repeat(Number(tag[1]))} ${text}`);
      } else if (tag === "UL" || tag === "OL") {
        const text = list(el, 0);
        if (text) out.push(text);
      } else if (tag === "PRE") {
        out.push("```\n" + (el.textContent ?? "").replace(/\n$/, "") + "\n```");
      } else if (tag === "BLOCKQUOTE") {
        const inner: string[] = [];
        blocks(el, inner);
        if (inner.length) out.push(inner.join("\n\n").replace(/^/gm, "> "));
      } else if (tag === "TABLE") {
        const text = table(el as HTMLTableElement);
        if (text) out.push(text);
      } else if (tag === "HR") {
        out.push("---");
      } else {
        blocks(el, out);
      }
    }
    flush();
  };

  let root: Element | null;
  try {
    root = document.querySelector(request.selector);
  } catch (error) {
    return {
      success: false,
      code: "INVALID_SELECTOR",
      error: `invalid selector ${request.selector}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!root)
    return { success: false, code: "SELECTOR_NOT_FOUND", error: `no element matches selector: ${request.selector}` };

  let value: string;
  if (request.format === "html") value = root.innerHTML;
  else if (request.format === "markdown") {
    const out: string[] = [];
    blocks(root, out);
    value = out.join("\n\n");
  } else value = (root as HTMLElement).innerText ?? root.textContent ?? "";

  const maxChars = request.maxChars ?? 0;
  if (maxChars > 0 && value.length > maxChars) {
    value =
      value.slice(0, maxChars) +
      `\n\n[truncated: ${maxChars} of ${value.length} characters; narrow --selector or raise --max-chars]`;
  }
  return { success: true, value };
}
