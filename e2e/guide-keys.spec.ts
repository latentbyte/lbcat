import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { renderGuideOverlay, type GuideOverlayView } from "../src/pkg/browser-control/guide-overlay";

// 页面快捷键回归：Gmail 这类页面在 keydown 上把不可编辑目标当成快捷键并 preventDefault，
// 曾经会吃掉人工在引导卡片里输入的字符。卡片现在在自己的 iframe 文档里，页面拿不到这些按键。
// 用真实键盘事件（page.keyboard）验证，合成事件测不出默认行为被取消的后果。
const view: GuideOverlayView = {
  stepId: 1,
  title: "Forwarding",
  text: "Type the address",
  marks: [],
  state: "step",
};

// 三种页面监听方式：冒泡、window 捕获、以及按 document.activeElement 判断可编辑性
const where = ["bubble", "window-capture", "active-element"] as const;
const page = (kind: (typeof where)[number]) => `<!doctype html>
<meta charset="utf-8">
<body>
<input id="page-field">
<script>
  window.__seen = [];
  const editable = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
  const onKey = (event) => {
    window.__seen.push({ key: event.key, target: event.target.tagName, active: document.activeElement?.tagName });
    const scope = ${JSON.stringify(kind)} === "active-element" ? document.activeElement : event.target;
    if (editable(scope)) return;
    event.preventDefault();
  };
  if (${JSON.stringify(kind)} === "window-capture") window.addEventListener("keydown", onKey, true);
  else document.addEventListener("keydown", onKey);
</script>
</body>`;

async function serve(context: { newPage: () => Promise<Page> }, kind: string, csp?: string) {
  const target = await context.newPage();
  await target.route("**/guide.html", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: csp ? { "content-security-policy": csp } : {},
      body: page(kind as (typeof where)[number]),
    })
  );
  await target.goto("http://guide.test/guide.html");
  return target;
}

async function injectGuide(target: Page) {
  await target.evaluate(
    ({ src, guide }) => {
      const render = (0, eval)(`(${src})`);
      render(guide, { message: "test.guide" });
    },
    { src: renderGuideOverlay.toString(), guide: view }
  );
  await target.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("lbcat-agent-guide iframe");
    frame?.contentDocument?.querySelector("textarea")?.focus();
  });
}

// 未打包扩展的 ID 由绝对路径哈希得出
const extensionId = (dir: string) =>
  [...crypto.createHash("sha256").update(dir).digest("hex").slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");

const cardValue = (target: Page) =>
  target.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("lbcat-agent-guide iframe");
    return {
      value: frame?.contentDocument?.querySelector("textarea")?.value ?? "",
      seen: (window as unknown as { __seen: { key: string }[] }).__seen.map((item) => item.key),
    };
  });

test("浏览器加载的是刚构建的 Chrome 扩展", async ({ context }) => {
  const dir = path.resolve(__dirname, "../dist/ext/chrome");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId(dir)}/src/options.html`);
  const built = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version;
  expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(built);
  await page.close();
});

for (const kind of where) {
  test(`卡片里输入的字符不被页面的 ${kind} 快捷键监听吃掉`, async ({ context }) => {
    const target = await serve(context, kind);
    await injectGuide(target);

    await target.keyboard.type("cheese");
    const card = await cardValue(target);
    expect(card.value).toBe("cheese");
    // 页面完全看不到卡片里的按键，自然也不会把它们当快捷键
    expect(card.seen).toEqual([]);

    // 页面自己的输入照常收到按键
    await target.click("#page-field");
    await target.keyboard.type("ab");
    expect(await target.evaluate(() => (document.getElementById("page-field") as HTMLInputElement).value)).toBe("ab");
    await target.close();
  });
}

test("严格 CSP 的页面（frame-src 'none'）也能画卡片并输入", async ({ context }) => {
  const target = await serve(
    context,
    "window-capture",
    "default-src 'none'; frame-src 'none'; script-src 'unsafe-inline'"
  );
  await injectGuide(target);
  await target.keyboard.type("forward");
  expect((await cardValue(target)).value).toBe("forward");
  await target.close();
});
