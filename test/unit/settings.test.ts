import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, patchSettings, SETTINGS_SCHEMA_VERSION } from "../../src/shared/settings";

describe("设置合并", () => {
  it("空输入回落到默认值", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("broken")).toEqual(DEFAULT_SETTINGS);
  });

  it("非法值被校正到默认值与范围内", () => {
    const merged = mergeSettings({
      appearance: { theme: "purple", fontSize: 100, lineWidth: 100 },
      editor: { autoSave: "yes", tabSize: 0, eol: "crlf-ish" },
      privacy: { logLevel: "verbose" },
    });
    expect(merged.appearance.theme).toBe("system");
    expect(merged.appearance.fontSize).toBe(28);
    expect(merged.appearance.lineWidth).toBe(480);
    expect(merged.editor.autoSave).toBe(true);
    expect(merged.editor.tabSize).toBe(1);
    expect(merged.editor.eol).toBe("preserve");
    expect(merged.privacy.logLevel).toBe("info");
    expect(merged.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("未知字段在读取时保留", () => {
    const merged = mergeSettings({ future: { enabled: true }, appearance: { theme: "light" } });
    expect(merged["future"]).toEqual({ enabled: true });
    expect(merged.appearance.theme).toBe("light");
  });

  it("内容宽度支持像素与百分比，并按单位校正范围", () => {
    expect(mergeSettings({ appearance: { lineWidth: 900 } }).appearance).toMatchObject({
      lineWidth: 900,
      lineWidthUnit: "px",
    });
    expect(
      mergeSettings({ appearance: { lineWidthUnit: "percent", lineWidth: 120 } }).appearance,
    ).toMatchObject({ lineWidth: 100, lineWidthUnit: "percent" });
    expect(
      mergeSettings({ appearance: { lineWidthUnit: "percent", lineWidth: 10 } }).appearance,
    ).toMatchObject({ lineWidth: 30, lineWidthUnit: "percent" });
  });

  it("界面语言仅接受 zh / en / system", () => {
    expect(mergeSettings(undefined).appearance.language).toBe("zh");
    expect(mergeSettings({ appearance: { language: "fr" } }).appearance.language).toBe("zh");
    expect(mergeSettings({ appearance: { language: "en" } }).appearance.language).toBe("en");
    expect(mergeSettings({ appearance: { language: "system" } }).appearance.language).toBe(
      "system",
    );
  });

  it("Git 命令为空时回落默认值，并保留自定义命令", () => {
    expect(mergeSettings({ git: { command: "   " } }).git.command).toBe("git");
    expect(mergeSettings({ git: { command: " wsl git " } }).git.command).toBe("wsl git");
    expect(mergeSettings({ git: { command: 42 } }).git.command).toBe("git");
  });

  it("补丁按分组深度合并", () => {
    const base = mergeSettings({ appearance: { fontSize: 18, theme: "dark" } });
    const patched = patchSettings(base, { appearance: { lineWidth: 700 }, editor: { autoSave: false } });
    expect(patched.appearance.fontSize).toBe(18);
    expect(patched.appearance.theme).toBe("dark");
    expect(patched.appearance.lineWidth).toBe(700);
    expect(patched.editor.autoSave).toBe(false);
  });
});
