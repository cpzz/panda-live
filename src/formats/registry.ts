export type BuiltinDocumentFormat =
  | "markdown"
  | "latex"
  | "mathml"
  | "plantuml"
  | "mermaid"
  | "text";

const EXTENSION_MAP: Record<string, BuiltinDocumentFormat> = {
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mkd: "markdown",
  qmd: "markdown",
  rmd: "markdown",
  mdx: "markdown",
  tex: "latex",
  latex: "latex",
  mathml: "mathml",
  mml: "mathml",
  puml: "plantuml",
  plantuml: "plantuml",
  mmd: "mermaid",
  mermaid: "mermaid",
};

/** 按扩展名判定内置格式；未知扩展名返回 null，由扩展注册表或纯文本兜底。 */
export function builtinFormatFor(fileName: string): BuiltinDocumentFormat | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MAP[extension] ?? null;
}

/** 按扩展名判定内置格式；未知扩展名按纯文本处理。见 doc/design.md §3.3。 */
export function detectFormat(fileName: string): BuiltinDocumentFormat {
  return builtinFormatFor(fileName) ?? "text";
}
