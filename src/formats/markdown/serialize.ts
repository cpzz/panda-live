import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { PMJson } from "../../editor/schema";
import { pmJsonToMdast, type MdNode } from "./mapping";

/** 固定序列化选项。见 doc/design.md §8.4。 */
const serializer = unified()
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkMath)
  .use(remarkStringify, {
    bullet: "-",
    fences: true,
    fence: "`",
    quote: '"',
    emphasis: "*",
    strong: "*",
    listItemIndent: "one",
  });

function stringifyNodes(nodes: MdNode[]): string {
  const output = serializer.stringify({
    type: "root",
    children: nodes,
  } as unknown as Parameters<typeof serializer.stringify>[0]);
  return output.replace(/\n+$/u, "");
}

/**
 * MyST 容器序列化为围栏指令。外层围栏长度由 remark-stringify 依据内部最大反引号
 * 连续长度自动加一（`max(3, 内部最长围栏 + 1)`），满足 §8.2 的嵌套要求。
 */
function convertDirectives(node: MdNode): MdNode {
  switch (node.type) {
    case "mystTabSet": {
      const items = (node.children ?? []).map(convertDirectives);
      return {
        type: "code",
        lang: "{tab-set}",
        meta: null,
        value: items.map((item) => stringifyNodes([item])).join("\n\n"),
      };
    }
    case "mystTabItem": {
      const content = (node.children ?? []).map(convertDirectives);
      const label = (node.label ?? "").trim();
      return {
        type: "code",
        lang: "{tab-item}",
        meta: label || null,
        value: stringifyNodes(content),
      };
    }
    case "mystGrid": {
      const items = (node.children ?? []).map(convertDirectives);
      const options = [`:columns: ${Number(node.columns) || 2}`];
      if (node.outline) options.push(":outline:");
      const body = items.map((item) => stringifyNodes([item])).join("\n\n");
      return {
        type: "code",
        lang: "{grid}",
        meta: null,
        value: `${options.join("\n")}\n\n${body}`.trimEnd(),
      };
    }
    case "mystGridItem": {
      const content = (node.children ?? []).map(convertDirectives);
      return {
        type: "code",
        lang: "{grid-item}",
        meta: null,
        value: stringifyNodes(content),
      };
    }
    default:
      return node.children ? { ...node, children: node.children.map(convertDirectives) } : node;
  }
}

/** ProseMirror JSON → Markdown。语义往返，允许规范化分隔符、围栏长度与列表符号。 */
export function serializeMarkdown(doc: PMJson): string {
  const tree = convertDirectives(pmJsonToMdast(doc));
  const output = serializer.stringify(
    tree as unknown as Parameters<typeof serializer.stringify>[0],
  );
  return output.endsWith("\n") || output.length === 0 ? output : `${output}\n`;
}

export type { MdNode };

export interface BlockLineRange {
  /** 顶层块在序列化文本中的起始行（1 基）。 */
  start: number;
  /** 结束行（含）。 */
  end: number;
}

export interface BlockLineMap {
  ranges: BlockLineRange[];
  /** 序列化文本的总行数，用于校验映射是否与整篇序列化一致。 */
  totalLines: number;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * 计算每个顶层块在序列化 Markdown 中的行范围。
 * 与 `serializeMarkdown` 使用同一序列化器，块之间固定一个空行。见 §21.5。
 */
export function blockLineRanges(doc: PMJson): BlockLineMap {
  const tree = convertDirectives(pmJsonToMdast(doc));
  const children = tree.children ?? [];
  const ranges: BlockLineRange[] = [];
  let cursor = 1;
  for (const child of children) {
    const lines = Math.max(1, countLines(stringifyNodes([child])));
    ranges.push({ start: cursor, end: cursor + lines - 1 });
    cursor += lines + 1;
  }
  return {
    ranges,
    totalLines: Math.max(1, countLines(serializeMarkdown(doc).replace(/\n$/, ""))),
  };
}
