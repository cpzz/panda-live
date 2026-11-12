import type { ExtensionFormatInfo, FormatCapabilities, LanguageSyntax } from "../shared/extensions";
import { builtinFormatFor, type BuiltinDocumentFormat } from "../formats/registry";

export interface FormatEntry {
  id: string;
  builtin: boolean;
  extensionId: string | null;
  extensions: string[];
  capabilities: FormatCapabilities;
  language: string;
  syntax: LanguageSyntax;
}

const CODE_CAPABILITIES: FormatCapabilities = {
  source: true,
  wysiwyg: false,
  preview: "none",
  outline: false,
  exportHtml: false,
};

const BUILTIN_CAPABILITIES: Record<BuiltinDocumentFormat, FormatCapabilities> = {
  markdown: { source: true, wysiwyg: true, preview: "inline", outline: true, exportHtml: true },
  latex: { source: true, wysiwyg: false, preview: "none", outline: true, exportHtml: false },
  mathml: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: true },
  plantuml: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: false },
  mermaid: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: false },
  // PDF：二进制只读，不支持源码编辑
  pdf: { source: false, wysiwyg: false, preview: "none", outline: false, exportHtml: false },
  text: { source: true, wysiwyg: false, preview: "none", outline: false, exportHtml: false },
  cpp: CODE_CAPABILITIES,
  java: CODE_CAPABILITIES,
  javascript: CODE_CAPABILITIES,
  json: CODE_CAPABILITIES,
  yaml: CODE_CAPABILITIES,
  html: CODE_CAPABILITIES,
  css: CODE_CAPABILITIES,
  python: CODE_CAPABILITIES,
  sql: CODE_CAPABILITIES,
  php: CODE_CAPABILITIES,
  rust: CODE_CAPABILITIES,
  xml: CODE_CAPABILITIES,
  csharp: CODE_CAPABILITIES,
  go: CODE_CAPABILITIES,
  ruby: CODE_CAPABILITIES,
  kotlin: CODE_CAPABILITIES,
  swift: CODE_CAPABILITIES,
  r: CODE_CAPABILITIES,
  scala: CODE_CAPABILITIES,
  shell: CODE_CAPABILITIES,
  dart: CODE_CAPABILITIES,
  lua: CODE_CAPABILITIES,
  perl: CODE_CAPABILITIES,
  objectivec: CODE_CAPABILITIES,
  ini: CODE_CAPABILITIES,
  toml: CODE_CAPABILITIES,
};

const BUILTIN_EXTENSIONS: Record<BuiltinDocumentFormat, string[]> = {
  markdown: [".md", ".markdown", ".mdown", ".mkd", ".qmd", ".rmd", ".mdx"],
  latex: [".tex", ".latex"],
  mathml: [".mathml", ".mml"],
  plantuml: [".puml", ".plantuml"],
  mermaid: [".mmd", ".mermaid"],
  pdf: [".pdf"],
  text: [],
  cpp: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".ino"],
  java: [".java"],
  javascript: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
  json: [".json", ".jsonc", ".json5"],
  yaml: [".yaml", ".yml"],
  html: [".html", ".htm", ".xhtml"],
  css: [".css", ".scss", ".less", ".sass"],
  python: [".py", ".pyw", ".pyi"],
  sql: [".sql"],
  php: [".php", ".phtml"],
  rust: [".rs"],
  xml: [".xml", ".svg", ".xsd", ".xsl", ".xslt", ".plist"],
  csharp: [".cs", ".csx"],
  go: [".go"],
  ruby: [".rb", ".rake", ".gemspec"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  r: [".r"],
  scala: [".scala", ".sc"],
  shell: [".sh", ".bash", ".zsh", ".ksh"],
  dart: [".dart"],
  lua: [".lua"],
  perl: [".pl", ".pm"],
  objectivec: [".m", ".mm"],
  ini: [".ini", ".cfg", ".properties"],
  toml: [".toml"],
};

/** 内置格式对应的源码高亮语法。 */
const BUILTIN_SYNTAX: Record<BuiltinDocumentFormat, LanguageSyntax> = {
  markdown: "markdown",
  latex: "stex",
  mathml: "xml",
  plantuml: "plain",
  mermaid: "plain",
  pdf: "plain",
  text: "plain",
  cpp: "cpp",
  java: "java",
  javascript: "javascript",
  json: "json",
  yaml: "yaml",
  html: "html",
  css: "css",
  python: "python",
  sql: "sql",
  php: "php",
  rust: "rust",
  xml: "xml",
  csharp: "csharp",
  go: "go",
  ruby: "ruby",
  kotlin: "kotlin",
  swift: "swift",
  r: "r",
  scala: "scala",
  shell: "shell",
  dart: "dart",
  lua: "lua",
  perl: "perl",
  objectivec: "objectivec",
  ini: "ini",
  toml: "toml",
};

let extensionEntries: ExtensionFormatInfo[] = [];

function builtinEntry(format: BuiltinDocumentFormat): FormatEntry {
  return {
    id: format,
    builtin: true,
    extensionId: null,
    extensions: BUILTIN_EXTENSIONS[format],
    capabilities: BUILTIN_CAPABILITIES[format],
    language: BUILTIN_SYNTAX[format],
    syntax: BUILTIN_SYNTAX[format],
  };
}

/** 从主进程刷新扩展贡献的格式快照；禁用扩展不进入注册表。 */
export async function refreshExtensionFormats(): Promise<void> {
  try {
    extensionEntries = (await window.panda.ext.formats()).filter((entry) => entry.enabled);
  } catch {
    extensionEntries = [];
  }
}

export function getExtensionFormatEntries(): FormatEntry[] {
  return extensionEntries.map((entry) => ({
    id: entry.id,
    builtin: false,
    extensionId: entry.extensionId,
    extensions: entry.extensions,
    capabilities: entry.capabilities,
    language: entry.language,
    syntax: entry.syntax,
  }));
}

function matchExtension(fileName: string): ExtensionFormatInfo | null {
  const dot = fileName.lastIndexOf(".");
  const suffix = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  if (!suffix) return null;
  return (
    extensionEntries.find((entry) =>
      entry.extensions.some((item) => item.toLowerCase() === suffix),
    ) ?? null
  );
}

/** 格式检测：内置优先，其次扩展贡献（§7.6.4）。 */
export function detectFormatEntry(fileName: string): FormatEntry | null {
  const builtin = builtinFormatFor(fileName);
  if (builtin) return builtinEntry(builtin);
  const extension = matchExtension(fileName);
  if (!extension) return null;
  return {
    id: extension.id,
    builtin: false,
    extensionId: extension.extensionId,
    extensions: extension.extensions,
    capabilities: extension.capabilities,
    language: extension.language,
    syntax: extension.syntax,
  };
}

export function getFormatEntry(formatId: string): FormatEntry | null {
  const builtin = (
    Object.keys(BUILTIN_CAPABILITIES) as BuiltinDocumentFormat[]
  ).find((item) => item === formatId);
  if (builtin) return builtinEntry(builtin);
  return getExtensionFormatEntries().find((entry) => entry.id === formatId) ?? null;
}
