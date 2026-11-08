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

const BUILTIN_CAPABILITIES: Record<BuiltinDocumentFormat, FormatCapabilities> = {
  markdown: { source: true, wysiwyg: true, preview: "inline", outline: true, exportHtml: true },
  latex: { source: true, wysiwyg: false, preview: "none", outline: true, exportHtml: false },
  mathml: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: true },
  plantuml: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: false },
  mermaid: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: false },
  text: { source: true, wysiwyg: false, preview: "none", outline: false, exportHtml: false },
};

const BUILTIN_EXTENSIONS: Record<BuiltinDocumentFormat, string[]> = {
  markdown: [".md", ".markdown", ".mdown", ".mkd", ".qmd", ".rmd", ".mdx"],
  latex: [".tex", ".latex"],
  mathml: [".mathml", ".mml"],
  plantuml: [".puml", ".plantuml"],
  mermaid: [".mmd", ".mermaid"],
  text: [],
};

let extensionEntries: ExtensionFormatInfo[] = [];

function builtinEntry(format: BuiltinDocumentFormat): FormatEntry {
  return {
    id: format,
    builtin: true,
    extensionId: null,
    extensions: BUILTIN_EXTENSIONS[format],
    capabilities: BUILTIN_CAPABILITIES[format],
    language: format === "mathml" ? "xml" : format === "markdown" ? "markdown" : "plain",
    syntax: format === "mathml" ? "xml" : format === "markdown" ? "markdown" : "plain",
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
    ["markdown", "latex", "mathml", "plantuml", "mermaid", "text"] as BuiltinDocumentFormat[]
  ).find((item) => item === formatId);
  if (builtin) return builtinEntry(builtin);
  return getExtensionFormatEntries().find((entry) => entry.id === formatId) ?? null;
}
