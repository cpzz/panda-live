export type BuiltinDocumentFormat =
  | "markdown"
  | "latex"
  | "mathml"
  | "plantuml"
  | "mermaid"
  | "pdf"
  | "image"
  | "docx"
  | "xlsx"
  | "pptx"
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
  // MyST 增强标记：按 Markdown 解析，预览渲染 tab-set / grid 指令
  myst: "markdown",
  mst: "markdown",
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
  // Microsoft Office（OOXML zip）：二进制只读预览，渲染为 HTML
  docx: "docx",
  docm: "docx",
  dotx: "docx",
  dotm: "docx",
  doc: "docx", // 旧版二进制（OLE2）：渲染层检出非 zip 后提示另存为 .docx
  xlsx: "xlsx",
  xlsm: "xlsx",
  xlsb: "xlsx",
  xls: "xlsx", // 旧版 BIFF：SheetJS 同样可读
  pptx: "pptx",
  pptm: "pptx",
  potx: "pptx",
  potm: "pptx",
  ppt: "pptx", // 旧版二进制（OLE2）：渲染层检出非 zip 后提示另存为 .pptx
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

/** 内置格式中具有渲染预览的集合；扩展格式由扩展自身提供预览。 */
export const PREVIEW_FORMATS: ReadonlySet<string> = new Set([
  "markdown",
  "latex",
  "mathml",
  "plantuml",
  "mermaid",
  "svg",
  "html",
]);

/** 二进制只读格式：不读文本内容，以专用只读预览面板展示，禁止保存/另存为。
 * 打开、模式切换、保存拦截、外部变更提示等处统一用 isBinaryFormat 判定。 */
export const BINARY_FORMATS: ReadonlySet<string> = new Set([
  "pdf",
  "image",
  "docx",
  "xlsx",
  "pptx",
]);

/** 格式是否二进制只读（PDF/图片/Office）。 */
export function isBinaryFormat(formatId: string | undefined | null): boolean {
  return formatId !== undefined && formatId !== null && BINARY_FORMATS.has(formatId);
}

/** 纯代码格式：只有源码编辑、没有渲染预览，但提供符号大纲（见 formats/outline.ts）。
 * HTML 不在此列——它是文本格式并提供 sandbox 渲染预览。 */
export const CODE_FORMATS: ReadonlySet<BuiltinDocumentFormat> = new Set([
  "cpp",
  "java",
  "javascript",
  "json",
  "yaml",
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
