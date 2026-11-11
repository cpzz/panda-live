import { useState } from "react";
import type { OutlineItem } from "../formats/outline";
import { t } from "../i18n";
import { Icon } from "./icons";

/** 侧栏大纲面板：标题层级、点击跳转、可折叠。见 doc/design.md §15.1。 */
export function OutlinePanel({
  items,
  onSelect,
}: {
  items: OutlineItem[];
  onSelect(item: OutlineItem): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const baseLevel = items.length > 0 ? Math.min(...items.map((item) => item.level)) : 1;

  return (
    <section className="outline-panel" aria-label={t("文档大纲")}>
      <div className="outline-panel-header">
        <span className="sidebar-title">{t("文档大纲")}</span>
        <button
          type="button"
          className="icon-button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("展开大纲") : t("折叠大纲")}
          title={collapsed ? t("展开大纲") : t("折叠大纲")}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name={collapsed ? "chevron-down" : "chevron-up"} />
        </button>
      </div>
      {!collapsed &&
        (items.length > 0 ? (
          <ul className="outline-list">
            {items.map((item) => (
              <li key={`${item.index}-${item.line}`}>
                <button
                  type="button"
                  className="outline-item"
                  style={{ paddingLeft: `${8 + Math.min(4, item.level - baseLevel) * 12}px` }}
                  title={t("第 {0} 行", item.line)}
                  onClick={() => onSelect(item)}
                >
                  {item.text || t("（无标题）")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-empty">{t("当前文档无大纲")}</p>
        ))}
    </section>
  );
}
