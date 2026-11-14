import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PopupWarnings from "./index";
import type * as Utils from "@App/pkg/utils/utils";

vi.mock("../BrowserControlCard", () => ({ default: () => null }));
vi.mock("@App/pkg/utils/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof Utils>()),
  checkUserScriptsAvailable: () => Promise.resolve(true),
  isPermissionOk: () => Promise.resolve(true),
}));

const hostName = "com.latentbyte.browser_control";

describe("弹窗中的浏览器控制提示", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", { ...globalThis.chrome, action: { getBadgeText: () => Promise.resolve("") } });
  });

  it("未安装配套工具时显示安装说明而不是错误", () => {
    render(
      <PopupWarnings
        isBlacklist={false}
        nativeStatus={{ status: "not_installed", hostName, lastError: "Specified native messaging host not found." }}
      />
    );

    expect(screen.queryByText(/Specified native messaging host not found/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Browser Control not_installed/)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /set up agent control/i });
    expect(link).toHaveAttribute("href", "https://github.com/latentbyte/lbcat#install");
  });

  it("真正的连接错误仍显示错误详情", () => {
    render(
      <PopupWarnings
        isBlacklist={false}
        nativeStatus={{ status: "error", hostName, lastError: "Native host has exited." }}
      />
    );

    expect(screen.getByText(/Native host has exited/)).toBeInTheDocument();
  });
});
