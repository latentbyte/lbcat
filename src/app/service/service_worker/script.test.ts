import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "eventemitter3";
import { randomUUID } from "crypto";
import {
  ScriptDAO,
  SCRIPT_STATUS_DISABLE,
  SCRIPT_STATUS_ENABLE,
  SCRIPT_TYPE_BACKGROUND,
  SCRIPT_TYPE_NORMAL,
  type Script,
} from "@App/app/repo/scripts";
import { LocalStorageDAO } from "@App/app/repo/localStorage";
import { SystemConfig } from "@App/pkg/config/config";
import { MessageQueue } from "@Packages/message/message_queue";
import { MockMessage } from "@Packages/message/mock_message";
import { Server } from "@Packages/message/server";
import chromeMock from "@Packages/chrome-extension-mock";
import { ScriptService } from "./script";
import { RuntimeService } from "./runtime";
import { ResourceService } from "./resource";
import { ValueService } from "./value";
import PermissionVerify from "./permission_verify";
import GMApi from "./gm_api/gm_api";

let messageListenerCount = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function createServices(startup = Promise.resolve()) {
  const message = new MockMessage(new EventEmitter());
  const server = new Server("serviceWorker", message);
  const mq = new MessageQueue();
  const config = new SystemConfig(mq);
  const dao = new ScriptDAO();
  const value = new ValueService(server.group("value"), mq);
  const resource = new ResourceService(server.group("resource"), mq);
  const service = new ScriptService(config, server.group("script"), mq, value, resource, dao, (script) =>
    runtime.prepareInstalledScript(script)
  );
  const runtime: RuntimeService = new RuntimeService(
    config,
    server.group("runtime"),
    message,
    mq,
    value,
    service,
    resource,
    dao,
    new LocalStorageDAO()
  );
  vi.spyOn(PermissionVerify.prototype, "init").mockImplementation(() => {});
  vi.spyOn(GMApi.prototype, "start").mockImplementation(() => {});
  vi.spyOn(runtime, "waitInit").mockResolvedValue(undefined);
  vi.spyOn(runtime, "registerUserscripts").mockReturnValue(startup);
  vi.spyOn(runtime, "initUserAgentData").mockResolvedValue(undefined);
  vi.spyOn(runtime, "updateIcon").mockImplementation(() => {});
  vi.spyOn(runtime, "clearNoDeveloperModeWarning").mockImplementation(() => {});
  Object.defineProperties(chrome.permissions, {
    onAdded: { value: { addListener: vi.fn() }, configurable: true },
    onRemoved: { value: { addListener: vi.fn() }, configurable: true },
  });
  runtime.init();
  const publish = vi.spyOn(mq, "publish");
  const script: Script = {
    uuid: randomUUID(),
    name: "install-readiness",
    namespace: "tests",
    type: SCRIPT_TYPE_NORMAL,
    status: SCRIPT_STATUS_ENABLE,
    sort: 0,
    runStatus: "running",
    createtime: Date.now(),
    checktime: Date.now(),
    metadata: { match: ["https://example.com/*"], grant: ["none"] },
  };
  return { service, runtime, publish, script, dao };
}

