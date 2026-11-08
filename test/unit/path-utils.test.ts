import { describe, expect, it } from "vitest";
import { resolveRelativePath } from "../../src/utils/paths";

describe("相对资源路径解析", () => {
  it("相对路径基于文件所在目录", () => {
    expect(resolveRelativePath("/docs/a.md", "img/pic.png")).toBe("/docs/img/pic.png");
    expect(resolveRelativePath("C:\\docs\\a.md", "img\\pic.png")).toBe("C:\\docs\\img\\pic.png");
  });

  it("支持 .. 与 . 段", () => {
    expect(resolveRelativePath("/docs/sub/a.md", "../img/pic.png")).toBe("/docs/img/pic.png");
    expect(resolveRelativePath("/docs/a.md", "./pic.png")).toBe("/docs/pic.png");
  });

  it("拒绝绝对路径、协议与越界路径", () => {
    expect(resolveRelativePath("/docs/a.md", "/abs/pic.png")).toBeNull();
    expect(resolveRelativePath("/docs/a.md", "https://x/pic.png")).toBeNull();
    expect(resolveRelativePath("/docs/a.md", "../../../etc/passwd")).toBeNull();
  });

  it("忽略查询串与片段", () => {
    expect(resolveRelativePath("/docs/a.md", "pic.png?v=1#top")).toBe("/docs/pic.png");
  });
});
