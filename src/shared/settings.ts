/**
 * 用户设置。见 doc/design.md §15.3。
 * 本版本覆盖外观、编辑、图表与隐私分组；未知分组在读取时保留，避免升级后丢数据。
 */
/** 保存时的换行符策略；`preserve` 沿用文件已有换行。 */
export type SaveEol = "preserve" | "lf" | "crlf";

export interface Settings {
  schemaVersion: number;
  appearance: {
    theme: "system" | "light" | "dark";
    /** 编辑器正文字号（px） */
    fontSize: number;
    /** 正文最大行宽（px） */
    lineWidth: number;
  };
  editor: {
    /** 有路径的文档在停止输入后自动写盘。 */
    autoSave: boolean;
    tabSize: number;
    showLineNumbers: boolean;
    /** 保存时的换行符；`preserve` 沿用文件已有换行。 */
    eol: SaveEol;
  };
  diagram: {
    theme: "system" | "light" | "dark";
  };
  privacy: {
    logLevel: "error" | "warn" | "info" | "debug";
  };
  [key: string]: unknown;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  appearance: { theme: "system", fontSize: 15, lineWidth: 860 },
  editor: { autoSave: true, tabSize: 2, showLineNumbers: true, eol: "preserve" },
  diagram: { theme: "system" },
  privacy: { logLevel: "info" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * 把磁盘上的设置与默认值合并：逐字段校正类型与范围，未知字段原样保留。
 * 版本号仅用于迁移，当前版本无迁移项。见 doc/design.md §15.3。
 */
export function mergeSettings(raw: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const appearance = isRecord(source.appearance) ? source.appearance : {};
  const editor = isRecord(source.editor) ? source.editor : {};
  const diagram = isRecord(source.diagram) ? source.diagram : {};
  const privacy = isRecord(source.privacy) ? source.privacy : {};

  return {
    ...source,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    appearance: {
      ...appearance,
      theme: pickEnum(appearance.theme, ["system", "light", "dark"] as const, "system"),
      fontSize: pickNumber(appearance.fontSize, DEFAULT_SETTINGS.appearance.fontSize, 12, 28),
      lineWidth: pickNumber(appearance.lineWidth, DEFAULT_SETTINGS.appearance.lineWidth, 480, 1600),
    },
    editor: {
      ...editor,
      autoSave: typeof editor.autoSave === "boolean" ? editor.autoSave : DEFAULT_SETTINGS.editor.autoSave,
      tabSize: pickNumber(editor.tabSize, DEFAULT_SETTINGS.editor.tabSize, 1, 8),
      showLineNumbers:
        typeof editor.showLineNumbers === "boolean"
          ? editor.showLineNumbers
          : DEFAULT_SETTINGS.editor.showLineNumbers,
      eol: pickEnum(editor.eol, ["preserve", "lf", "crlf"] as const, "preserve"),
    },
    diagram: {
      ...diagram,
      theme: pickEnum(diagram.theme, ["system", "light", "dark"] as const, "system"),
    },
    privacy: {
      ...privacy,
      logLevel: pickEnum(privacy.logLevel, ["error", "warn", "info", "debug"] as const, "info"),
    },
  };
}

/** 深度合并一组设置补丁；用于设置对话框只提交修改过的分组。 */
export function patchSettings(base: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) return mergeSettings(base);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    merged[key] = isRecord(value) && isRecord(current) ? { ...current, ...value } : value;
  }
  return mergeSettings(merged);
}
