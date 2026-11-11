import { getFormatEntry } from "../extensions/registry";
import type { SourceLanguage } from "./codemirror";

/** SourceEditor 支持高亮的语言标识，与 SourceLanguage 保持一致。 */
const SOURCE_LANGUAGES = new Set<string>([
  "markdown",
  "xml",
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
  "stex",
  "ini",
  "toml",
  "plain",
]);

/** 格式 id → 源码编辑器语言；未知语法退化为纯文本。 */
export function sourceLanguageForFormat(formatId: string): SourceLanguage {
  const syntax = getFormatEntry(formatId)?.syntax ?? "plain";
  return SOURCE_LANGUAGES.has(syntax) ? (syntax as SourceLanguage) : "plain";
}
