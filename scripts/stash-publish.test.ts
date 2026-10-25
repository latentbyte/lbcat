import { describe, expect, it } from "vitest";
import { planPublish } from "./stash-publish.ts";

describe("LB Stash 发布计划", () => {
  it("上传本地已签名但未发布的版本，并把最新版本提升为更新清单", () => {
    expect(
      planPublish({
        local: ["lbcat-4.29.5.xpi", "lbcat-4.28.0.xpi", "lbcat-4.29.5-firefox.zip"],
        stash: ["lbcat-4.28.0.xpi", "lbcat-updates.json", "lbcat-updates-4.19.0.json"],
        feedVersion: "4.19.0",
      })
    ).toEqual({ upload: ["4.29.5"], promote: "4.29.5" });
  });

  it("已上传但未进入更新清单的版本只做提升", () => {
    expect(planPublish({ local: [], stash: ["lbcat-4.19.0.xpi", "lbcat-4.28.0.xpi"], feedVersion: "4.19.0" })).toEqual({
      upload: [],
      promote: "4.28.0",
    });
  });

  it("多个未发布版本按版本号升序上传，只提升最高版本", () => {
    expect(
      planPublish({
        local: ["lbcat-4.30.0.xpi", "lbcat-4.29.10.xpi", "lbcat-4.29.9.xpi"],
        stash: ["lbcat-4.29.9.xpi"],
        feedVersion: "4.29.9",
      })
    ).toEqual({ upload: ["4.29.10", "4.30.0"], promote: "4.30.0" });
  });

  it("全部已发布且清单已是最新时无事可做", () => {
    expect(planPublish({ local: ["lbcat-4.28.0.xpi"], stash: ["lbcat-4.28.0.xpi"], feedVersion: "4.28.0" })).toEqual({
      upload: [],
      promote: undefined,
    });
  });

  it("空清单提升最高版本，清单版本更高时不回退", () => {
    expect(planPublish({ local: [], stash: ["lbcat-4.2.3.xpi"], feedVersion: undefined }).promote).toBe("4.2.3");
    expect(planPublish({ local: [], stash: ["lbcat-4.2.3.xpi"], feedVersion: "4.19.0" }).promote).toBeUndefined();
  });
});
