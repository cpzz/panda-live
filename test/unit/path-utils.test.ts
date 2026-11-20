import { describe, expect, it } from "vitest";
import { pathKey, resolveRelativePath } from "../../src/utils/paths";

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

  it("支持中文文件名（Markdown 渲染器会输出 URL 编码）", () => {
    // 直接中文
    expect(resolveRelativePath("/docs/a.md", "我的文档.md")).toBe("/docs/我的文档.md");
    // URL 编码后的中文（Markdown 渲染器产物）
    expect(resolveRelativePath("/docs/a.md", "%E6%88%91%E7%9A%84%E6%96%87%E6%A1%A3.md")).toBe(
      "/docs/我的文档.md",
    );
    // 混合 ../
    expect(
      resolveRelativePath("C:\\docs\\子目录\\a.md", "../%E4%BB%8B%E7%BB%8D.md"),
    ).toBe("C:\\docs\\介绍.md");
  });
});

describe("路径身份归一化", () => {
  it("分隔符差异归一为相同身份", () => {
    expect(pathKey("D:\\repo\\src/app.ts")).toBe(pathKey("D:/repo/src/app.ts"));
    expect(pathKey("D:\\repo/")).toBe("d:/repo");
  });

  it("Windows 盘符大小写不敏感", () => {
    expect(pathKey("d:\\repo\\a.md")).toBe(pathKey("D:\\repo\\a.md"));
  });

  it("非盘符路径保留大小写", () => {
    expect(pathKey("/Repo/Src/A.md")).toBe("/Repo/Src/A.md");
    expect(pathKey("/Repo/Src/A.md")).not.toBe(pathKey("/repo/src/a.md"));
  });
});
