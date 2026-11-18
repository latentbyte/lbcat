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
    hasListener: (fn: Listener) => listeners.includes(fn),
    fire: (...args: any[]) => listeners.map((fn) => fn(...args)),
  };
};

// Firefox 在授予 userScripts 权限前不会暴露 onUserScriptMessage / onUserScriptConnect
const stubChrome = ({ granted }: { granted: boolean }) => {
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
  // 模拟 Firefox 撤销权限：受权限控制的命名空间连同监听一起被拆掉
  const revokeUserScripts = () => {
    delete runtime.onUserScriptMessage;
    delete runtime.onUserScriptConnect;
  };
  if (granted) grantUserScripts();
  return { runtime, permissionsOnAdded, grantUserScripts, revokeUserScripts };
};

const startBackground = () => {
  const message = new ExtensionMessage(true);
  message.onMessage(() => undefined);
  message.onConnect(() => undefined);
  return message;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExtensionMessage userScripts 监听", () => {
  it("后台启动后在 about:addons 授予 userScripts 权限时应挂上用户脚本监听且只挂一次", () => {
    const { runtime, permissionsOnAdded, grantUserScripts } = stubChrome({ granted: false });
    const message = startBackground();
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

  it("已有权限时后台重启应在初始化时挂上监听，之后的授予事件不应重复挂载", () => {
    const { runtime, permissionsOnAdded } = stubChrome({ granted: true });
    const message = startBackground();
    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);

    permissionsOnAdded.fire({ permissions: ["userScripts"] });

    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);
    expect(message.userScriptListenersAttached()).toEqual({ message: true, connect: true });
  });

  it("addListener 抛错时应保持未挂载并在下次授予时重试", () => {
    const { runtime, permissionsOnAdded, grantUserScripts } = stubChrome({ granted: false });
    const message = startBackground();
    grantUserScripts();
    runtime.onUserScriptMessage.addListener.mockImplementationOnce(() => {
      throw new Error("not ready");
    });

    permissionsOnAdded.fire({ permissions: ["userScripts"] });
    expect(message.userScriptListenersAttached()).toEqual({ message: false, connect: true });

    permissionsOnAdded.fire({ permissions: ["userScripts"] });
    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(2);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);
    expect(message.userScriptListenersAttached()).toEqual({ message: true, connect: true });
  });

  it("撤销后重新授予 userScripts 权限时应重新挂上监听", () => {
    const { runtime, permissionsOnAdded, grantUserScripts, revokeUserScripts } = stubChrome({ granted: false });
    const message = startBackground();
    grantUserScripts();
    permissionsOnAdded.fire({ permissions: ["userScripts"] });
    expect(message.userScriptListenersAttached()).toEqual({ message: true, connect: true });

    revokeUserScripts();
    expect(message.userScriptListenersAttached()).toEqual({ message: false, connect: false });

    grantUserScripts();
    permissionsOnAdded.fire({ permissions: ["userScripts"] });

    expect(runtime.onUserScriptMessage.addListener).toHaveBeenCalledTimes(1);
    expect(runtime.onUserScriptConnect.addListener).toHaveBeenCalledTimes(1);
    expect(message.userScriptListenersAttached()).toEqual({ message: true, connect: true });
  });

  it("授予其他权限时不应挂上用户脚本监听", () => {
    const { runtime, permissionsOnAdded, grantUserScripts } = stubChrome({ granted: false });
    startBackground();

    grantUserScripts();
    permissionsOnAdded.fire({ permissions: ["background"] });

    expect(runtime.onUserScriptMessage.addListener).not.toHaveBeenCalled();
    expect(runtime.onUserScriptConnect.addListener).not.toHaveBeenCalled();
  });

  it("非后台主实例不应监听权限变化", () => {
    const { permissionsOnAdded } = stubChrome({ granted: false });
    new ExtensionMessage(false);
    expect(permissionsOnAdded.addListener).not.toHaveBeenCalled();
  });
});
