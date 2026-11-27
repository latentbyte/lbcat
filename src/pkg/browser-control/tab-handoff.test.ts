import { describe, expect, it } from "vitest";
import { agentTabHandoff, grantForHandoff } from "./tab-handoff";

describe("交给代理的标签说明", () => {
  const tab = {
    browserName: "zen",
    sessionId: "ab12cd34",
    tabId: 116,
    title: "Create app",
    url: "https://example.com/apps/new",
  };

  it("应包含浏览器名、标签 ID、标题与网址", () => {
    const text = agentTabHandoff(tab);
    expect(text).toContain("Browser: zen");
    expect(text).toContain("Tab ID: 116");
    expect(text).toContain("Title: Create app");
    expect(text).toContain("URL: https://example.com/apps/new");
  });

  it("应给出带任务句柄的命令，无需新建任务、窗口或标签", () => {
    const text = agentTabHandoff(tab);
    expect(text).toContain("bctl --session zen:ab12cd34 page content 116");
    expect(text).toMatch(/Do not run `session begin`/);
    expect(text).toMatch(/Do not open this URL in a new tab or window/);
  });

  it("标题中的换行应压成单行", () => {
    expect(agentTabHandoff({ ...tab, title: "a\n  b" })).toContain("Title: a b");
  });
});

describe("复制时需要补上的授权", () => {
  it("专用窗口外且无授权的标签应授权给所有代理", () => {
    expect(grantForHandoff({ inAgentWindow: false })).toEqual({ mode: "all" });
  });

  it("已关闭访问的标签应改为授权给所有代理", () => {
    expect(grantForHandoff({ inAgentWindow: true, grant: { mode: "off" } })).toEqual({ mode: "all" });
  });

  it("已可访问的标签不应改动授权", () => {
    expect(grantForHandoff({ inAgentWindow: true })).toBeUndefined();
    expect(grantForHandoff({ inAgentWindow: false, grant: { mode: "all" } })).toBeUndefined();
    expect(grantForHandoff({ inAgentWindow: false, grant: { mode: "session", sessionId: "s1" } })).toBeUndefined();
  });
});
