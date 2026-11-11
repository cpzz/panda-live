import type { LanguagePreference } from "../shared/settings";
import APP_EN from "./en/app.json";
import COMMON_EN from "./en/common.json";
import DIALOG_EN from "./en/dialogs.json";
import ELECTRON_EN from "./en/electron.json";
import PANEL_EN from "./en/panels.json";
import SERVICE_EN from "./en/services.json";

export type Locale = "zh" | "en";
export type { LanguagePreference };

const EN: Record<string, string> = {
  ...COMMON_EN,
  ...APP_EN,
  ...PANEL_EN,
  ...DIALOG_EN,
  ...SERVICE_EN,
  ...ELECTRON_EN,
};

/** 中文为源语言；英文缺失时回退到中文，避免界面出现空字符串。 */
let currentLocale: Locale = "zh";

/** 偏好 → 实际语言；`system` 按系统语言选择，非中文一律用英文。 */
export function resolveLocale(
  preference: LanguagePreference,
  systemLanguage: string,
): Locale {
  if (preference === "zh") return "zh";
  if (preference === "en") return "en";
  return systemLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 翻译界面文案：中文原文即 key，英文模式下查表。
 * 插值使用 `{0}`、`{1}` 占位符，例如 `t("已删除 {0} 个文件", count)`。
 */
export function t(key: string, ...args: Array<string | number>): string {
  const template = currentLocale === "en" ? (EN[key] ?? key) : key;
  if (args.length === 0) return template;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/** 按当前语言格式化时间；用于提示条与会话信息。 */
export function localeTag(): string {
  return currentLocale === "zh" ? "zh-CN" : "en-US";
}
