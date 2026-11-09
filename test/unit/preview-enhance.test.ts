// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { codeLanguage } from "../../src/render/code-highlight";
import { diagramKindForLanguage } from "../../src/render/markdown/diagram-preview";

describe("预览语言识别", () => {
  it("图表围栏别名映射", () => {
    expect(diagramKindForLanguage("plantuml")).toBe("plantuml");
    expect(diagramKindForLanguage("puml")).toBe("plantuml");
    expect(diagramKindForLanguage("uml")).toBe("plantuml");
    expect(diagramKindForLanguage("mermaid")).toBe("mermaid");
    expect(diagramKindForLanguage("mmd")).toBe("mermaid");
    expect(diagramKindForLanguage("js")).toBeNull();
    expect(diagramKindForLanguage(null)).toBeNull();
  });

  it("从 language-xxx class 读取语言", () => {
    const element = document.createElement("code");
    element.className = "language-JavaScript extra";
    expect(codeLanguage(element)).toBe("javascript");
    expect(codeLanguage(document.createElement("code"))).toBeNull();
  });
});
