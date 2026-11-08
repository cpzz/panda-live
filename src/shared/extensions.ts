/** 扩展清单与运行时契约；与 doc/design.md §7.6 对应。 */

export interface FormatCapabilities {
  source: boolean;
  wysiwyg: boolean;
  preview: "inline" | "none";
  outline: boolean;
  exportHtml: boolean;
}

export interface ExtensionFormatContribution {
  id: string;
  extensions: string[];
  capabilities: FormatCapabilities;
  language?: string;
}

export type LanguageSyntax = "markdown" | "stex" | "xml" | "plain" | "regex";

export interface ExtensionLanguageContribution {
  id: string;
  extensions: string[];
  syntax: LanguageSyntax;
  tokenRules?: Array<{ regex: string; token: string }>;
  commentTokens?: { line?: string; block?: [string, string] };
  folding?: "indentation" | "syntax";
}

export interface ExtensionCommandContribution {
  id: string;
  title: string;
}

/** 命令面板中可执行的扩展命令。 */
export interface ExtensionCommandInfo extends ExtensionCommandContribution {
  extensionId: string;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  engines: { panda: string };
  main?: string;
  displayName?: string;
  description?: string;
  activationEvents: string[];
  permissions: string[];
  contributes: {
    formats: ExtensionFormatContribution[];
    languages: ExtensionLanguageContribution[];
    commands: ExtensionCommandContribution[];
    configuration: Record<string, unknown>;
  };
}

/** 允许的权限；v1 仅 `workspace:read`。 */
export const ALLOWED_PERMISSIONS = ["workspace:read"] as const;

export interface ExtensionInfo {
  id: string;
  version: string;
  publisher: string;
  displayName: string;
  builtin: boolean;
  enabled: boolean;
  permissions: string[];
  error?: string;
}

/** 渲染进程构造格式注册表所需的贡献信息。 */
export interface ExtensionFormatInfo {
  extensionId: string;
  id: string;
  extensions: string[];
  capabilities: FormatCapabilities;
  language: string;
  syntax: LanguageSyntax;
  enabled: boolean;
}

export interface ExtensionDiagnostic {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
}

export interface ExtensionPreviewResult {
  html: string;
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionParseResult {
  doc: unknown;
  diagnostics: ExtensionDiagnostic[];
}
