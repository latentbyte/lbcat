import { describe, expect, it, vi, afterEach } from "vitest";
import { ExtensionMessage } from "./extension_message";

type Listener = (...args: any[]) => any;

const makeEvent = () => {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: vi.fn((fn: Listener) => {
      listeners.push(fn);
    }),
    fire: (...args: any[]) => listeners.map((fn) => fn(...args)),
  };
};

// Firefox 在授予 userScripts 权限前不会暴露 onUserScriptMessage / onUserScriptConnect
const stubChromeWithoutUserScripts = () => {
  const runtime: Record<string, any> = {
    lastError: undefined,
    onMessage: makeEvent(),
    onConnect: makeEvent(),
  };
  const permissionsOnAdded = makeEvent();
  vi.stubGlobal("chrome", { runtime, permissions: { onAdded: permissionsOnAdded } });
  const grantUserScripts = () => {
    runtime.onUserScriptMessage = makeEvent();
    runtime.onUserScriptConnect = makeEvent();
  };
  return { runtime, permissionsOnAdded, grantUserScripts };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExtensionMessage userScripts 监听", () => {
  it("后台启动后在 about:addons 授予 userScripts 权限时应挂上用户脚本监听且只挂一次", () => {
    const { runtime, permissionsOnAdded, grantUserScripts } = stubChromeWithoutUserScripts();
    const message = new ExtensionMessage(true);
    message.onMessage(() => undefined);
    message.onConnect(() => undefined);
    expect(message.userScriptListenersAttached()).toEqual({ message: false, connect: false });

    grantUserScripts();
    permissionsOnAdded.fire({ permissions: ["userScripts"] });
    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);

    // 再次授予以及 popup 的 LISTEN_CONNECTIONS 都不应重复挂载
    permissionsOnAdded.fire({ permissions: ["userScripts"] });
    const sendResponse = vi.fn();
    runtime.onMessage.fire({ type: "userScripts.LISTEN_CONNECTIONS" }, {}, sendResponse);

    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith(true);
    expect(message.userScriptListenersAttached()).toEqual({ message: true, connect: true });
  });

  it("授予其他权限时不应挂上用户脚本监听", () => {
    const { runtime, permissionsOnAdded, grantUserScripts } = stubChromeWithoutUserScripts();
    const message = new ExtensionMessage(true);
    message.onMessage(() => undefined);
    message.onConnect(() => undefined);

    grantUserScripts();
    permissionsOnAdded.fire({ permissions: ["background"] });

    expect(runtime.onUserScriptMessage.addListener).not.toHaveBeenCalled();
    expect(runtime.onUserScriptConnect.addListener).not.toHaveBeenCalled();
  });

  it("非后台主实例不应监听权限变化", () => {
    const { permissionsOnAdded } = stubChromeWithoutUserScripts();
    new ExtensionMessage(false);
    expect(permissionsOnAdded.addListener).not.toHaveBeenCalled();
  });
});
