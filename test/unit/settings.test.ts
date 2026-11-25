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
      appearance: { theme: "purple", fontSize: 100 },
      editor: { autoSave: "yes", tabSize: 0, eol: "crlf-ish" },
      privacy: { logLevel: "verbose" },
    });
    expect(merged.appearance.theme).toBe("system");
    expect(merged.appearance.fontSize).toBe(28);
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

  it("Tab 键输出单位：默认空格，非布尔值回落默认", () => {
    expect(mergeSettings(undefined).editor.insertSpaces).toBe(true);
    expect(mergeSettings({ editor: { insertSpaces: "yes" } }).editor.insertSpaces).toBe(true);
    expect(mergeSettings({ editor: { insertSpaces: false } }).editor.insertSpaces).toBe(false);
  });

  it("粘贴设置：默认按纯文本，开启后按 Markdown 解析", () => {
    expect(mergeSettings(undefined).editor.pasteAsMarkdown).toBe(false);
    expect(mergeSettings({ editor: { pasteAsMarkdown: "yes" } }).editor.pasteAsMarkdown).toBe(false);
    expect(mergeSettings({ editor: { pasteAsMarkdown: true } }).editor.pasteAsMarkdown).toBe(true);
  });

  it("已移除的内容宽度字段在读取时被丢弃", () => {
    expect(mergeSettings({ appearance: { lineWidth: 120 } }).appearance).not.toHaveProperty("lineWidth");
    expect(
      mergeSettings({ appearance: { lineWidth: 860, lineWidthUnit: "px" } }).appearance,
    ).not.toHaveProperty("lineWidthUnit");
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

  it("Git 同步设置：枚举、布尔与超时范围校正", () => {
    expect(mergeSettings(undefined).git).toEqual(DEFAULT_SETTINGS.git);
    const merged = mergeSettings({
      git: {
        pullStrategy: "rebase",
        fetchPrune: false,
        networkTimeoutSeconds: 5,
        autoRefresh: "60s",
        historyPageSize: 100,
      },
    });
    expect(merged.git.pullStrategy).toBe("rebase");
    expect(merged.git.fetchPrune).toBe(false);
    expect(merged.git.networkTimeoutSeconds).toBe(30);
    expect(merged.git.autoRefresh).toBe("60s");
    expect(merged.git.historyPageSize).toBe(100);

    const invalid = mergeSettings({
      git: {
        pullStrategy: "squash",
        fetchPrune: "yes",
        networkTimeoutSeconds: 99_999,
        autoRefresh: "always",
        historyPageSize: 75,
      },
    });
    expect(invalid.git.pullStrategy).toBe("rebase");
    expect(invalid.git.fetchPrune).toBe(true);
    expect(invalid.git.networkTimeoutSeconds).toBe(600);
    expect(invalid.git.autoRefresh).toBe("focus");
    expect(invalid.git.historyPageSize).toBe(50);
  });

  it("默认对比基线仅接受 head / index / lastSave", () => {
    expect(mergeSettings(undefined).diff.defaultBase).toBe("head");
    expect(mergeSettings({ diff: { defaultBase: "index" } }).diff.defaultBase).toBe("index");
    expect(mergeSettings({ diff: { defaultBase: "lastSave" } }).diff.defaultBase).toBe("lastSave");
    expect(mergeSettings({ diff: { defaultBase: "worktree" } }).diff.defaultBase).toBe("head");
  });

  it("补丁按分组深度合并", () => {
    const base = mergeSettings({ appearance: { fontSize: 18, theme: "dark" } });
    const patched = patchSettings(base, { appearance: { fontSize: 20 }, editor: { autoSave: false } });
    expect(patched.appearance.fontSize).toBe(20);
    expect(patched.appearance.theme).toBe("dark");
    expect(patched.editor.autoSave).toBe(false);
  });

  it("数学分组：宏文本、单美元开关非法值回落默认", () => {
    expect(mergeSettings(undefined).math).toEqual({
      macros: DEFAULT_SETTINGS.math.macros,
      singleDollar: true,
    });
    expect(mergeSettings({ math: { macros: 42, singleDollar: "yes" } }).math).toEqual({
      macros: DEFAULT_SETTINGS.math.macros,
      singleDollar: true,
    });
    expect(mergeSettings({ math: { singleDollar: false } }).math.singleDollar).toBe(false);
    const longText = "x".repeat(9_000);
    expect(mergeSettings({ math: { macros: longText } }).math.macros.length).toBe(8_000);
  });

  it("图表分组：缓存上限范围，主题覆盖字段被移除（图表主题跟随应用）", () => {
    expect(mergeSettings(undefined).diagram).toEqual({ memoryCacheLimit: 100 });
    expect(mergeSettings({ diagram: { memoryCacheLimit: 5 } }).diagram).toEqual({
      memoryCacheLimit: 10,
    });
    const legacy = mergeSettings({ diagram: { theme: "dark", memoryCacheLimit: 5000 } });
    expect(legacy.diagram).toEqual({ memoryCacheLimit: 1000 });
    expect(legacy.diagram).not.toHaveProperty("theme");
  });

  it("LaTeX 分组：引擎命令去空白、超时范围", () => {
    expect(mergeSettings(undefined).latex).toEqual({ engineCommand: "", timeoutSeconds: 60 });
    expect(mergeSettings({ latex: { engineCommand: "  wsl xelatex " } }).latex).toEqual({
      engineCommand: "wsl xelatex",
      timeoutSeconds: 60,
    });
    expect(mergeSettings({ latex: { timeoutSeconds: 1 } }).latex.timeoutSeconds).toBe(10);
    expect(mergeSettings({ latex: { timeoutSeconds: 99_999 } }).latex.timeoutSeconds).toBe(1800);
    expect(mergeSettings({ latex: { timeoutSeconds: 300 } }).latex.timeoutSeconds).toBe(300);
  });
});
