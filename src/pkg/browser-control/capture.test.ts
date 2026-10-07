import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeTab } from "./capture";

describe("原生标签截图区域", () => {
  const captureTab = vi.fn();

  beforeEach(() => {
    captureTab.mockReset().mockResolvedValue("data:image/png;base64,test");
    vi.stubGlobal("chrome", {
      tabs: { captureTab },
      scripting: {
        executeScript: async ({
          func,
          args,
        }: {
          func: (selector: string | null, fullPage: boolean) => unknown;
          args: [string | null, boolean];
        }) => [{ result: func(...args) }],
      },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("小数元素边界应向外取整以匹配 CLI 整数尺寸", async () => {
    const element = document.createElement("div");
    element.id = "target";
    document.body.append(element);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 1.4,
      y: 2.7,
      width: 100.2,
      height: 50.2,
      left: 1.4,
      top: 2.7,
      right: 101.6,
      bottom: 52.9,
      toJSON: () => ({}),
    });

    await expect(captureNativeTab(101, { selector: "#target" })).resolves.toMatchObject({ width: 101, height: 51 });
    expect(captureTab).toHaveBeenCalledWith(101, { format: "png", rect: { x: 1, y: 2, width: 101, height: 51 } });
  });

  it("空元素应报错且不调用截图 API", async () => {
    const element = document.createElement("div");
    element.id = "target";
    document.body.append(element);
    await expect(captureNativeTab(101, { selector: "#target" })).rejects.toThrow("no visible area");
    expect(captureTab).not.toHaveBeenCalled();
  });
});
