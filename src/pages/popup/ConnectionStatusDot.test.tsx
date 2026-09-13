import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ConnectionStatusDot from "./ConnectionStatusDot";

describe.concurrent("浏览器控制连接状态指示器", () => {
  it.each([
    ["connected", "success"],
    ["connecting", "warning"],
    ["disconnected", "error"],
    ["error", "error"],
  ] as const)("%s 状态应显示对应颜色", (status, color) => {
    const { container } = render(
      <ConnectionStatusDot status={{ status, hostName: "com.latentbyte.browser_control" }} />
    );

    const indicator = container.querySelector('[role="status"]')!;
    expect(indicator).toHaveAttribute("data-connection-status", status);
    expect(indicator.querySelector(`.arco-badge-status-${color}`)).toBeInTheDocument();
  });

  it("错误详情应出现在可访问标签中", () => {
    const { container } = render(
      <ConnectionStatusDot
        status={{ status: "error", hostName: "com.latentbyte.browser_control", lastError: "host unavailable" }}
      />
    );

    expect(container.querySelector('[role="status"]')).toHaveAccessibleName(
      "Browser Control: error (host unavailable)"
    );
  });
});
