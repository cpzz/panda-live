import { useEffect, useRef, useState } from "react";
import type { Settings } from "../shared/settings";
import { t } from "../i18n";
import { ExtensionSettings } from "./ExtensionSettings";
import { useFocusTrap } from "./useFocusTrap";
import { Icon } from "./icons";

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  onClose(): void;
  onSave(patch: unknown): void;
  onExtensionsChanged(): void;
}

/** 设置分区；与左侧导航一一对应（VS Code 风格两栏布局）。见 doc/design.md §15.3。 */
type SettingsSectionKey =
  | "appearance"
  | "editor"
  | "math"
  | "diagram"
  | "latex"
  | "diff"
  | "extensions"
  | "privacy";

const SECTIONS: { key: SettingsSectionKey; title: string }[] = [
  { key: "appearance", title: "外观" },
  { key: "editor", title: "编辑" },
  { key: "math", title: "数学" },
  { key: "diagram", title: "图表" },
  { key: "latex", title: "LaTeX" },
  { key: "diff", title: "Git" },
  { key: "extensions", title: "扩展" },
  { key: "privacy", title: "隐私" },
];

/** 设置对话框：左侧分类导航 + 右侧内容面板；保存写盘不关闭窗口。见 doc/design.md §15.3。 */
export function SettingsDialog({
  open,
  settings,
  onClose,
  onSave,
  onExtensionsChanged,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [section, setSection] = useState<SettingsSectionKey>("appearance");
  const dialogRef = useFocusTrap(open);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      // 仅在「打开」瞬间回到默认分类；保存后 settings 变化不应打断当前浏览的分类。
      if (!wasOpen.current) setSection("appearance");
    }
    wasOpen.current = open;
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const patch = (group: keyof Settings, values: Record<string, unknown>): void => {
    setDraft((current) => ({
      ...current,
      [group]: { ...(current[group] as Record<string, unknown>), ...values },
    }));
  };

  const activeTitle = SECTIONS.find((item) => item.key === section)?.title ?? "";
  // draft 与已保存设置一致时禁用保存，避免无改动写盘（draft 由 settings 展开，键序一致，可安全序列化比较）。
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("设置")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{t("设置")}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("关闭")} title={t("关闭")}>
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("设置分类")}>
            {SECTIONS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`settings-nav-item${section === item.key ? " active" : ""}`}
                aria-current={section === item.key ? "true" : undefined}
                onClick={() => setSection(item.key)}
              >
                {t(item.title)}
              </button>
            ))}
          </nav>

          <div className="settings-pane" aria-label={t(activeTitle)}>
            {section === "appearance" && (
              <>
                <h3 className="settings-pane-title">{t("外观")}</h3>
                <label className="settings-row">
                  <span>{t("主题")}</span>
                  <select
                    value={draft.appearance.theme}
                    onChange={(event) => patch("appearance", { theme: event.target.value })}
                  >
                    <option value="system">{t("跟随系统")}</option>
                    <option value="light">{t("浅色")}</option>
                    <option value="dark">{t("深色")}</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>{t("界面语言")}</span>
                  <select
                    value={draft.appearance.language}
                    onChange={(event) => patch("appearance", { language: event.target.value })}
                  >
                    <option value="zh">{t("中文")}</option>
                    <option value="en">English</option>
                    <option value="system">{t("跟随系统")}</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>{t("字号（px）")}</span>
                  <input
                    type="number"
                    min={12}
                    max={28}
                    value={draft.appearance.fontSize}
                    onChange={(event) => patch("appearance", { fontSize: Number(event.target.value) })}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("图表适配宽度")}</span>
                  <input
                    type="checkbox"
                    checked={draft.appearance.diagramFitWidth}
                    onChange={(event) => patch("appearance", { diagramFitWidth: event.target.checked })}
                  />
                </label>
                <p className="settings-note">
                  {t("勾选时打开独立图表预览或「放大查看」窗口时自动适配面板宽度（工具栏按钮可随时重新适配）；取消后按图表自然宽度显示，超出部分横向滚动。图表不跟随内容宽度百分比。")}
                </p>
              </>
            )}

            {section === "editor" && (
              <>
                <h3 className="settings-pane-title">{t("编辑")}</h3>
                <label className="settings-row">
                  <span>{t("自动保存（停止输入 10 s）")}</span>
                  <input
                    type="checkbox"
                    checked={draft.editor.autoSave}
                    onChange={(event) => patch("editor", { autoSave: event.target.checked })}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("Tab 宽度")}</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={draft.editor.tabSize}
                    onChange={(event) => patch("editor", { tabSize: Number(event.target.value) })}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("Tab 键插入空格")}</span>
                  <input
                    type="checkbox"
                    checked={draft.editor.insertSpaces}
                    onChange={(event) => patch("editor", { insertSpaces: event.target.checked })}
                  />
                </label>
                <p className="settings-note">
                  {t("关闭后 Tab 键插入硬制表符（\\t）；按 Tab 宽度设置显示列宽。")}
                </p>
                <label className="settings-row">
                  <span>{t("显示行号")}</span>
                  <input
                    type="checkbox"
                    checked={draft.editor.showLineNumbers}
                    onChange={(event) => patch("editor", { showLineNumbers: event.target.checked })}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("粘贴纯文本时按 Markdown 解析")}</span>
                  <input
                    type="checkbox"
                    checked={draft.editor.pasteAsMarkdown}
                    onChange={(event) => patch("editor", { pasteAsMarkdown: event.target.checked })}
                  />
                </label>
                <p className="settings-note">
                  {t("关闭时按纯文本插入；开启后识别标题、列表、链接等 Markdown 语法。")}
                </p>
                <label className="settings-row">
                  <span>{t("保存换行符")}</span>
                  <select
                    value={draft.editor.eol}
                    onChange={(event) => patch("editor", { eol: event.target.value })}
                  >
                    <option value="preserve">{t("沿用文件")}</option>
                    <option value="lf">LF</option>
                    <option value="crlf">CRLF</option>
                  </select>
                </label>
              </>
            )}

            {section === "math" && (
              <>
                <h3 className="settings-pane-title">{t("数学")}</h3>
                <label className="settings-row settings-row-top">
                  <span>{t("KaTeX 宏定义")}</span>
                  <textarea
                    className="settings-textarea"
                    rows={4}
                    spellCheck={false}
                    value={draft.math.macros}
                    placeholder={"\\Pr = \\operatorname{Pr}"}
                    onChange={(event) => patch("math", { macros: event.target.value })}
                  />
                </label>
                <p className="settings-note">
                  {t("每行一条，格式")} <code>\命令 = 定义</code>
                  {t("；空行与 % 注释行忽略。")}
                </p>
                <label className="settings-row">
                  <span>{t("单美元内联公式（$…$）")}</span>
                  <input
                    type="checkbox"
                    checked={draft.math.singleDollar}
                    onChange={(event) => patch("math", { singleDollar: event.target.checked })}
                  />
                </label>
                <p className="settings-note">
                  {t("关闭后仅识别 $$…$$ 与 \\(…\\)，避免货币符号被误当作公式。")}
                </p>
              </>
            )}

            {section === "diagram" && (
              <>
                <h3 className="settings-pane-title">{t("图表")}</h3>
                <label className="settings-row">
                  <span>{t("内存缓存上限（条）")}</span>
                  <input
                    type="number"
                    min={10}
                    max={1000}
                    value={draft.diagram.memoryCacheLimit}
                    onChange={(event) =>
                      patch("diagram", { memoryCacheLimit: Number(event.target.value) })
                    }
                  />
                </label>
                <p className="settings-note">{t("图表主题永远跟随应用主题。")}</p>
              </>
            )}

            {section === "latex" && (
              <>
                <h3 className="settings-pane-title">{t("LaTeX")}</h3>
                <label className="settings-row">
                  <span>{t("引擎命令")}</span>
                  <input
                    type="text"
                    className="settings-text"
                    value={draft.latex.engineCommand}
                    placeholder={t("tectonic / latexmk / xelatex 或绝对路径")}
                    onChange={(event) => patch("latex", { engineCommand: event.target.value })}
                  />
                </label>
                <p className="settings-note">
                  {t("为空时按 Tectonic → latexmk → xelatex 自动探测；可填绝对路径。")}
                </p>
                <label className="settings-row">
                  <span>{t("编译超时（秒）")}</span>
                  <input
                    type="number"
                    min={10}
                    max={1800}
                    step={10}
                    value={draft.latex.timeoutSeconds}
                    onChange={(event) =>
                      patch("latex", { timeoutSeconds: Number(event.target.value) })
                    }
                  />
                </label>
                <p className="settings-note">
                  {t("Tectonic 首次编译需下载宏包，超时会自动放宽到至少 600 秒。")}
                </p>
              </>
            )}

            {section === "diff" && (
              <>
                <h3 className="settings-pane-title">{t("Git")}</h3>
                <label className="settings-row">
                  <span>{t("新打开文档默认显示 Git 改动")}</span>
                  <input
                    type="checkbox"
                    checked={draft.diff.defaultOn}
                    onChange={(event) => patch("diff", { defaultOn: event.target.checked })}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("Git 命令")}</span>
                  <input
                    type="text"
                    className="settings-text"
                    value={draft.git.command}
                    placeholder={t("git 或 wsl git")}
                    onChange={(event) => patch("git", { command: event.target.value })}
                  />
                </label>
                <p className="settings-note">
                  {t("默认使用 PATH 中的")} <code>git</code>
                  {t("。找不到时可填绝对路径（含空格请加引号），或使用 WSL：")}
                  <code>wsl git</code>
                  {t("、")}
                  <code>wsl -d Ubuntu git</code>
                  {t("。保存后会自动重试当前文档的 Git 基线。")}
                </p>
                <p className="settings-note">{t("可在状态栏随时开关；非 Git 仓库自动改用「上次保存」对比。")}</p>
              </>
            )}

            {section === "extensions" && <ExtensionSettings onChanged={onExtensionsChanged} />}

            {section === "privacy" && (
              <>
                <h3 className="settings-pane-title">{t("隐私")}</h3>
                <label className="settings-row">
                  <span>{t("日志级别")}</span>
                  <select
                    value={draft.privacy.logLevel}
                    onChange={(event) => patch("privacy", { logLevel: event.target.value })}
                  >
                    <option value="error">error</option>
                    <option value="warn">warn</option>
                    <option value="info">info</option>
                    <option value="debug">debug</option>
                  </select>
                </label>
                <p className="settings-note">{t("草稿与缓存仅写入应用数据目录，不会上传。")}</p>
              </>
            )}
          </div>
        </div>

        <footer className="modal-footer">
          <span className="settings-footer-hint">{t("修改需点击保存后生效")}</span>
          <button type="button" className="button primary" disabled={!dirty} onClick={() => onSave(draft)}>
            {t("保存")}
          </button>
        </footer>
      </div>
    </div>
  );
}
