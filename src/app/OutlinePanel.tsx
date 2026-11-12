import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

  /**
   * 上下方向键直接跳到上/下一条标题，无需回车。
   * 跳转会把焦点交给编辑器，因此激活后把焦点还给大纲项，保证可以连续按键。
   */
  const moveSelection = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".outline-item")];
    if (buttons.length === 0) return;
    const target = event.target;
    const itemElement =
      target instanceof HTMLElement ? target.closest<HTMLButtonElement>(".outline-item") : null;
    const current = itemElement ? buttons.indexOf(itemElement) : -1;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const index = current < 0 ? (step === 1 ? 0 : buttons.length - 1) : current + step;
    const next = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
    requestAnimationFrame(() => next.focus());
  };

  return (
    <section className="outline-panel" aria-label={t("文档大纲")} onKeyDown={moveSelection}>
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
                  onClick={(event) => {
                    const button = event.currentTarget;
                    onSelect(item);
                    // 源码/分栏跳转会聚焦编辑器；把焦点留在当前项，便于继续用方向键浏览。
                    requestAnimationFrame(() => button.focus());
                  }}
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
