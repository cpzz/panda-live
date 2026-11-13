import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { PMJson } from "../../editor/schema";
import { t } from "../../i18n";
import { singleDollarEnabled } from "../../services/math-settings";
import type { Diagnostic } from "../types";
import { mdastToPmJson, type MdNode } from "./mapping";
import { expandMyst } from "./myst";

function buildParser() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkMath, { singleDollarTextMath: singleDollarEnabled() });
}

/** 解析器按「单美元开关」缓存；设置变化时重建。见 doc/design.md §15.3。 */
let cachedParser: ReturnType<typeof buildParser> | null = null;
let cachedSingleDollar: boolean | null = null;

function getParser(): ReturnType<typeof buildParser> {
  const singleDollar = singleDollarEnabled();
  if (!cachedParser || cachedSingleDollar !== singleDollar) {
    cachedParser = buildParser();
    cachedSingleDollar = singleDollar;
  }
  return cachedParser;
}

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
    const tree = getParser().parse(source) as unknown as MdNode;
    const expanded = expandMyst(tree, source);
    return { doc: mdastToPmJson(expanded, source), diagnostics };
  } catch (error) {
    diagnostics.push({
      severity: "error",
      message: t(
        "Markdown 解析失败：{0}",
        error instanceof Error ? error.message : String(error),
      ),
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
