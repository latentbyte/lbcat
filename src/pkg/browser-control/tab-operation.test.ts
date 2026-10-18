import { afterEach, describe, expect, it, vi } from "vitest";
import { withNativeTabOperation, startNativeTabOperations, stopNativeTabOperations } from "./tab-operation";

describe("标签执行队列的文档边界", () => {
  afterEach(() => {
    stopNativeTabOperations();
    vi.unstubAllGlobals();
  });

  it("仅主文档提交可恢复队列且旧执行完成不得释放新执行", async () => {
    let committed!: (info: { tabId: number; frameId: number }) => void;
    vi.stubGlobal("chrome", {
      webNavigation: {
        onCommitted: {
          addListener: (fn: typeof committed) => {
            committed = fn;
          },
          removeListener: vi.fn(),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    startNativeTabOperations();
    let oldRelease!: () => void;
    let quarantine!: () => void;
    const old = withNativeTabOperation(301, async (operation) => {
      operation.bindToDocument();
      quarantine = operation.quarantine;
      return new Promise<void>((resolve) => {
        oldRelease = resolve;
      });
    });
    const oldError = expect(old).rejects.toMatchObject({ code: "TAB_DOCUMENT_CHANGED" });
    await vi.waitFor(() => expect(quarantine).toBeTypeOf("function"), { interval: 1 });
    quarantine();
    committed({ tabId: 301, frameId: 2 });
    await expect(withNativeTabOperation(301, async () => 1)).rejects.toMatchObject({ code: "TAB_EXECUTION_PENDING" });
    committed({ tabId: 301, frameId: 0 });
    await oldError;
    let newRelease!: () => void;
    const current = withNativeTabOperation(
      301,
      () =>
        new Promise<void>((resolve) => {
          newRelease = resolve;
        })
    );
    await vi.waitFor(() => expect(newRelease).toBeTypeOf("function"), { interval: 1 });
    oldRelease();
    const action = vi.fn(async () => 2);
    const queued = withNativeTabOperation(301, action);
    await Promise.resolve();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    newRelease();
    await current;
    await expect(queued).resolves.toBe(2);
  });

  it("超时应拒绝已排队工作但不同标签仍可并发", async () => {
    let release!: () => void;
    let quarantine!: () => void;
    const running = withNativeTabOperation(302, async (operation) => {
      quarantine = operation.quarantine;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await vi.waitFor(() => expect(quarantine).toBeTypeOf("function"), { interval: 1 });
    const action = vi.fn(async () => 2);
    const queued = withNativeTabOperation(302, action);
    const rejected = expect(queued).rejects.toMatchObject({ code: "TAB_EXECUTION_PENDING" });
    quarantine();
    await rejected;
    expect(action).not.toHaveBeenCalled();
    await expect(withNativeTabOperation(303, async () => 3)).resolves.toBe(3);
    release();
    await running;
    await expect(withNativeTabOperation(302, action)).resolves.toBe(2);
  });

  it("运行超时的操作应隔离队列且仅主文档提交后恢复", async () => {
    let committed!: (info: { tabId: number; frameId: number }) => void;
    vi.stubGlobal("chrome", {
      webNavigation: {
        onCommitted: {
          addListener: (fn: typeof committed) => {
            committed = fn;
          },
          removeListener: vi.fn(),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    startNativeTabOperations();
    const hung = withNativeTabOperation(305, () => new Promise<void>(() => {}), { timeoutMs: 5, label: "page.click" });
    await expect(hung).rejects.toThrow("page.click timed out after 5ms");
    await expect(withNativeTabOperation(305, async () => 1)).rejects.toMatchObject({ code: "TAB_EXECUTION_PENDING" });
    committed({ tabId: 305, frameId: 1 });
    await expect(withNativeTabOperation(305, async () => 1)).rejects.toMatchObject({ code: "TAB_EXECUTION_PENDING" });
    committed({ tabId: 305, frameId: 0 });
    await expect(withNativeTabOperation(305, async () => 2)).resolves.toBe(2);
  });

  it("排队期间超时的操作不得在之后执行且不得让后续操作越过运行中的操作", async () => {
    let release!: () => void;
    const running = withNativeTabOperation(
      306,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { interval: 1 });
    const expired = vi.fn(async () => 1);
    await expect(withNativeTabOperation(306, expired, { timeoutMs: 5, label: "page.content" })).rejects.toThrow(
      "page.content timed out after 5ms"
    );
    const following = vi.fn(async () => 2);
    const queued = withNativeTabOperation(306, following);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(following).not.toHaveBeenCalled();
    release();
    await running;
    await expect(queued).resolves.toBe(2);
    expect(expired).not.toHaveBeenCalled();
  });

  it("复合截图期间导航不得让后续操作与截图清理并发", async () => {
    let committed!: (info: { tabId: number; frameId: number }) => void;
    vi.stubGlobal("chrome", {
      webNavigation: {
        onCommitted: {
          addListener: (fn: typeof committed) => {
            committed = fn;
          },
          removeListener: vi.fn(),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    startNativeTabOperations();
    let release!: () => void;
    const capture = withNativeTabOperation(
      304,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { interval: 1 });
    committed({ tabId: 304, frameId: 0 });
    const action = vi.fn(async () => 1);
    const following = withNativeTabOperation(304, action);
    await Promise.resolve();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    release();
    await capture;
    await expect(following).resolves.toBe(1);
  });
});
