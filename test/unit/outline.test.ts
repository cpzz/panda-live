import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutlinePanel } from "../../src/app/OutlinePanel";
import { buildOutline, formatSupportsOutline, OUTLINE_FORMATS } from "../../src/formats/outline";
import { getFormatEntry } from "../../src/extensions/registry";

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

  it("Python 按缩进区分顶层定义与类方法", () => {
    const source = [
      "class Foo:",
      "    \"\"\"文档字符串\"\"\"",
      "    def bar(self):",
      "        pass",
      "",
      "def top():",
      "    return 1",
    ].join("\n");
    const items = buildOutline(source, "python");
    expect(items.map((item) => [item.level, item.text, item.line])).toEqual([
      [1, "Foo", 1],
      [2, "bar", 3],
      [1, "top", 6],
    ]);
  });

  it("JavaScript 提取类、函数、箭头函数与方法", () => {
    const source = [
      "class Foo {",
      "  constructor(x) {",
      "  }",
      "  async run() {",
      "  }",
      "}",
      "function helper() {}",
      "const handler = (e) => {};",
    ].join("\n");
    const items = buildOutline(source, "javascript");
    expect(items.map((item) => [item.level, item.text, item.line])).toEqual([
      [1, "Foo", 1],
      [2, "constructor", 2],
      [2, "run", 4],
      [2, "helper", 7],
      [2, "handler", 8],
    ]);
  });

  it("Rust 顶层函数与 impl 内函数层级不同", () => {
    const source = [
      "pub struct Config {",
      "}",
      "impl Config {",
      "    pub fn new() -> Self {",
      "    }",
      "}",
      "fn main() {",
      "}",
    ].join("\n");
    const items = buildOutline(source, "rust");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "Config"],
      [1, "Config"],
      [2, "new"],
      [1, "main"],
    ]);
  });

  it("C++ 跳过注释与字符串中的伪声明", () => {
    const source = [
      "// void fake();",
      "/*",
      "class Hidden {};",
      "*/",
      "namespace app {",
      "class Engine {",
      "public:",
      "    void start() {}",
      "};",
      "}",
    ].join("\n");
    const items = buildOutline(source, "cpp");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "app"],
      [1, "Engine"],
      [2, "start"],
    ]);
  });

  it("C++ 识别初始化列表、限定符与单行带内容方法体", () => {
    const source = [
      "explicit Greeter(std::string name) : name_(std::move(name)) {}",
      'void hello() const { std::cout << "Hello, " << name_ << \'\\n\'; }',
      "int add(int a, int b) { return a + b; }",
      "virtual void run() noexcept override final;",
      "Foo() = default;",
      "~Foo() {}",
    ].join("\n");
    expect(buildOutline(source, "cpp").map((item) => [item.text, item.symbol])).toEqual([
      ["Greeter", "函数"],
      ["hello", "函数"],
      ["add", "函数"],
      ["run", "函数"],
      ["Foo", "函数"],
      ["~Foo", "函数"],
    ]);
  });

  it("C++ 识别函数体在下一行的函数声明", () => {
    const source = [
      "int main() {",
      "    return 0;",
      "}",
      "namespace app {",
      "void run(int x) {",
      "    return;",
      "}",
      "}",
    ].join("\n");
    expect(buildOutline(source, "cpp").map((item) => [item.text, item.symbol])).toEqual([
      ["main", "函数"],
      ["app", "命名空间"],
      ["run", "函数"],
    ]);
  });

  it("Java / C# 识别注解、throws 与表达式体方法", () => {
    const java = [
      "public class Greeter {",
      "  public Greeter(String name) { this.name = name; }",
      '  @Override public String toString() { return "x"; }',
      "  public static void main(String[] args) throws Exception {}",
      "}",
    ].join("\n");
    expect(buildOutline(java, "java").map((item) => item.text)).toEqual([
      "Greeter",
      "Greeter",
      "toString",
      "main",
    ]);

    const csharp = [
      "public class Greeter {",
      "  public Greeter(string name) => this.name = name;",
      '  void Hello() => Console.WriteLine("hi");',
      '  public void Run() { Console.WriteLine("run"); }',
      "}",
    ].join("\n");
    expect(buildOutline(csharp, "csharp").map((item) => item.text)).toEqual([
      "Greeter",
      "Greeter",
      "Hello",
      "Run",
    ]);
  });

  it("JS/TS 识别生成器方法、类字段与带类型注解的箭头函数", () => {
    const source = [
      "class C {",
      "  *gen() { yield 1; }",
      "  handler = () => {};",
      "}",
      "export const bar = async (x: number): Promise<number> => x;",
      "const baz = () => 1;",
    ].join("\n");
    expect(buildOutline(source, "javascript").map((item) => [item.text, item.symbol])).toEqual([
      ["C", "类"],
      ["gen", "方法"],
      ["handler", "函数"],
      ["bar", "函数"],
      ["baz", "函数"],
    ]);
  });

  it("Dart 识别表达式体方法", () => {
    const source = ["class Greeter {", "  int value() => 1;", "}"].join("\n");
    expect(buildOutline(source, "dart").map((item) => item.text)).toEqual(["Greeter", "value"]);
  });

  it("Go 区分方法与顶层函数", () => {
    const source = [
      "type Server struct {}",
      "func (s *Server) Start() {}",
      "func main() {}",
    ].join("\n");
    const items = buildOutline(source, "go");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "Server"],
      [2, "Start"],
      [1, "main"],
    ]);
  });

  it("JSON 按缩进提取嵌套键", () => {
    const source = [
      "{",
      '  "name": "x",',
      '  "config": {',
      '    "debug": true',
      "  }",
      "}",
    ].join("\n");
    const items = buildOutline(source, "json");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "name"],
      [1, "config"],
      [2, "debug"],
    ]);
  });

  it("YAML 忽略注释与文档标记", () => {
    const source = [
      "---",
      "# 顶层注释",
      "name: demo",
      "server:",
      "  host: localhost",
      "  port: 8080",
      "...",
    ].join("\n");
    const items = buildOutline(source, "yaml");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "name"],
      [1, "server"],
      [2, "host"],
      [2, "port"],
    ]);
  });

  it("TOML 与 INI 以表头为一级、键为二级", () => {
    const toml = ["[server]", 'host = "localhost"', "", "[[workers]]", "count = 2"].join("\n");
    expect(buildOutline(toml, "toml").map((i) => [i.level, i.text])).toEqual([
      [1, "server"],
      [2, "host"],
      [1, "workers"],
      [2, "count"],
    ]);
    const ini = ["[database]", "user=root", "; 注释"].join("\n");
    expect(buildOutline(ini, "ini").map((i) => [i.level, i.text])).toEqual([
      [1, "database"],
      [2, "user"],
    ]);
  });

  it("HTML 通过标签栈定位结构层级", () => {
    const source = [
      "<root>",
      '  <section id="intro">',
      "    <h2>标题</h2>",
      "  </section>",
      '  <div class="box"></div>',
      "</root>",
    ].join("\n");
    const items = buildOutline(source, "html");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [2, "intro"],
      [3, "h2"],
      [2, "box"],
    ]);
  });

  it("CSS 提取 @ 规则与选择器", () => {
    const source = [
      "@media (min-width: 600px) {",
      "  .card {",
      "    color: red;",
      "  }",
      "}",
      "@keyframes fade {",
      "  from { opacity: 0; }",
      "}",
    ].join("\n");
    const items = buildOutline(source, "css");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "@media (min-width: 600px)"],
      [2, ".card"],
      [1, "@keyframes fade"],
      [2, "from"],
    ]);
  });

  it("SQL 提取 CREATE 与 ALTER 对象", () => {
    const source = [
      "CREATE TABLE users (id INT);",
      "CREATE OR REPLACE VIEW active_users AS SELECT 1;",
      "ALTER TABLE users ADD COLUMN name TEXT;",
      "-- DROP TABLE old_users;",
    ].join("\n");
    const items = buildOutline(source, "sql");
    expect(items.map((item) => [item.level, item.text])).toEqual([
      [1, "users"],
      [1, "active_users"],
      [1, "users"],
    ]);
  });

  it("Shell、Mermaid、PlantUML 提取各自声明", () => {
    expect(
      buildOutline(["#!/bin/bash", "function greet() {", "}", "deploy() {"].join("\n"), "shell").map(
        (i) => i.text,
      ),
    ).toEqual(["greet", "deploy"]);
    expect(
      buildOutline(["graph TD", "  subgraph 前端", "  A-->B", "end"].join("\n"), "mermaid").map(
        (i) => [i.level, i.text],
      ),
    ).toEqual([
      [1, "graph"],
      [2, "前端"],
    ]);
    expect(
      buildOutline(["@startuml", "title 架构", "class User", "participant API", "@enduml"].join("\n"), "plantuml").map(
        (i) => i.text,
      ),
    ).toEqual(["架构", "User", "API"]);
  });

  it("OUTLINE_FORMATS 与格式能力位一致", () => {
    for (const format of OUTLINE_FORMATS) {
      expect(getFormatEntry(format)?.capabilities.outline, format).toBe(true);
      expect(formatSupportsOutline(format), format).toBe(true);
    }
    for (const format of ["mathml", "pdf", "image", "text"]) {
      expect(getFormatEntry(format)?.capabilities.outline, format).toBe(false);
      expect(formatSupportsOutline(format), format).toBe(false);
    }
  });

  it("大纲项标注各语言的具体语法类型", () => {
    const cpp = buildOutline(
      ["namespace app {", "class Engine {", "public:", "void start() {}", "};", "}"].join("\n"),
      "cpp",
    );
    expect(cpp.map((item) => item.symbol)).toEqual(["命名空间", "类", "函数"]);

    const python = buildOutline(
      ["class A:", "    def run(self):", "", "def top():"].join("\n"),
      "python",
    );
    expect(python.map((item) => item.symbol)).toEqual(["类", "函数", "函数"]);

    const rust = buildOutline(
      ["mod net;", "pub struct Config {}", "impl Config {", "    fn new() {}", "}"].join("\n"),
      "rust",
    );
    expect(rust.map((item) => item.symbol)).toEqual(["模块", "结构体", "实现", "方法"]);

    const css = buildOutline(["@media screen {", ".a {}", "}"].join("\n"), "css");
    expect(css.map((item) => item.symbol)).toEqual(["@ 规则", "选择器"]);

    expect(buildOutline(["{", '  "a": 1', "}"].join("\n"), "json")[0]?.symbol).toBe("键");
    expect(buildOutline("# 标题", "markdown")[0]?.symbol).toBe("标题");
    expect(buildOutline("CREATE TABLE t (id INT);", "sql")[0]?.symbol).toBe("表");
    expect(buildOutline("graph TD\n  subgraph UI", "mermaid").map((i) => i.symbol)).toEqual([
      "图",
      "子图",
    ]);
  });

  it("面板按具体语法类型分组、可折叠、子项带图标；纯标题保持顺序列表", () => {
    const cpp = buildOutline(
      ["class Engine {", "public:", "void start() {}", "void stop() {}"].join("\n"),
      "cpp",
    );
    const grouped = renderToStaticMarkup(
      createElement(OutlinePanel, { items: cpp, onSelect: () => {} }),
    );
    expect(grouped).toContain('class="outline-groups"');
    expect(grouped).not.toContain("outline-panel-header"); // 面板无独立标题行/折叠按钮
    expect(grouped).toContain("类");
    expect(grouped).toContain("函数");
    expect(grouped).toContain('class="outline-group-count">2');
    expect(grouped).not.toContain('class="outline-group-icon"'); // 分类头不带图标
    expect(grouped).toContain('class="outline-item-icon"'); // 子项仍带图标
    expect(grouped).toContain(">C</text>"); // class → 文件图标 + C
    expect(grouped).toContain(">F</text>"); // function → 文件图标 + F
    expect(grouped).not.toContain("padding-left"); // 分组子项缩进统一，不按层级
    expect(grouped).toContain('aria-expanded="true"');
    // 折叠箭头排在分类名之前，展开态用 chevron-down（与工作区根文件夹一致）。
    expect(grouped.indexOf("outline-group-chevron")).toBeLessThan(
      grouped.indexOf("outline-group-title"),
    );
    // 组头的 chevron 在分类名之前，且展开态是 chevron-down（points="6 9 ..."）；
    // 用 group-header 片段精确定位到分类头本身。
    const groupHeader = /class="outline-group-header"[^>]*>(.*?)<\/button>/s.exec(grouped)?.[1] ?? "";
    expect(groupHeader).toContain('class="outline-group-chevron"');
    expect(groupHeader).toContain('points="6 9 12 15 18 9"'); // chevron-down
    expect(groupHeader).not.toContain('points="18 15 12 9 6 15"'); // 不是 chevron-up
    expect(groupHeader.indexOf("outline-group-chevron")).toBeLessThan(
      groupHeader.indexOf("outline-group-title"),
    );
    // 计数为纯数字，无圆环徽章。
    expect(grouped).toContain('class="outline-group-count">2</span>');
    // 分类定位工具栏：只含一个下拉框，占位项显示「分类 (N)」，选项为各分类。
    expect(grouped).toContain('class="outline-toolbar"');
    expect(grouped).toContain('class="outline-group-select"');
    expect(grouped).toContain('aria-label="定位分类"');
    expect(grouped).toContain("分类 (2)");
    expect(grouped).toContain('value="类"');
    expect(grouped).toContain('data-symbol="类"'); // 供定位滚动查找

    const markdown = buildOutline("# A\n## B", "markdown");
    const plain = renderToStaticMarkup(
      createElement(OutlinePanel, { items: markdown, onSelect: () => {} }),
    );
    expect(plain).toContain('class="outline-list"');
    expect(plain).toContain('class="outline-item-icon"');
    expect(plain).toContain("padding-left"); // 标题树保留层级缩进
    expect(plain).not.toContain("outline-groups");
    expect(plain).not.toContain("outline-toolbar"); // 纯标题树无分类，不显示定位工具栏
  });

  it("子项图标为文件轮廓加类型英文首字母", () => {
    const cpp = buildOutline(
      ["enum Color { Red }", "class Engine {", "void start() {}", "};"].join("\n"),
      "cpp",
    );
    expect(cpp.map((item) => item.symbol)).toContain("枚举");
    const grouped = renderToStaticMarkup(
      createElement(OutlinePanel, { items: cpp, onSelect: () => {} }),
    );
    expect(grouped).toContain(">E</text>"); // enum → E
    expect(grouped).toContain(">C</text>"); // class → C
    expect(grouped).toContain(">F</text>"); // function → F
    // 文件轮廓：两组 path 分别是文件外形与右上折角。
    expect((grouped.match(/M6 22a2 2 0 0 1-2-2/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("JS/Go 等只有一种语法类型时也分组，每个分类项都落在分类下", () => {
    const go = buildOutline(
      ["func main() {}", "func helper() {}"].join("\n"),
      "go",
    );
    expect([...new Set(go.map((i) => i.symbol))]).toEqual(["函数"]);
    const goPanel = renderToStaticMarkup(
      createElement(OutlinePanel, { items: go, onSelect: () => {} }),
    );
    expect(goPanel).toContain('class="outline-groups"');
    expect(goPanel).toContain("函数");
    expect(goPanel).toContain('class="outline-group-count">2');

    const js = buildOutline(
      ["export default function main() {}", "function helper() {}"].join("\n"),
      "javascript",
    );
    expect(js.map((i) => i.text)).toEqual(["main", "helper"]);
    const jsPanel = renderToStaticMarkup(
      createElement(OutlinePanel, { items: js, onSelect: () => {} }),
    );
    expect(jsPanel).toContain('class="outline-groups"');
    expect(jsPanel).toContain("函数");
  });

  it("Objective-C 的 @interface 归类为类而非注解", () => {
    const items = buildOutline("@interface Foo : NSObject\n@end", "objectivec");
    expect(items[0]?.symbol).toBe("类");
  });

  it("不支持的格式返回空大纲", () => {
    expect(buildOutline("# 标题", "text")).toEqual([]);
    expect(buildOutline("", "markdown")).toEqual([]);
    expect(buildOutline("%PDF-1.7", "pdf")).toEqual([]);
  });
});
