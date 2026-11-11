import { afterEach, describe, expect, it } from "vitest";
import { getLocale, resolveLocale, setLocale, t } from "../../src/i18n";

afterEach(() => {
  setLocale("zh");
});

describe("界面语言解析", () => {
  it("显式偏好优先于系统语言", () => {
    expect(resolveLocale("zh", "en-US")).toBe("zh");
    expect(resolveLocale("en", "zh-CN")).toBe("en");
  });

  it("跟随系统时按语言前缀判断", () => {
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
    expect(resolveLocale("system", "zh-Hant-TW")).toBe("zh");
    expect(resolveLocale("system", "en-US")).toBe("en");
    expect(resolveLocale("system", "ja-JP")).toBe("en");
  });
});

describe("翻译函数", () => {
  it("中文模式返回原文并支持占位符", () => {
    setLocale("zh");
    expect(t("保存")).toBe("保存");
    expect(t("行 {0}，列 {1}", 3, 7)).toBe("行 3，列 7");
    expect(getLocale()).toBe("zh");
  });

  it("英文模式查词典并支持占位符", () => {
    setLocale("en");
    expect(t("保存")).toBe("Save");
    expect(t("行 {0}，列 {1}", 3, 7)).toBe("Ln 3, Col 7");
    expect(getLocale()).toBe("en");
  });

  it("缺少英文词条时回退到中文原文", () => {
    setLocale("en");
    expect(t("这个键故意不存在")).toBe("这个键故意不存在");
  });
});
