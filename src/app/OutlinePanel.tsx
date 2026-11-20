import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { OutlineItem, OutlineSymbol } from "../formats/outline";
import { t } from "../i18n";
import { Icon, OutlineSymbolIcon } from "./icons";

/** 侧栏大纲面板：按语法类型分组、分类可折叠、点击跳转。见 doc/design.md §15.1。 */
export function OutlinePanel({
  items,
  onSelect,
}: {
  items: OutlineItem[];
  onSelect(item: OutlineItem): void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<OutlineSymbol>>(
    () => new Set<OutlineSymbol>(),
  );
  const groupsRef = useRef<HTMLDivElement>(null);
  const baseLevel = items.length > 0 ? Math.min(...items.map((item) => item.level)) : 1;

  /**
   * Markdown / LaTeX 是纯标题树，保持文档顺序；
   * 其余代码/结构化文档一律按具体语法类型分组，即使只有一种类型也显示分类头，
   * 保证每个大纲项都落在所属分类之下（如 JS/Go 纯函数文件归入「函数」分类）。
   */
  const isHeadingTree =
    items.length > 0 && items.every((item) => item.symbol === "标题" || item.symbol === "图标题");
  const groups = useMemo<Array<[OutlineSymbol, OutlineItem[]]> | null>(() => {
    if (items.length === 0 || isHeadingTree) return null;
    const map = new Map<OutlineSymbol, OutlineItem[]>();
    for (const item of items) {
      const list = map.get(item.symbol);
      if (list) list.push(item);
      else map.set(item.symbol, [item]);
    }
    return [...map.entries()];
  }, [items, isHeadingTree]);

  const toggleGroup = (symbol: OutlineSymbol): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  /** 分类下拉工具栏：展开并滚动到指定分类（参考工作区 locateRoot）。 */
  const locateGroup = (symbol: OutlineSymbol): void => {
    setCollapsedGroups((current) => {
      if (!current.has(symbol)) return current;
      const next = new Set(current);
      next.delete(symbol);
      return next;
    });
    requestAnimationFrame(() => {
      const scroller = groupsRef.current;
      if (!scroller) return;
      const section = [...scroller.querySelectorAll<HTMLElement>(".outline-group")].find(
        (element) => element.dataset.symbol === symbol,
      );
      if (!section) return;
      const top =
        section.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, top) });
    });
  };

  /**
   * 上下方向键直接跳到上/下一条标题，无需回车。
   * 跳转会把焦点交给编辑器，因此激活后把焦点还给大纲项，保证可以连续按键。
   * 折叠的分组不产生 DOM 节点，方向键会自然跳过。
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

  // 分组模式下子项缩进统一（不按 level）；只有标题树保留层级缩进。
  const renderItem = (item: OutlineItem, indentByLevel: boolean) => (
    <li key={`${item.index}-${item.line}`}>
      <button
        type="button"
        className="outline-item"
        style={
          indentByLevel
            ? { paddingLeft: `${8 + Math.min(4, item.level - baseLevel) * 12}px` }
            : undefined
        }
        title={t("第 {0} 行", item.line)}
        onClick={(event) => {
          const button = event.currentTarget;
          onSelect(item);
          // 源码/分栏跳转会聚焦编辑器；把焦点留在当前项，便于继续用方向键浏览。
          requestAnimationFrame(() => button.focus());
        }}
      >
        <OutlineSymbolIcon symbol={item.symbol} size={13} className="outline-item-icon" />
        <span className="outline-item-text">{item.text || t("（无标题）")}</span>
      </button>
    </li>
  );

  const renderList = (list: OutlineItem[], indentByLevel: boolean) => (
    <ul className="outline-list">{list.map((item) => renderItem(item, indentByLevel))}</ul>
  );

  return (
    <section className="outline-panel" aria-label={t("文档大纲")} onKeyDown={moveSelection}>
      {groups && (
        <div className="outline-toolbar">
          <select
            className="outline-group-select"
            aria-label={t("定位分类")}
            title={groups.map(([symbol]) => t(symbol)).join("\n")}
            defaultValue=""
            onChange={(event) => {
              const symbol = event.currentTarget.value as OutlineSymbol;
              // 复位为占位项，便于重复定位同一个分类。
              event.currentTarget.value = "";
              if (symbol) locateGroup(symbol);
            }}
          >
            <option value="">{`${t("分类")} (${groups.length})`}</option>
            {groups.map(([symbol, list]) => (
              <option key={symbol} value={symbol}>
                {`${t(symbol)} (${list.length})`}
              </option>
            ))}
          </select>
        </div>
      )}
      {items.length > 0 ? (
        groups ? (
          <div className="outline-groups" ref={groupsRef}>
            {groups.map(([symbol, list]) => {
              const isCollapsed = collapsedGroups.has(symbol);
              return (
                <section
                  className="outline-group"
                  key={symbol}
                  data-symbol={symbol}
                  aria-label={t(symbol)}
                >
                  <button
                    type="button"
                    className="outline-group-header"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(symbol)}
                  >
                    <Icon
                      name={isCollapsed ? "chevron-right" : "chevron-down"}
                      size={13}
                      className="outline-group-chevron"
                    />
                    <span className="outline-group-title">{t(symbol)}</span>
                    <span className="outline-group-count">{list.length}</span>
                  </button>
                  {!isCollapsed && renderList(list, false)}
                </section>
              );
            })}
          </div>
        ) : (
          renderList(items, true)
        )
      ) : (
        <p className="sidebar-empty">{t("当前文档无大纲")}</p>
      )}
    </section>
  );
}
