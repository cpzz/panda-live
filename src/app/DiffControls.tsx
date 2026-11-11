import { useEffect, useRef, useState } from "react";
import type { DiffBase, DiffViewMode } from "../shared/diff";
import { t } from "../i18n";
import { Icon } from "./icons";
import type { DiffViewState } from "./useDocumentDiff";

export interface DiffListItem {
  line: number;
  label: string;
  kind: "add" | "change" | "delete";
  /** 所属标题面包屑；无标题时为空。 */
  breadcrumb?: string;
}

interface DiffControlsProps {
  enabled: boolean;
  state: DiffViewState;
  items: DiffListItem[];
  currentIndex: number;
  disabled: boolean;
  dirty: boolean;
  mode: DiffViewMode;
  /** 所见即所得为编辑态，不提供折叠/片段粒度。 */
  modeAvailable: boolean;
  /** 已应用的提交引用（base === "commit" 时使用）。 */
  commitRef: string;
  onToggle(): void;
  onBaseChange(base: DiffBase): void;
  onCommitRefApply(ref: string): void;
  onModeChange(mode: DiffViewMode): void;
  onRefresh(): void;
  onPrev(): void;
  onNext(): void;
  onJump(index: number): void;
}

/**
 * 状态栏的改动入口：开关、基线选择、计数、上下一处与改动列表。
 * 见 doc/design.md §21.8.1–§21.8.3。
 */
