import { describe, expect, it, vi } from "vitest";
import type { MessageConnect } from "@Packages/message/types";
import { SenderConnect } from "@Packages/message/server";
import { ChatService, type ChatServiceLLMDeps } from "./chat_service";
import type { SubAgentService } from "./sub_agent_service";
import { BackgroundSessionManager } from "./background_session_manager";
import { ToolRegistry } from "../core/tool_registry";
import type { AgentModelConfig, Conversation } from "../core/types";
import { createExecuteScriptTool } from "../core/tools/execute_script";

function fixture() {
  const registry = new ToolRegistry();
  const close = vi.fn(async () => {});
  registry.registerSessionBuiltinFactory("browser", () => ({
    tools: [
      createExecuteScriptTool({
        executeInPage: async (_code, options) => ({ result: "request-page", tabId: options?.tabId ?? 1 }),
        executeInSandbox: async () => "sandbox",
      }),
    ],
    close,
  }));
  const conversation: Conversation = { id: "chat", title: "Chat", modelId: "model", createtime: 1, updatetime: 1 };
  const model: AgentModelConfig = {
    id: "model",
    name: "test",
    provider: "openai",
    model: "test",
    apiBaseUrl: "https://example.com",
    apiKey: "",
  };
  const repo = {
    listConversations: vi.fn(async () => [conversation]),
    saveConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    saveMessages: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => {}),
    getTasks: vi.fn(async () => []),
    saveTasks: vi.fn(async () => {}),
  };
  const llm: ChatServiceLLMDeps = {
    callLLM: vi.fn(async () => ({ content: "", toolCalls: [] })),
    callLLMWithToolLoop: vi.fn(async () => {}),
  };
  const subAgent = {
    cleanup: vi.fn(),
    runSubAgent: vi.fn<SubAgentService["runSubAgent"]>(async () => ({ agentId: "child", result: "done" })),
  };
  const skillService = { resolveSkills: vi.fn(() => ({ promptSuffix: "", metaTools: [] })) };
  const service = new ChatService(
    registry,
    { getModel: async () => model },
    skillService,
    new BackgroundSessionManager(),
    subAgent,
    llm,
    repo
  );
  const connection: MessageConnect = {
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    onDisconnect: vi.fn(),
    disconnect: vi.fn(),
  };
  const run = (options: { ephemeral?: boolean } = {}) =>
    service.handleConversationChat(
      { conversationId: "chat", message: "hello", ...options },
      new SenderConnect(connection)
    );
  return { registry, close, repo, llm, service, connection, run, subAgent, skillService, conversation };
}

describe("聊天浏览器任务范围", () => {
  it("子代理技能初始化失败时也应释放子请求浏览器范围", async () => {
    const f = fixture();
    f.conversation.skills = ["test"];
    f.skillService.resolveSkills
      .mockImplementationOnce(() => ({ promptSuffix: "", metaTools: [] }))
      .mockImplementationOnce(() => {
        throw new Error("child skill error");
      });
    f.llm.callLLMWithToolLoop = async ({ toolRegistry }) => {
      const results = await toolRegistry.execute([{ id: "child", name: "agent", arguments: '{"prompt":"read page"}' }]);
      expect(JSON.parse(results[0].result).error).toBe("child skill error");
    };
    await f.run();
    expect(f.subAgent.runSubAgent).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("临时聊天也应使用独立工具范围并在请求结束后释放", async () => {
    const f = fixture();
    let result = "";
    f.llm.callLLMWithToolLoop = async ({ toolRegistry }) => {
      const results = await toolRegistry.execute([
        { id: "page", name: "execute_script", arguments: '{"target":"page","tab_id":1,"code":"return 1"}' },
      ]);
      result = JSON.parse(results[0].result).result;
    };
    await f.run({ ephemeral: true });
    expect(result).toBe("request-page");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "history-error", "setup-error", "loop-error"])("%s 路径结束时应释放浏览器范围", async (mode) => {
    const f = fixture();
    if (mode === "history-error") f.repo.getMessages.mockRejectedValue(new Error("history error"));
    if (mode === "setup-error") f.repo.getTasks.mockRejectedValue(new Error("setup error"));
    if (mode === "loop-error")
      f.llm.callLLMWithToolLoop = async () => {
        throw new Error("loop error");
      };
    await f.run();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("父请求出错时应等待子代理完成后才释放父子浏览器范围", async () => {
    const f = fixture();
    let finish!: () => void;
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.subAgent.runSubAgent.mockImplementation(async ({ toolRegistry }) => {
      const result = await toolRegistry.execute([
        { id: "page", name: "execute_script", arguments: '{"target":"page","tab_id":1,"code":"return 1"}' },
      ]);
      expect(JSON.parse(result[0].result).result).toBe("request-page");
      await new Promise<void>((resolve) => {
        finish = resolve;
        started();
      });
      return { agentId: "child", result: "done" };
    });
    f.llm.callLLMWithToolLoop = async ({ toolRegistry }) => {
      void toolRegistry.execute([{ id: "child", name: "agent", arguments: '{"prompt":"read page"}' }]);
      await childStarted;
      throw new Error("parent failed");
    };
    const request = f.run();
    await childStarted;
    await Promise.resolve();
    expect(f.close).not.toHaveBeenCalled();
    finish();
    await request;
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("应保留请求注册表的页面执行器而不切换到全局 DOM 范围", async () => {
    const f = fixture();
    let result = "";
    f.llm.callLLMWithToolLoop = async ({ toolRegistry }) => {
      const results = await toolRegistry.execute([
        { id: "page", name: "execute_script", arguments: '{"target":"page","tab_id":1,"code":"return 1"}' },
      ]);
      result = JSON.parse(results[0].result).result;
    };
    await f.run();
    expect(result).toBe("request-page");
  });
});
