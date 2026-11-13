import { getFormatEntry } from "../extensions/registry";
import type { SourceLanguage } from "./codemirror";

/** SourceEditor 支持高亮/折叠的语言标识，与 SourceLanguage 保持一致。 */
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
  "plantuml",
  "plain",
]);

/** 无 syntax 元数据的内置格式 → 源码编辑器语言（如 PlantUML 块折叠）。 */
const FORMAT_LANGUAGES: Record<string, SourceLanguage> = {
  plantuml: "plantuml",
};

/** 格式 id → 源码编辑器语言；未知语法退化为纯文本。 */
export function sourceLanguageForFormat(formatId: string): SourceLanguage {
  const direct = FORMAT_LANGUAGES[formatId];
  if (direct) return direct;
  const syntax = getFormatEntry(formatId)?.syntax ?? "plain";
  return SOURCE_LANGUAGES.has(syntax) ? (syntax as SourceLanguage) : "plain";
}