export function DiffControls({
  enabled,
  state,
  items,
  currentIndex,
  disabled,
  dirty,
  mode,
  modeAvailable,
  commitRef,
  onToggle,
  onBaseChange,
  onCommitRefApply,
  onModeChange,
  onRefresh,
  onPrev,
  onNext,
  onJump,
}: DiffControlsProps) {
  const [listOpen, setListOpen] = useState(false);
  const [refDraft, setRefDraft] = useState(commitRef);
  const refInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRefDraft(commitRef);
  }, [commitRef]);

  useEffect(() => {
    if (enabled && state.base === "commit") refInputRef.current?.focus();
  }, [enabled, state.base]);

  useEffect(() => {
    if (!listOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setListOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listOpen]);

  useEffect(() => {
    if (!enabled) setListOpen(false);
  }, [enabled]);

  const ready = enabled && (state.status === "ready" || state.status === "stale") && state.diff !== null;
  const hasChanges = ready && items.length > 0;
  const loading = enabled && state.status === "loading";
  const stale = enabled && state.status === "stale";
  const failed = enabled && state.status === "error";
  // 计数按块级改动单元统计，与改动列表一一对应。
  const addedUnits = items.filter((item) => item.kind !== "delete").length;
  const removedUnits = items.filter((item) => item.kind === "delete").length;

  useEffect(() => {
    if (!hasChanges) setListOpen(false);
  }, [hasChanges]);

  return (
    <div className="diff-controls">
      <button
        type="button"
        className={enabled ? "statusbar-button diff-toggle active" : "statusbar-button diff-toggle"}
        aria-pressed={enabled}
        title={dirty ? t("显示改动（包含未保存修改）") : t("显示改动（Ctrl+Shift+D）")}
        onClick={onToggle}
        disabled={disabled}
      >
        <span className="diff-sign" aria-hidden="true">
          ±
        </span>
        <span className="diff-label">{t("显示改动")}</span>
        {enabled && dirty && <span className="diff-dirty-dot" aria-label={t("包含未保存修改")} />}
      </button>

      {enabled && (
        <select
          className="diff-base"
          aria-label={t("对比基线")}
          title={
            state.inRepo
              ? t("对比基线")
              : t("未检测到 Git 仓库或 Git 命令，HEAD/暂存区/指定提交不可用")
          }
          value={state.base}
          onChange={(event) => onBaseChange(event.target.value as DiffBase)}
        >
          <option value="head" disabled={!state.inRepo}>
            HEAD
          </option>
          <option value="index" disabled={!state.inRepo}>
            {t("暂存区")}
          </option>
          <option value="commit" disabled={!state.inRepo}>
            {t("指定提交…")}
          </option>
          <option value="lastSave">{t("上次保存")}</option>
        </select>
      )}

      {enabled && state.base === "commit" && (
        <form
          className="diff-ref-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCommitRefApply(refDraft.trim());
          }}
        >
          <input
            ref={refInputRef}
            className="diff-ref-input"
            aria-label={t("提交引用")}
            placeholder="HEAD~3 / main / commit id"
            value={refDraft}
            disabled={!state.inRepo}
            onChange={(event) => setRefDraft(event.target.value)}
          />
          <button type="submit" className="statusbar-button" disabled={!state.inRepo}>
            {t("对比")}
          </button>
        </form>
      )}

      {loading && <span className="statusbar-meta">{t("对比中…")}</span>}
      {stale && (
        <button
          type="button"
          className="statusbar-button diff-stale"
          title={t("连续输入已暂停刷新，点击立即重算")}
          onClick={onRefresh}
        >
          {t("改动待刷新")}
        </button>
      )}
      {failed && (
        <span
          className="statusbar-meta diff-unavailable"
          title={state.message ?? t("基线不可用")}
        >
          {t("不可用")}
        </span>
      )}
      {ready && items.length === 0 && <span className="statusbar-meta">{t("无改动")}</span>}
      {ready && state.message && (
        <span className="statusbar-meta diff-note" title={state.message}>
          {state.message}
        </span>
      )}

      {hasChanges && state.diff && (
        <>
          <button
            type="button"
            className={listOpen ? "statusbar-button diff-count active" : "statusbar-button diff-count"}
            aria-expanded={listOpen}
            title={t("改动列表")}
            onClick={() => setListOpen((open) => !open)}
          >
            <span className="diff-add">+{addedUnits}</span>
            <span className="diff-del">−{removedUnits}</span>
          </button>
          <button
            type="button"
            className="statusbar-button diff-nav"
            aria-label={t("上一处改动")}
            title={t("上一处改动（Shift+F7）")}
            onClick={onPrev}
          >
            <Icon name="chevron-up" size={12} />
          </button>
          <button
            type="button"
            className="statusbar-button diff-nav"
            aria-label={t("下一处改动")}
            title={t("下一处改动（F7）")}
            onClick={onNext}
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </>
      )}

      {listOpen && hasChanges && (
        <>
          <div className="diff-list-backdrop" onClick={() => setListOpen(false)} />
          <div className="diff-list" role="dialog" aria-label={t("改动列表")}>
            <div className="diff-list-header">
              <span>
                {currentIndex >= 0
                  ? t("第 {0} 处 / 共 {1} 处", currentIndex + 1, items.length)
                  : t("共 {0} 处", items.length)}
              </span>
              {modeAvailable ? (
                <select
                  className="diff-mode-select"
                  aria-label={t("差异视图粒度")}
                  title={t("差异视图粒度")}
                  value={mode}
                  onChange={(event) => {
                    onModeChange(event.target.value as DiffViewMode);
                    setListOpen(false);
                  }}
                >
                  <option value="full">{t("全文标注")}</option>
                  <option value="collapse">{t("折叠未改动")}</option>
                  <option value="fragments">{t("仅改动片段")}</option>
                </select>
              ) : (
                <span
                  className="statusbar-meta"
                  title={t("所见即所得为编辑态，无法隐藏可编辑内容；粒度仅适用于预览")}
                >
                  {t("全文标注")}
                </span>
              )}
            </div>
            <ul role="list">
              {items.map((item, index) => (
                <li key={`${item.kind}-${item.line}-${index}`}>
                  <button
                    type="button"
                    className={
                      index === currentIndex
                        ? `diff-list-item ${item.kind} current`
                        : `diff-list-item ${item.kind}`
                    }
                    onClick={() => {
                      onJump(index);
                      setListOpen(false);
                    }}
                  >
                    <span className={`diff-list-kind ${item.kind}`} aria-hidden="true">
                      {item.kind === "add" ? "+" : item.kind === "delete" ? "−" : "±"}
                    </span>
                    <span className="diff-list-line" title={t("第 {0} 行", item.line)}>
                      {item.breadcrumb || t("第 {0} 行", item.line)}
                    </span>
                    <span className="diff-list-label">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
