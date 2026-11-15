export type BuiltinDocumentFormat =
  | "markdown"
  | "latex"
  | "mathml"
  | "plantuml"
  | "mermaid"
  | "pdf"
  | "image"
  | "svg"
  | "text"
  | "cpp"
  | "java"
  | "javascript"
  | "json"
  | "yaml"
  | "html"
  | "css"
  | "python"
  | "sql"
  | "php"
  | "rust"
  | "xml"
  | "csharp"
  | "go"
  | "ruby"
  | "kotlin"
  | "swift"
  | "r"
  | "scala"
  | "shell"
  | "dart"
  | "lua"
  | "perl"
  | "objectivec"
  | "ini"
  | "toml";

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
  // PDF：二进制文档，只读预览
  pdf: "pdf",
  // 图片：二进制文档，只读预览（SVG 是文本，按独立格式处理）
  png: "image",
  jpg: "image",
  jpeg: "image",
  jfif: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  apng: "image",
  // SVG：文本格式，源码可编辑，预览经消毒后渲染
  svg: "svg",
  // 主流代码格式
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  ino: "cpp",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "javascript",
  tsx: "javascript",
  mts: "javascript",
  cts: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "css",
  less: "css",
  sass: "css",
  py: "python",
  pyw: "python",
  pyi: "python",
  sql: "sql",
  php: "php",
  phtml: "php",
  rs: "rust",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  plist: "xml",
  cs: "csharp",
  csx: "csharp",
  go: "go",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  r: "r",
  scala: "scala",
  sc: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  dart: "dart",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  m: "objectivec",
  mm: "objectivec",
  ini: "ini",
  cfg: "ini",
  properties: "ini",
  toml: "toml",
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

/** 纯代码格式：无专属渲染器，预览为只读原文，且不提供大纲。 */
export const CODE_FORMATS: ReadonlySet<BuiltinDocumentFormat> = new Set([
  "cpp",
  "java",
  "javascript",
  "json",
  "yaml",
  "html",
  "css",
  "python",
  "sql",
  "php",
  "rust",
  "xml",
  "csharp",
  "go",
  "ruby",
  "kotlin",
  "swift",
  "r",
  "scala",
  "shell",
  "dart",
  "lua",
  "perl",
  "objectivec",
  "ini",
  "toml",
]);
