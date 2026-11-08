import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { PMJson } from "../../editor/schema";
import type { Diagnostic } from "../types";
import { mdastToPmJson, type MdNode } from "./mapping";
import { expandMyst } from "./myst";

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath);

export interface MarkdownParseResult {
  doc: PMJson;
  diagnostics: Diagnostic[];
}

/**
 * Markdown → ProseMirror JSON。解析失败不抛到 UI 顶层，降级为原文块并给出诊断。
 * 见 doc/design.md §8.1。
 */
export function parseMarkdown(source: string): MarkdownParseResult {
  const diagnostics: Diagnostic[] = [];
  try {
    const tree = parser.parse(source) as unknown as MdNode;
    const expanded = expandMyst(tree, source);
    return { doc: mdastToPmJson(expanded, source), diagnostics };
  } catch (error) {
    diagnostics.push({
      severity: "error",
      message: `Markdown 解析失败：${error instanceof Error ? error.message : String(error)}`,
      code: "E_PARSE_FAILED",
    });
    return {
      doc: {
        type: "doc",
        content: [{ type: "raw_markdown", attrs: { raw: source, reason: "parse-failed" } }],
      },
      diagnostics,
    };
  }
}
