import { useEffect, useState } from "react";
import { t } from "../i18n";
import { describeError } from "../shared/errors";
import type { ExtensionInfo } from "../shared/extensions";

interface ExtensionSettingsProps {
  onChanged(): void;
}

/** 设置内的扩展管理页：安装、启用/禁用、卸载、打开目录。见 doc/design.md §7.6.4、§15.3。 */
export function ExtensionSettings({ onChanged }: ExtensionSettingsProps) {
  const [items, setItems] = useState<ExtensionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      setItems(await window.panda.ext.list());
      setError(null);
    } catch (reason) {
      setError(describeError(reason));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
      onChanged();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (item: ExtensionInfo): void => {
    if (item.enabled) {
      void run(() => window.panda.ext.disable(item.id));
      return;
    }
    const permissions = item.permissions.length > 0 ? item.permissions.join(", ") : t("无");
    const confirmed = window.confirm(
      t(
        "发布者：{0}\n版本：{1}\n权限：{2}\n\n本地扩展未经验证，确定启用吗？",
        item.publisher,
        item.version,
        permissions,
      ),
    );
    if (!confirmed) return;
    void run(() => window.panda.ext.enable(item.id));
  };

  const uninstall = (item: ExtensionInfo): void => {
    if (!window.confirm(t("确定卸载扩展“{0}”吗？", item.displayName))) return;
    void run(() => window.panda.ext.uninstall(item.id));
  };

  return (
    <section className="settings-group">
      <h3>{t("扩展")}</h3>
      <p className="settings-note">
        {t("本地扩展从")} <code>.panda</code>{" "}
        {t("包安装，启用后其贡献的格式会出现在格式注册表中。")}
      </p>
      <div className="ext-actions">
        <button
          type="button"
          className="button small"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await window.panda.ext.install();
            })
          }
        >
          {t("安装 .panda")}
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => void window.panda.ext.openFolder().catch(() => undefined)}
        >
          {t("打开扩展目录")}
        </button>
      </div>

      {error && <div className="sidebar-error">{error}</div>}

      <ul className="ext-list">
        {items.map((item) => (
          <li key={item.id} className="ext-item">
            <div className="ext-meta">
              <strong>{item.displayName}</strong>
              <span className="ext-sub">
                {item.id} · v{item.version}
                {item.builtin ? t(" · 内置") : ""}
                {item.permissions.length > 0 ? t(" · {0}", item.permissions.join(", ")) : ""}
              </span>
              {item.error && <span className="ext-error">{item.error}</span>}
            </div>
            <div className="ext-buttons">
              <button
                type="button"
                className={item.enabled ? "button small ghost" : "button small primary"}
                disabled={busy || !!item.error}
                onClick={() => toggle(item)}
              >
                {item.enabled ? t("禁用") : t("启用")}
              </button>
              {!item.builtin && (
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => uninstall(item)}
                >
                  {t("卸载")}
                </button>
              )}
              <button
                type="button"
                className="button small ghost"
                onClick={() => void window.panda.ext.openFolder(item.id).catch(() => undefined)}
              >
                {t("目录")}
              </button>
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="settings-note">{t("尚未安装扩展")}</li>}
      </ul>
    </section>
  );
}
