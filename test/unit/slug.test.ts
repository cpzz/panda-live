import { describe, expect, it } from "vitest";
import { createSlugger } from "../../src/shared/slug";

describe("标题锚点 slug", () => {
  it("保留中英文与数字，空格转连字符", () => {
    const slug = createSlugger();
    expect(slug("章节 一")).toBe("章节-一");
    expect(slug("Getting Started")).toBe("getting-started");
  });

  it("去掉标点并小写", () => {
    const slug = createSlugger();
    expect(slug("Hello, World!")).toBe("hello-world");
    expect(slug("API：v2")).toBe("apiv2");
  });

  it("重复标题追加序号，空标题回退 section", () => {
    const slug = createSlugger();
    expect(slug("重复")).toBe("重复");
    expect(slug("重复")).toBe("重复-1");
    expect(slug("重复")).toBe("重复-2");
    expect(slug("!!!")).toBe("section");
  });
});
