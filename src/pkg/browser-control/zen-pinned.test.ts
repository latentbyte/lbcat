import { describe, expect, it } from "vitest";
import { dropZenPinnedMirrors } from "./zen-pinned";

type Tab = { id: number; windowId: number; url: string; pinned?: boolean; incognito?: boolean };

const ids = (tabs: Tab[]) => tabs.map((tab) => tab.id);

describe("dropZenPinnedMirrors", () => {
  it("只保留基准窗口的固定标签，其他窗口的同源镜像被去掉", () => {
    const tabs: Tab[] = [
      { id: 1, windowId: 19, url: "https://calendar.example/", pinned: true },
      { id: 2, windowId: 19, url: "https://mail.example/inbox/p/1", pinned: true },
      { id: 3, windowId: 19, url: "https://work.example/a" },
      { id: 11, windowId: 631, url: "https://calendar.example/", pinned: true },
      { id: 12, windowId: 631, url: "https://mail.example/inbox", pinned: true },
      { id: 13, windowId: 631, url: "https://work.example/b" },
    ];
    expect(ids(dropZenPinnedMirrors(tabs))).toEqual([1, 2, 3, 13]);
  });

  it("基准窗口跳过代理窗口，即使代理窗口 ID 更小", () => {
    const tabs: Tab[] = [
      { id: 1, windowId: 5, url: "https://calendar.example/", pinned: true },
      { id: 11, windowId: 9, url: "https://calendar.example/", pinned: true },
    ];
    expect(ids(dropZenPinnedMirrors(tabs, 5))).toEqual([11]);
  });

  it("基准窗口没有对应的固定标签时保留其他窗口的固定标签", () => {
    const tabs: Tab[] = [
      { id: 1, windowId: 1, url: "https://mail.example/u/0", pinned: true },
      { id: 11, windowId: 2, url: "https://mail.example/u/1", pinned: true },
      { id: 12, windowId: 2, url: "https://mail.example/u/0", pinned: true },
      { id: 13, windowId: 2, url: "https://only-here.example/", pinned: true },
    ];
    expect(ids(dropZenPinnedMirrors(tabs))).toEqual([1, 12, 13]);
  });

  it("隐私窗口与普通标签不参与去重", () => {
    const tabs: Tab[] = [
      { id: 1, windowId: 1, url: "https://calendar.example/", pinned: true },
      { id: 2, windowId: 1, url: "https://work.example/" },
      { id: 11, windowId: 2, url: "https://calendar.example/", pinned: true, incognito: true },
      { id: 12, windowId: 3, url: "https://work.example/" },
    ];
    expect(ids(dropZenPinnedMirrors(tabs))).toEqual([1, 2, 11, 12]);
  });

  it("无法解析来源的地址按完整 URL 匹配", () => {
    const tabs: Tab[] = [
      { id: 1, windowId: 1, url: "about:blank", pinned: true },
      { id: 11, windowId: 2, url: "about:blank", pinned: true },
      { id: 12, windowId: 2, url: "about:config", pinned: true },
    ];
    expect(ids(dropZenPinnedMirrors(tabs))).toEqual([1, 12]);
  });
});
