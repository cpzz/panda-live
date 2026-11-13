/**
 * 用户设置。见 doc/design.md §15.3。
 * 本版本覆盖外观、编辑、数学、图表、LaTeX、改动对比与隐私分组；未知分组在读取时保留，避免升级后丢数据。
 */
/** 保存时的换行符策略；`preserve` 沿用文件已有换行。 */
export type SaveEol = "preserve" | "lf" | "crlf";

/** 界面语言：中文、英文，或跟随系统。 */
export type LanguagePreference = "system" | "zh" | "en";

export interface Settings {
  schemaVersion: number;
  appearance: {
    theme: "system" | "light" | "dark";
    /** 编辑器正文字号（px） */
    fontSize: number;
    /** 正文内容宽度，占渲染面板宽度的百分比（30–1000）。 */
    lineWidth: number;
    /** 界面语言；默认中文，可切换英文或跟随系统。 */
    language: LanguagePreference;
  };
  editor: {
    /** 有路径的文档在停止输入后自动写盘。 */
    autoSave: boolean;
    tabSize: number;
    showLineNumbers: boolean;
    /** 保存时的换行符；`preserve` 沿用文件已有换行。 */
    eol: SaveEol;
  };
  math: {
    /** KaTeX 宏定义，每行一条 `\命令 = 定义`；空行与 `%` 注释行忽略。 */
    macros: string;
    /** `$…$` 单美元内联公式；关闭后仅识别 `$$…$$` 与 `\(…\)`。 */
    singleDollar: boolean;
  };
  diagram: {
    /** 内存 SVG 缓存条目上限（10–1000）。 */
    memoryCacheLimit: number;
  };
  latex: {
    /** TeX 引擎命令；为空时按 Tectonic → latexmk → xelatex 自动探测。 */
    engineCommand: string;
    /** 编译超时（秒）；Tectonic 首次编译自动放宽到至少 600 s。 */
    timeoutSeconds: number;
  };
  diff: {
    /** 新打开的文档默认显示与 Git 基线的差异。见 doc/design.md §21.11。 */
    defaultOn: boolean;
  };
  git: {
    /**
     * Git 命令。默认 `git`；找不到时可填绝对路径或 `wsl git` / `wsl -d Ubuntu git`。
     * 见 doc/design.md §21.3。
     */
    command: string;
  };
  privacy: {
    logLevel: "error" | "warn" | "info" | "debug";
  };
  [key: string]: unknown;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  appearance: { theme: "system", fontSize: 15, lineWidth: 100, language: "zh" },
  editor: { autoSave: true, tabSize: 2, showLineNumbers: true, eol: "preserve" },
  math: {
    // KaTeX 内置已支持 \Pr，这里作为默认示例展示宏写法（design.md §9.2）。
    macros: "\\Pr = \\operatorname{Pr}",
    singleDollar: true,
  },
  diagram: { memoryCacheLimit: 100 },
  latex: { engineCommand: "", timeoutSeconds: 60 },
  diff: { defaultOn: false },
  git: { command: "git" },
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
  const math = isRecord(source.math) ? source.math : {};
  const diagram = isRecord(source.diagram) ? source.diagram : {};
  const latex = isRecord(source.latex) ? source.latex : {};
  const diff = isRecord(source.diff) ? source.diff : {};
  const git = isRecord(source.git) ? source.git : {};
  const privacy = isRecord(source.privacy) ? source.privacy : {};

  return {
    ...source,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    appearance: (() => {
      const rest = { ...appearance };
      delete rest.lineWidthUnit;
      // 旧版按像素保存的宽度无法直接换算为百分比，统一回退到 100%。
      const legacyPx = appearance.lineWidthUnit === "px";
      return {
        ...rest,
        theme: pickEnum(appearance.theme, ["system", "light", "dark"] as const, "system"),
        fontSize: pickNumber(appearance.fontSize, DEFAULT_SETTINGS.appearance.fontSize, 12, 28),
        lineWidth: legacyPx
          ? DEFAULT_SETTINGS.appearance.lineWidth
          : pickNumber(appearance.lineWidth, DEFAULT_SETTINGS.appearance.lineWidth, 30, 1000),
        language: pickEnum(
          appearance.language,
          ["system", "zh", "en"] as const,
          DEFAULT_SETTINGS.appearance.language,
        ),
      };
    })(),
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
    math: {
      ...math,
      macros:
        typeof math.macros === "string"
          ? math.macros.slice(0, 8_000)
          : DEFAULT_SETTINGS.math.macros,
      singleDollar:
        typeof math.singleDollar === "boolean"
          ? math.singleDollar
          : DEFAULT_SETTINGS.math.singleDollar,
    },
    diagram: (() => {
      const rest = { ...diagram };
      // 主题覆盖字段已废弃：图表主题永远跟随应用主题。
      delete rest.theme;
      return {
        ...rest,
        memoryCacheLimit: pickNumber(
          diagram.memoryCacheLimit,
          DEFAULT_SETTINGS.diagram.memoryCacheLimit,
          10,
          1000,
        ),
      };
    })(),
    latex: {
      ...latex,
      engineCommand:
        typeof latex.engineCommand === "string" && latex.engineCommand.trim().length > 0
          ? latex.engineCommand.trim().slice(0, 260)
          : "",
      timeoutSeconds: pickNumber(latex.timeoutSeconds, DEFAULT_SETTINGS.latex.timeoutSeconds, 10, 1800),
    },
    diff: {
      ...diff,
      defaultOn:
        typeof diff.defaultOn === "boolean" ? diff.defaultOn : DEFAULT_SETTINGS.diff.defaultOn,
    },
    git: {
      ...git,
      command:
        typeof git.command === "string" && git.command.trim().length > 0
          ? git.command.trim().slice(0, 260)
          : DEFAULT_SETTINGS.git.command,
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
