import { describe, expect, it } from "vitest";
import { runPageContent } from "./page-content";

describe("页面内容提取", () => {
  it("转换为 Markdown 并保留行内链接与格式", () => {
    document.body.innerHTML = `
      <main>
        <h1>Title</h1>
        <p>Hello <a href="https://a.test/x">link</a> and <strong>bold</strong>, <code>x()</code>.</p>
        <ul><li>One</li><li>Two <em>it</em><ol><li>Nested</li></ol></li></ul>
        <pre>let a = 1;\n  a++;</pre>
        <blockquote><p>Quote</p></blockquote>
        <table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>
        <div>Loose <span>text</span><div>Block</div></div>
        <img alt="Logo" src="https://a.test/logo.png">
      </main>`;
    const result = runPageContent({ selector: "main", format: "markdown" });
    expect(result).toEqual({
      success: true,
      value: [
        "# Title",
        "Hello [link](https://a.test/x) and **bold**, `x()`.",
        "- One\n- Two *it*\n  1. Nested",
        "```\nlet a = 1;\n  a++;\n```",
        "> Quote",
        "| K | V |\n| --- | --- |\n| a | 1 |",
        "Loose text",
        "Block",
        "![Logo](https://a.test/logo.png)",
      ].join("\n\n"),
    });
  });

  it("跳过脚本、样式与隐藏元素", () => {
    document.body.innerHTML = `<div>Shown<script>x()</script><style>p{}</style><p hidden>Hidden</p><p style="display: none">None</p></div>`;
    expect(runPageContent({ selector: "body", format: "markdown" })).toEqual({ success: true, value: "Shown" });
  });

  it("超过字符上限时截断并附加说明", () => {
    document.body.innerHTML = `<p>abcdefghij</p>`;
    expect(runPageContent({ selector: "body", format: "text", maxChars: 4 })).toEqual({
      success: true,
      value: "abcd\n\n[truncated: 4 of 10 characters; narrow --selector or raise --max-chars]",
    });
    expect(runPageContent({ selector: "body", format: "html", maxChars: 100 })).toEqual({
      success: true,
      value: "<p>abcdefghij</p>",
    });
  });

  it("选择器不匹配返回 SELECTOR_NOT_FOUND，无效选择器返回 INVALID_SELECTOR", () => {
    expect(runPageContent({ selector: "#none", format: "text" })).toMatchObject({
      success: false,
      code: "SELECTOR_NOT_FOUND",
    });
    expect(runPageContent({ selector: "[", format: "text" })).toMatchObject({
      success: false,
      code: "INVALID_SELECTOR",
    });
  });
});
