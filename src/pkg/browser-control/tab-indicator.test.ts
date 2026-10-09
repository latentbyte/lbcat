import { describe, expect, it, vi } from "vitest";
import type { TabIndicator } from "./agent-window";
import { presentIndicator, TabIndicatorController, type TabIndicatorDependencies } from "./tab-indicator";

function owned(sessionId: string, label?: string, paused = false): TabIndicator {
  return { kind: "owned", sessionId, label, paused, expiresAt: 5000 };
}

function controller() {
  const deps = {
    setBadge: vi.fn<TabIndicatorDependencies["setBadge"]>(async () => {}),
    setOverlay: vi.fn<TabIndicatorDependencies["setOverlay"]>(async () => {}),
  };
  const instance = new TabIndicatorController(deps, { text: "●", color: "#4CAF50", title: "connected" });
  return { deps, instance };
}

describe("代理标签标识", () => {
  it("按任务标签生成缩写、稳定颜色与说明", () => {
    const first = presentIndicator(owned("abc-123", "claude fix login"));
    expect(first).toMatchObject({ text: "CF", label: "claude fix login" });
    expect(first.title).toContain("claude fix login");
    expect(presentIndicator(owned("abc-123", "other")).color).toBe(first.color);
    expect(presentIndicator(owned("abcdef12-9"))).toMatchObject({ text: "AB", label: "agent abcdef12" });
    expect(presentIndicator(owned("abc-123", "codex", true))).toMatchObject({ color: "#9E9E9E" });
    expect(presentIndicator(owned("abc-123", "codex", true)).title).toContain("paused");
    expect(presentIndicator({ kind: "off" })).toMatchObject({ text: "OFF" });
  });

  it("仅更新变化的标签并在移除时恢复全局徽标", () => {
    const { deps, instance } = controller();
    instance.apply(new Map([[1, owned("s1", "claude")]]));
    expect(deps.setBadge).toHaveBeenCalledWith(1, expect.objectContaining({ text: "CL" }));
    expect(deps.setOverlay).toHaveBeenCalledWith(1, expect.objectContaining({ label: "claude" }));
    deps.setBadge.mockClear();
    deps.setOverlay.mockClear();
    instance.apply(new Map([[1, owned("s1", "claude")]]));
    expect(deps.setBadge).not.toHaveBeenCalled();
    instance.apply(new Map());
    expect(deps.setBadge).toHaveBeenCalledWith(1, { text: "●", color: "#4CAF50", title: "connected" });
    expect(deps.setOverlay).toHaveBeenCalledWith(1, null);
  });

  it("关闭访问的标签只显示徽标而不在页面绘制边框", () => {
    const { deps, instance } = controller();
    instance.apply(new Map([[2, { kind: "off" }]]));
    expect(deps.setBadge).toHaveBeenCalledWith(2, expect.objectContaining({ text: "OFF" }));
    expect(deps.setOverlay).toHaveBeenCalledWith(2, null);
  });

  it("页面导航后重新绘制当前标识", () => {
    const { deps, instance } = controller();
    instance.apply(new Map([[1, owned("s1", "claude")]]));
    deps.setOverlay.mockClear();
    instance.refresh(1);
    instance.refresh(9);
    expect(deps.setOverlay).toHaveBeenCalledTimes(1);
    expect(deps.setOverlay).toHaveBeenCalledWith(1, expect.objectContaining({ label: "claude" }));
  });

  it("全局徽标变化时同步已恢复默认的标签颜色而不覆盖代理标签", () => {
    const { deps, instance } = controller();
    instance.apply(
      new Map([
        [1, owned("s1")],
        [2, owned("s2")],
      ])
    );
    instance.apply(new Map([[2, owned("s2")]]));
    deps.setBadge.mockClear();
    instance.setDefaults({ text: "×", color: "#F44336", title: "disconnected" });
    expect(deps.setBadge).toHaveBeenCalledTimes(1);
    expect(deps.setBadge).toHaveBeenCalledWith(1, { text: "×", color: "#F44336", title: "disconnected" });
  });

  it("标签关闭后不再跟踪", () => {
    const { deps, instance } = controller();
    instance.apply(new Map([[1, owned("s1")]]));
    instance.forget(1);
    deps.setBadge.mockClear();
    instance.apply(new Map());
    instance.setDefaults({ text: "×", color: "#F44336", title: "disconnected" });
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it("返回最早的租约到期时间用于刷新", () => {
    const { instance } = controller();
    expect(instance.nextExpiry()).toBeUndefined();
    instance.apply(
      new Map<number, TabIndicator>([
        [1, { ...owned("s1"), expiresAt: 900 } as TabIndicator],
        [2, owned("s2")],
        [3, { kind: "off" }],
      ])
    );
    expect(instance.nextExpiry()).toBe(900);
  });
});
