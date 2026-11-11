import { z } from "zod";
import semver from "semver";
import {
  ALLOWED_PERMISSIONS,
  type ExtensionManifest,
  type FormatCapabilities,
} from "../../src/shared/extensions";
import { t } from "../../src/i18n";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const CapabilitiesSchema = z.object({
  source: z.boolean(),
  wysiwyg: z.boolean(),
  preview: z.enum(["inline", "none"]),
  outline: z.boolean().optional(),
  exportHtml: z.boolean().optional(),
});

const ManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  engines: z.object({ panda: z.string() }),
  main: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  activationEvents: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  contributes: z
    .object({
      formats: z
        .array(
          z.object({
            id: z.string(),
            extensions: z.array(z.string()),
            capabilities: CapabilitiesSchema,
            language: z.string().optional(),
          }),
        )
        .default([]),
      languages: z
        .array(
          z.object({
            id: z.string(),
            extensions: z.array(z.string()),
            syntax: z.enum([
              "markdown",
              "stex",
              "xml",
              "plain",
              "regex",
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
              "ini",
              "toml",
            ]),
            tokenRules: z.array(z.object({ regex: z.string(), token: z.string() })).optional(),
            commentTokens: z
              .object({
                line: z.string().optional(),
                block: z.tuple([z.string(), z.string()]).optional(),
              })
              .optional(),
            folding: z.enum(["indentation", "syntax"]).optional(),
          }),
        )
        .default([]),
      commands: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
      configuration: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ formats: [], languages: [], commands: [], configuration: {} }),
});

export interface ManifestValidation {
  manifest: ExtensionManifest | null;
  errors: string[];
}

function normalizeCapabilities(raw: z.infer<typeof CapabilitiesSchema>): FormatCapabilities {
  return {
    source: raw.source,
    wysiwyg: raw.wysiwyg,
    preview: raw.preview,
    outline: raw.outline ?? false,
    exportHtml: raw.exportHtml ?? false,
  };
}

function isSafeEntry(relative: string): boolean {
  return (
    !relative.startsWith("/") &&
    !relative.startsWith("\\") &&
    !relative.includes("..") &&
    !relative.includes("\\") &&
    !relative.includes(":")
  );
}

/**
 * 校验扩展清单：id/版本/引擎/权限/main 路径/贡献项引用一致性。
 * 失败时返回可读错误列表，扩展被标记为无效而不是让宿主崩溃。见 doc/design.md §7.6.4。
 */
export function validateManifest(raw: unknown, appVersion: string): ManifestValidation {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      manifest: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`),
    };
  }
  const data = parsed.data;
  const errors: string[] = [];

  if (!ID_PATTERN.test(data.id)) {
    errors.push(t("id 必须为 <publisher>.<name> 形式：{0}", data.id));
  }
  if (!semver.valid(data.version)) {
    errors.push(t("版本号不是合法 semver：{0}", data.version));
  }
  if (!semver.validRange(data.engines.panda)) {
    errors.push(t("engines.panda 不是合法 semver 范围：{0}", data.engines.panda));
  } else if (!semver.satisfies(appVersion, data.engines.panda)) {
    errors.push(t("engines.panda={0} 不匹配应用版本 {1}", data.engines.panda, appVersion));
  }
  for (const permission of data.permissions) {
    if (!(ALLOWED_PERMISSIONS as readonly string[]).includes(permission)) {
      errors.push(t("未知权限：{0}", permission));
    }
  }
  if (data.main !== undefined && !isSafeEntry(data.main)) {
    errors.push(t("main 必须是扩展目录内的相对路径：{0}", data.main));
  }
  if (data.contributes.formats.length > 0 && !data.main) {
    errors.push(t("声明格式贡献时必须提供 main 入口"));
  }

  const languageIds = new Set<string>();
  for (const language of data.contributes.languages) {
    if (!PROVIDER_ID_PATTERN.test(language.id)) errors.push(t("语言 id 不合法：{0}", language.id));
    if (languageIds.has(language.id)) errors.push(t("重复的语言 id：{0}", language.id));
    languageIds.add(language.id);
    for (const extension of language.extensions) {
      if (!extension.startsWith(".")) errors.push(t("语言扩展名必须以点开头：{0}", extension));
    }
  }

  const formatIds = new Set<string>();
  for (const format of data.contributes.formats) {
    if (!PROVIDER_ID_PATTERN.test(format.id)) errors.push(t("格式 id 不合法：{0}", format.id));
    if (formatIds.has(format.id)) errors.push(t("重复的格式 id：{0}", format.id));
    formatIds.add(format.id);
    for (const extension of format.extensions) {
      if (!extension.startsWith(".")) errors.push(t("格式扩展名必须以点开头：{0}", extension));
    }
    if (format.language && !languageIds.has(format.language)) {
      errors.push(t("格式 {0} 引用了未声明的语言：{1}", format.id, format.language));
    }
  }

  const commandIds = new Set<string>();
  for (const command of data.contributes.commands) {
    if (commandIds.has(command.id)) errors.push(t("重复的命令 id：{0}", command.id));
    commandIds.add(command.id);
  }

  for (const event of data.activationEvents) {
    const [kind, value] = event.split(":");
    if (kind === "onStartup") continue;
    if (kind === "onFormat" && value && formatIds.has(value)) continue;
    if (kind === "onCommand" && value && commandIds.has(value)) continue;
    errors.push(t("未知激活事件：{0}", event));
  }

  if (errors.length > 0) return { manifest: null, errors };

  return {
    manifest: {
      id: data.id,
      version: data.version,
      engines: data.engines,
      ...(data.main !== undefined ? { main: data.main } : {}),
      ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      activationEvents: data.activationEvents,
      permissions: data.permissions,
      contributes: {
        formats: data.contributes.formats.map((format) => ({
          id: format.id,
          extensions: format.extensions,
          capabilities: normalizeCapabilities(format.capabilities),
          ...(format.language ? { language: format.language } : {}),
        })),
        languages: data.contributes.languages.map((language) => ({
          id: language.id,
          extensions: language.extensions,
          syntax: language.syntax,
          ...(language.tokenRules ? { tokenRules: language.tokenRules } : {}),
          ...(language.commentTokens ? { commentTokens: language.commentTokens } : {}),
          ...(language.folding ? { folding: language.folding } : {}),
        })),
        commands: data.contributes.commands,
        configuration: data.contributes.configuration,
      },
    },
    errors,
  };
}

/** 从 id 前缀推导 publisher。 */
export function publisherOf(id: string): string {
  return id.split(".")[0] ?? id;
}