describe("脚本安装就绪", () => {
  beforeEach(async () => {
    messageListenerCount = chromeMock.runtime.messageListener.length;
    await chrome.storage.local.clear();
    await chrome.userScripts.unregister();
  });

  afterEach(() => {
    chromeMock.runtime.messageListener.splice(messageListenerCount);
    vi.restoreAllMocks();
  });

  it.each([false, true])("%s 更新状态下安装和广播应等待注册完成且只注册一次", async (update) => {
    const { service, runtime, publish, script, dao } = createServices();
    await runtime.initReady;
    runtime.isUserScriptsAvailable = true;
    if (update) {
      await dao.save(script);
      await chrome.userScripts.register([
        { id: script.uuid, js: [{ code: "old" }], matches: ["https://example.com/*"] },
      ]);
      await service.scriptCodeDAO.save({ uuid: script.uuid, code: "old" });
    }
    const gate = deferred<void>();
    const started = deferred<void>();
    const operation = vi.spyOn(chrome.userScripts, update ? "update" : "register").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
    });
    let completed = false;
    const installation = service.installScript({ script, code: "console.log('ready')" }).then(() => {
      completed = true;
    });
    await started.promise;
    await flushMicrotasks();
    try {
      expect(completed).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await installation;
    }
    await flushMicrotasks();
    expect(completed).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      "installScript",
      expect.objectContaining({ script: expect.objectContaining({ uuid: script.uuid }) })
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("%s 更新状态下注册失败应拒绝安装且不广播成功", async (update) => {
    const { service, runtime, publish, script, dao } = createServices();
    await runtime.initReady;
    runtime.isUserScriptsAvailable = true;
    if (update) {
      await dao.save(script);
      await chrome.userScripts.register([
        { id: script.uuid, js: [{ code: "old" }], matches: ["https://example.com/*"] },
      ]);
    }
    const error = new Error("registration failed");
    vi.spyOn(chrome.userScripts, update ? "update" : "register").mockRejectedValue(error);
    await expect(service.installScript({ script, code: "console.log('ready')" })).rejects.toBe(error);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([SCRIPT_STATUS_ENABLE, SCRIPT_STATUS_DISABLE])("%s 状态下回退注入应等待编译资源保存完成", async (status) => {
    const { service, runtime, publish, script } = createServices();
    await runtime.initReady;
    runtime.isUserScriptsAvailable = false;
    runtime.isScriptingFallbackAvailable = true;
    script.status = status;
    const gate = deferred<void>();
    const started = deferred<void>();
    const save = runtime.compiledResourceDAO.save.bind(runtime.compiledResourceDAO);
    vi.spyOn(runtime.compiledResourceDAO, "save").mockImplementation(async (resource) => {
      started.resolve();
      await gate.promise;
      return save(resource);
    });
    const register = vi.spyOn(chrome.userScripts, "register");
    let completed = false;
    const installation = service.installScript({ script, code: "console.log('ready')" }).then(() => {
      completed = true;
    });
    await started.promise;
    await flushMicrotasks();
    try {
      expect(completed).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await installation;
    }
    expect(await runtime.compiledResourceDAO.get(script.uuid)).toBeDefined();
    expect(runtime.getPageScriptMatchingResultByUrl("https://example.com/").has(script.uuid)).toBe(
      status === SCRIPT_STATUS_ENABLE
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("运行时初始化完成前不应发布安装成功", async () => {
    const startup = deferred<void>();
    const { service, runtime, publish, script } = createServices(startup.promise);
    let completed = false;
    const installation = service.installScript({ script, code: "console.log('ready')" }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(runtime.registerUserscripts).toHaveBeenCalled());
    await flushMicrotasks();
    try {
      expect(completed).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      startup.resolve();
      await installation;
    }
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("后台脚本安装无需注册页面脚本", async () => {
    const { service, runtime, publish, script } = createServices();
    await runtime.initReady;
    script.type = SCRIPT_TYPE_BACKGROUND;
    const compile = vi.spyOn(runtime, "buildAndSaveCompiledResourceFromScript");
    const register = vi.spyOn(chrome.userScripts, "register");
    await service.installScript({ script, code: "console.log('background')" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "excludeUrl",
      change: (service: ScriptService, uuid: string) =>
        service.excludeUrl({ uuid, excludePattern: "https://example.com/blocked", remove: false }),
    },
    {
      name: "resetExclude",
      change: (service: ScriptService, uuid: string) =>
        service.resetExclude({ uuid, exclude: ["https://example.com/blocked"] }),
    },
    {
      name: "resetMatch",
      change: (service: ScriptService, uuid: string) => service.resetMatch({ uuid, match: ["https://example.net/*"] }),
    },
    {
      name: "updateMetadata",
      change: (service: ScriptService, uuid: string) =>
        service.updateMetadata({ uuid, key: "match", value: ["https://example.net/*"] }),
    },
  ])("$name 应在重新注册完成后才广播元数据更新", async ({ change }) => {
    const { service, runtime, publish, script } = createServices();
    await runtime.initReady;
    runtime.isUserScriptsAvailable = true;
    await service.installScript({ script, code: "console.log('ready')" });
    publish.mockClear();
    const gate = deferred<void>();
    const started = deferred<void>();
    const update = vi.spyOn(chrome.userScripts, "update").mockImplementation(async () => {
      started.resolve();
      await gate.promise;
    });
    let completed = false;
    const changed = change(service, script.uuid).then(() => {
      completed = true;
    });
    await started.promise;
    await flushMicrotasks();
    try {
      expect(completed).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await changed;
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
