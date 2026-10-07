import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessageQueue } from "@Packages/message/message_queue";
import type { Server } from "@Packages/message/server";
import type { IOffscreenSend, TMessage } from "@Packages/message/types";
import { sendMessage } from "@Packages/message/client";

const state = vi.hoisted(() => ({
  offscreen: null as IOffscreenSend | null,
  queue: null as IMessageQueue | null,
  ready: vi.fn(),
  env: { isFirefox: true, inIncognitoContext: false },
}));

vi.mock("./app/migrate", () => ({ default: vi.fn(), migrateChromeStorage: vi.fn() }));
vi.mock("./app/repo/resource", () => ({ cleanInvalidKeys: vi.fn() }));
vi.mock("./app/logger/db_writer", () => ({
  default: class {
    write() {}
  },
}));
vi.mock("./app/repo/logger", () => ({ LoggerDAO: class {} }));
vi.mock("./app/service/offscreen/gm_api", () => ({
  default: class {
    init() {}
  },
}));
vi.mock("./app/service/service_worker", () => ({
  default: class {
    constructor(
      private api: Server,
      private queue: IMessageQueue,
      private offscreen: IOffscreenSend
    ) {
      state.offscreen = offscreen;
      state.queue = queue;
    }

    initManager() {
      this.api.on("getExtensionEnv", () => state.env);
      this.api.on("preparationOffscreen", () => this.queue.emit("preparationOffscreen", {}));
      this.api.on("runtime/gmApi", (_params, sender) => {
        const connection = sender.getConnect()!;
        connection.onMessage((data) => connection.sendMessage(data));
        return { accepted: true };
      });
      this.queue.subscribe("preparationOffscreen", state.ready);
      this.offscreen.init();
    }
  },
}));

describe("Firefox 后台页内部通信", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.ready.mockClear();
    vi.spyOn(chrome.runtime, "sendMessage").mockImplementation((_message, callback) => {
      // Firefox 不会把消息投递回发送消息的同一后台页
      if (typeof callback === "function") callback(undefined);
      return Promise.resolve(undefined);
    });
    vi.spyOn(chrome.runtime.onMessage, "addListener").mockImplementation(() => {});
    vi.spyOn(chrome.runtime.onConnect, "addListener").mockImplementation(() => {});
    vi.spyOn(chrome.runtime, "getURL").mockImplementation((path) => `moz-extension://test/${path}`);
    await import("./service_worker.js");
  });

  afterEach(() => {
    document.querySelectorAll("iframe").forEach((iframe) => iframe.remove());
    vi.restoreAllMocks();
  });

  it("沙盒可以通过后台页内部通道获取扩展环境", async () => {
    const env = await sendMessage(state.offscreen!, "offscreen/getExtensionEnv", { requireUAD: true });
    expect(env).toEqual(state.env);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("只在沙盒就绪后通知后台运行时", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.ready).not.toHaveBeenCalled();
    await sendMessage(state.offscreen!, "offscreen/preparationSandbox");
    expect(state.ready).toHaveBeenCalledOnce();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("后台页发布的语言广播能够送达同页沙盒", () => {
    const sandbox = document.querySelector("iframe")!.contentWindow!;
    const postMessage = vi.spyOn(sandbox, "postMessage").mockImplementation(() => {});
    state.queue!.publish("setSandboxLanguage", "en-US");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { action: "sandbox/setSandboxLanguage", data: "en-US" },
      }),
      "*"
    );
  });

  it("后台 GM 连接保留首个回复并支持双向消息与断开", async () => {
    const connection = await state.offscreen!.connect({ action: "serviceWorker/runtime/gmApi" });
    const messages: TMessage[] = [];
    connection.onMessage((data) => messages.push(data));
    await Promise.resolve();
    expect(messages).toEqual([{ code: 0, data: { accepted: true } }]);
    connection.sendMessage({ action: "echo", data: "gm-value" });
    await Promise.resolve();
    await Promise.resolve();
    expect(messages[1]).toEqual({ action: "echo", data: "gm-value" });
    const disconnected = vi.fn();
    connection.onDisconnect(disconnected);
    connection.disconnect();
    expect(disconnected).toHaveBeenCalledWith(true);
    connection.sendMessage({ action: "echo", data: "after-disconnect" });
    await Promise.resolve();
    expect(messages).toHaveLength(2);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
