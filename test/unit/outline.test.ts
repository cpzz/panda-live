import { describe, expect, it } from "vitest";
import { buildOutline } from "../../src/formats/outline";

describe("大纲提取", () => {
  it("Markdown 按文档顺序提取标题层级与行号", () => {
    const source = [
      "---",
      "title: 示例",
      "---",
      "",
      "# 一级标题",
      "",
      "正文",
      "",
      "## 二级标题",
      "",
      "### 三级 `代码` 标题",
      "",
      "## 二级标题",
      "",
    ].join("\n");
    const items = buildOutline(source, "markdown");
    expect(items.map((item) => [item.level, item.text, item.line])).toEqual([
      [1, "一级标题", 5],
      [2, "二级标题", 9],
      [3, "三级 代码 标题", 11],
      [2, "二级标题", 13],
    ]);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });

  it("LaTeX 提取章节命令并忽略注释与普通文本", () => {
    const source = [
      "% \\section{注释中的标题}",
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{绪论}",
      "\\subsection{背景}",
      "\\subsubsection*{细节}",
      "\\section[短标题]{带可选参数的标题}",
      "\\paragraph{小节}",
      "\\end{document}",
    ].join("\n");
    const items = buildOutline(source, "latex");
    expect(items.map((item) => [item.level, item.text, item.line])).toEqual([
      [3, "绪论", 4],
      [4, "背景", 5],
      [5, "细节", 6],
      [3, "带可选参数的标题", 7],
      [6, "小节", 8],
    ]);
  });

  it("嵌套花括号的标题内容完整保留", () => {
    const items = buildOutline("\\section{关于 \\textbf{嵌套} 的处理}", "latex");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("关于 嵌套 的处理");
  });

  it("不支持的格式返回空大纲", () => {
    expect(buildOutline("# 标题", "text")).toEqual([]);
    expect(buildOutline("", "markdown")).toEqual([]);
  });
});
