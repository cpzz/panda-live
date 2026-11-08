import { useEffect, useState } from "react";
import type { Settings } from "../shared/settings";
import { ExtensionSettings } from "./ExtensionSettings";

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  onClose(): void;
  onSave(patch: unknown): void;
  onExtensionsChanged(): void;
}

/** 设置对话框：外观、编辑、图表、隐私与扩展分组。见 doc/design.md §15.3。 */
export function SettingsDialog({
  open,
  settings,
  onClose,
  onSave,
  onExtensionsChanged,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => {
    if (open) setDraft(settings);
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

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>设置</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-group">
            <h3>外观</h3>
            <label className="settings-row">
              <span>主题</span>
              <select
                value={draft.appearance.theme}
                onChange={(event) => patch("appearance", { theme: event.target.value })}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <label className="settings-row">
              <span>字号（px）</span>
              <input
                type="number"
                min={12}
                max={28}
                value={draft.appearance.fontSize}
                onChange={(event) => patch("appearance", { fontSize: Number(event.target.value) })}
              />
            </label>
            <label className="settings-row">
              <span>正文行宽（px）</span>
              <input
                type="number"
                min={480}
                max={1600}
                step={20}
                value={draft.appearance.lineWidth}
                onChange={(event) => patch("appearance", { lineWidth: Number(event.target.value) })}
              />
            </label>
          </section>

          <section className="settings-group">
            <h3>编辑</h3>
            <label className="settings-row">
              <span>自动保存（停止输入 10 s）</span>
              <input
                type="checkbox"
                checked={draft.editor.autoSave}
                onChange={(event) => patch("editor", { autoSave: event.target.checked })}
              />
            </label>
            <label className="settings-row">
              <span>Tab 宽度</span>
              <input
                type="number"
                min={1}
                max={8}
                value={draft.editor.tabSize}
                onChange={(event) => patch("editor", { tabSize: Number(event.target.value) })}
              />
            </label>
          </section>

          <section className="settings-group">
            <h3>图表</h3>
            <label className="settings-row">
              <span>渲染主题</span>
              <select
                value={draft.diagram.theme}
                onChange={(event) => patch("diagram", { theme: event.target.value })}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </section>

          <section className="settings-group">
            <h3>隐私</h3>
            <label className="settings-row">
              <span>日志级别</span>
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
            <p className="settings-note">草稿与缓存仅写入应用数据目录，不会上传。</p>
          </section>

          <ExtensionSettings onChanged={onExtensionsChanged} />
        </div>

        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
