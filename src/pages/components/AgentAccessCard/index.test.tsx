import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabAccessView } from "@App/pkg/browser-control/agent-window";
import AgentAccessCard from "./index";

vi.mock("@App/pkg/utils/utils", () => ({
  getCurrentTab: vi.fn(async () => ({ id: 116, title: "Create app", url: "https://example.com/apps/new" })),
}));
vi.mock("@App/pkg/browser-control/identity", () => ({
  resolveBrowserControlIdentity: vi.fn(async () => ({ browserName: "zen", appName: "Zen" })),
}));

describe("弹出页代理访问卡片的复制按钮", () => {
  let view: TabAccessView;
  const sent: Array<Record<string, unknown>> = [];
  const writeText = vi.fn(async (_text: string) => {});

  beforeEach(() => {
    sent.length = 0;
    writeText.mockClear();
    view = { tabId: 116, inAgentWindow: false, sessions: [] };
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(((message: Record<string, unknown>, callback: any) => {
      sent.push(message);
      if (message.action === "grant") view = { ...view, grant: message.grant as TabAccessView["grant"] };
      callback({ ok: true, data: view });
    }) as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("未授权的标签点击后应授权并复制说明", async () => {
    const { findByText } = render(<AgentAccessCard />);
    fireEvent.click(await findByText("Allow and copy for agent"));

    await waitFor(() => expect(sent.some((message) => message.action === "grant")).toBe(true));
    expect(sent.find((message) => message.action === "grant")).toMatchObject({ tabId: 116, grant: { mode: "all" } });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("Tab ID: 116");
    expect(writeText.mock.calls[0][0]).toContain("Browser: zen");
    await findByText("Copied");
  });

  it("已授权的标签只复制，不改授权", async () => {
    view = { ...view, grant: { mode: "all" } };
    const { findByText } = render(<AgentAccessCard />);
    fireEvent.click(await findByText("Copy for agent"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(sent.some((message) => message.action === "grant")).toBe(false);
  });
});
