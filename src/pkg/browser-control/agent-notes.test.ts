import { describe, expect, it, vi } from "vitest";
import { AgentNotesService, noteUrl, type AgentNote } from "./agent-notes";

function service(initial?: AgentNote[]) {
  let stored = initial;
  let now = 1000;
  let next = 0;
  const instance = new AgentNotesService({
    load: async () => stored,
    save: async (notes) => {
      stored = structuredClone(notes);
    },
    id: () => `note-${++next}`,
    now: () => now,
  });
  return {
    instance,
    stored: () => stored,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const draft = {
  url: "https://example.com/checkout?step=2#pay",
  title: "Checkout",
  sessionId: "s1",
  label: "claude fix login",
  kind: "needs-human" as const,
  text: "Solve the captcha",
};

describe("代理页面便签", () => {
  it("按去掉锚点的网址保存便签并记录作者", async () => {
    const { instance } = service();
    const note = await instance.add(draft);
    expect(note).toMatchObject({
      id: "note-1",
      url: "https://example.com/checkout?step=2",
      sessionId: "s1",
      label: "claude fix login",
      kind: "needs-human",
      status: "open",
      createdAt: 1000,
    });
    expect(await instance.list({ url: "https://example.com/checkout?step=2#other" })).toEqual([note]);
    expect(await instance.list({ url: "https://example.com/checkout?step=3" })).toEqual([]);
    expect(noteUrl("not a url#x")).toBe("not a url");
  });

  it("拒绝空白文本与未知类型并截断过长内容", async () => {
    const { instance } = service();
    await expect(instance.add({ ...draft, text: "   " })).rejects.toMatchObject({ code: "INVALID_NOTE" });
    await expect(instance.add({ ...draft, kind: "todo" as never })).rejects.toMatchObject({ code: "INVALID_NOTE" });
    const long = await instance.add({ ...draft, text: "x".repeat(5000) });
    expect(long.text).toHaveLength(2000);
  });

  it("人工确认、回复与解决便签后代理可读取结果", async () => {
    const { instance, advance } = service();
    const { id } = await instance.add(draft);
    advance(10);
    expect(await instance.acknowledge(id)).toMatchObject({ status: "acknowledged", updatedAt: 1010 });
    expect(await instance.reply(id, "  done, carry on  ")).toMatchObject({ reply: "done, carry on" });
    expect(await instance.resolve(id)).toMatchObject({ status: "resolved" });
    expect(await instance.get(id)).toMatchObject({ status: "resolved", reply: "done, carry on" });
  });

  it("回复未读便签时视为已确认", async () => {
    const { instance } = service();
    const { id } = await instance.add(draft);
    expect(await instance.reply(id, "ok")).toMatchObject({ status: "acknowledged", reply: "ok" });
    await expect(instance.reply(id, " ")).rejects.toMatchObject({ code: "INVALID_NOTE" });
  });

  it("按任务与状态筛选并可删除便签", async () => {
    const { instance } = service();
    const first = await instance.add(draft);
    const second = await instance.add({ ...draft, sessionId: "s2", kind: "info", text: "fyi" });
    await instance.resolve(first.id);
    expect((await instance.list({ sessionId: "s2" })).map((note) => note.id)).toEqual([second.id]);
    expect((await instance.list({ status: "open" })).map((note) => note.id)).toEqual([second.id]);
    await instance.remove(second.id);
    await expect(instance.get(second.id)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });

  it("超过保留期或数量上限的旧便签被清理", async () => {
    const { instance, advance, stored } = service();
    await instance.add(draft);
    advance(8 * 24 * 60 * 60 * 1000);
    await instance.add({ ...draft, text: "fresh" });
    expect(stored()!.map((note) => note.text)).toEqual(["fresh"]);
    for (let index = 0; index < 205; index++) await instance.add({ ...draft, text: `n${index}` });
    expect(stored()).toHaveLength(200);
    expect(stored()!.at(-1)!.text).toBe("n204");
  });

  it("变更后通知订阅者", async () => {
    const { instance } = service();
    const listener = vi.fn();
    instance.subscribe(listener);
    const note = await instance.add(draft);
    expect(listener).toHaveBeenLastCalledWith([note]);
    await instance.list({});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
