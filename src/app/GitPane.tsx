import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeLineDiff, normalizeDiffText, normalizeFormatText } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import type { DocumentState } from "../services/document-manager";
import type { DocDiffState, GitBaselineReason, GitPaneView } from "../shared/diff";
import { describeError } from "../shared/errors";
import { getLocale, t } from "../i18n";
import { sourceLanguageForFormat } from "../source/language";
import { Icon, type IconName } from "./icons";
import { DiffMinimap } from "./DiffMinimap";
import { RenderedMarkdown } from "./RenderedMarkdown";
import { SourceDiffPane } from "./SourceDiffPane";
import { describeHunk } from "./useDocumentDiff";

type Status = "idle" | "loading" | "ready" | "error";

interface RefText {
  text: string;
  missing: boolean;
  reason?: GitBaselineReason;
}

interface GitPaneProps {
  document: DocumentState;
  active: boolean;
  /** 与状态栏就地标注共享的 per-doc 差异状态（唯一事实源）。 */
  diff: DocDiffState;
  /** Git 写操作成功后的重算信号。 */
  refreshKey: number;
  /** git 模式下模式条左侧工具区的容器；工具通过 portal 渲染到这里。 */
  toolbarHost: HTMLElement | null;
  onDiffChange(patch: Partial<DocDiffState>): void;
}

/** git 模式下的两种显示方式；「预览对比」仅支持渲染的格式可用。 */
const PANE_VIEW_LABELS: Record<GitPaneView, string> = {
  split: "对比",
  render: "预览对比",
};

/**
 * Git 差异面板：内容区只读显示差异；工具栏（对比方式、粒度、忽略参数、改动计数与跳转、
 * 对比/预览对比）通过 portal 渲染到模式条左侧，与「显示模式」按钮同栏。
 * 只读，不渲染图表与代码高亮（预览对比中围栏块按纯文本显示）。
 * 见 doc/design.md §21.15、§22.9。
 */
export function GitPane({
  document,
  active,
  diff,
  refreshKey,
  toolbarHost,
  onDiffChange,
}: GitPaneProps) {
  const [chipOpen, setChipOpen] = useState(false);
  const chipWrapRef = useRef<HTMLDivElement>(null);
  const [commitDraft, setCommitDraft] = useState(diff.ref || "HEAD~1");
  const [aDraft, setADraft] = useState(diff.refA);
  const [bDraft, setBDraft] = useState(diff.refB);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [labels, setLabels] = useState({ old: "", next: "" });
  const [result, setResult] = useState<{ oldText: string; newText: string } | null>(null);
  const [html, setHtml] = useState("");
  const [navIndex, setNavIndex] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [reveal, setReveal] = useState<{ line: number; token: number } | null>(null);
  const [minimapScroller, setMinimapScroller] = useState<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isMarkdown = document.format === "markdown";
  // 预览对比只对支持渲染的格式有意义；其他格式回退为分栏。
  const paneView: GitPaneView = diff.paneView === "render" && !isMarkdown ? "split" : diff.paneView;

  const baseDiff = useMemo(() => {
    if (!result) return null;
    return computeLineDiff(result.oldText, result.newText, {
      ignoreWhitespace: diff.flags.whitespace,
      ignoreBlankLines: diff.flags.blankLines,
      ignoreCrAtEol: diff.flags.crAtEol,
    });
  }, [result, diff.flags]);

  const model = useMemo<PreviewDiffModel | null>(() => {
    if (!result || !baseDiff) return null;
    return { oldText: result.oldText, newText: result.newText, diff: baseDiff, mode: diff.mode };
  }, [result, baseDiff, diff.mode]);

  const formatOnlyCount = useMemo(() => {
    if (!baseDiff || !isMarkdown) return 0;
    return baseDiff.hunks.filter(
      (hunk) => normalizeFormatText(hunk.oldText) === normalizeFormatText(hunk.newText),
    ).length;
  }, [baseDiff, isMarkdown]);

  // 概览条按新文档行号比例映射改动位置。
  const totalNewLines = useMemo(() => {
    if (!result) return 1;
    const text = normalizeDiffText(result.newText, { ignoreCrAtEol: diff.flags.crAtEol });
    if (text.length === 0) return 1;
    return Math.max(1, text.split("\n").length - 1);
  }, [result, diff.flags.crAtEol]);

  // 外部改变基线（如点击历史提交的文件行）后同步输入草稿。
  useEffect(() => {
    if (diff.base === "commit" && diff.ref) setCommitDraft(diff.ref);
  }, [diff.base, diff.ref]);

  // chip 弹层：点击外部或按 Esc 关闭。
  useEffect(() => {
    if (!chipOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !chipWrapRef.current?.contains(event.target)) {
        setChipOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setChipOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [chipOpen]);

  const baseName =
    diff.base === "head"
      ? "HEAD"
      : diff.base === "commit"
        ? (diff.ref.trim() || "HEAD~1")
        : t("上次保存");
  // 新侧永远是编辑器缓冲区：有未保存修改时显示「编辑器缓存」，否则等价于磁盘工作区。
  const workingLabel = document.dirty ? t("编辑器缓存") : t("工作区");
  const chipLabel =
    diff.paneMode === "refs"
      ? `${diff.refA} ⇄ ${diff.refB}`
      : diff.target === "index"
        ? `${baseName} ⇄ ${t("暂存区")}`
        : `${workingLabel} ⇄ ${baseName}`;

  // 对比视图不提供「仅改动片段」：进入 git 模式且为对比时把 fragments 回落为折叠未改动。
  useEffect(() => {
    if (!active) return;
    if (paneView !== "render" && diff.mode === "fragments") {
      onDiffChange({ mode: "collapse" });
    }
  }, [active, paneView, diff.mode, onDiffChange]);

  useEffect(() => {
    if (!active) return;
    if (!document.path) {
      setStatus("error");
      setMessage(t("请先保存文档：Git 差异需要文件路径"));
      return;
    }
    if (document.encoding !== "utf-8" && document.encoding !== "utf-8-bom") {
      setStatus("error");
      setMessage(t("该编码不支持与 Git 基线对比，请改用 UTF-8 文件"));
      return;
    }
    if (diff.paneMode === "refs") {
      if (diff.refA.trim().length === 0 || diff.refB.trim().length === 0) {
        setStatus("error");
        setMessage(t("请输入提交引用，例如 HEAD、HEAD~3、分支名或 commit id"));
        return;
      }
    } else if (diff.base === "commit" && diff.ref.trim().length === 0) {
      setStatus("error");
      setMessage(t("请输入提交引用，例如 HEAD、HEAD~3、分支名或 commit id"));
      return;
    }

    const path = document.path;
    let cancelled = false;
    setStatus("loading");
    setMessage(null);
    setNote(null);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const readRef = async (ref: string): Promise<RefText> => {
            const result = await window.panda.git.diff({
              path,
              base: "commit",
              ref: ref.trim(),
              newText: "",
            });
            if (!result.inRepo) {
              throw new Error(t("未检测到 Git 仓库，请检查设置 → Git 中的 Git 命令"));
            }
            if (result.reason === "invalid-ref") {
              // 首次提交没有父提交：`<hash>^` 解析失败按空文本处理（全文新增）。
              if (ref.trim().endsWith("^")) {
                return { text: "", missing: true };
              }
              throw new Error(t("无法解析提交「{0}」", ref.trim()));
            }
            if (result.reason === "lfs") {
              throw new Error(t("LFS 指针文件不支持差异对比"));
            }
            return {
              text: result.oldText ?? "",
              missing: result.oldText === null,
              reason: result.reason,
            };
          };
          const readBaseline = async (): Promise<RefText> => {
            if (diff.base === "lastSave") {
              return { text: document.savedContent, missing: false };
            }
            const result = await window.panda.git.diff({
              path,
              base: diff.base,
              ref: diff.base === "commit" ? diff.ref.trim() : undefined,
              newText: "",
            });
            if (!result.inRepo) {
              throw new Error(t("未检测到 Git 仓库，请检查设置 → Git 中的 Git 命令"));
            }
            if (result.reason === "invalid-ref") {
              throw new Error(t("无法解析提交「{0}」", diff.ref.trim()));
            }
            if (result.reason === "lfs") {
              throw new Error(t("LFS 指针文件不支持差异对比"));
            }
            return {
              text: result.oldText ?? "",
              missing: result.oldText === null,
              reason: result.reason,
            };
          };

          let oldText: string;
          let newText: string;
          let oldLabel: string;
          let newLabel: string;
          const notes: string[] = [];

          if (diff.paneMode === "refs") {
            const left = await readRef(diff.refA);
            if (cancelled) return;
            const right = await readRef(diff.refB);
            if (cancelled) return;
            oldText = left.text;
            newText = right.text;
            oldLabel = diff.refA.trim();
            newLabel = diff.refB.trim();
            if (left.missing) {
              notes.push(
                left.reason === "untracked"
                  ? t("文件尚未被 Git 跟踪，「{0}」中按空文本处理", oldLabel)
                  : t("提交「{0}」中不存在该文件，按空文本处理", oldLabel),
              );
            }
            if (right.missing) {
              notes.push(
                right.reason === "untracked"
                  ? t("文件尚未被 Git 跟踪，「{0}」中按全文删除显示", newLabel)
                  : t("提交「{0}」中不存在该文件，按全文删除显示", newLabel),
              );
            }
          } else {
            const source = await readBaseline();
            if (cancelled) return;
            oldText = source.text;
            oldLabel = baseName;
            if (diff.target === "index") {
              // 暂存区内容作为「新」侧，展示基线 ⇄ 索引 的已暂存差异。
              const staged = await window.panda.git.diff({ path, base: "index", newText: "" });
              if (cancelled) return;
              if (!staged.inRepo) {
                throw new Error(t("未检测到 Git 仓库，请检查设置 → Git 中的 Git 命令"));
              }
              newText = staged.oldText ?? "";
              newLabel = t("暂存区");
              if (staged.oldText === null) {
                notes.push(t("该文件在暂存区中没有内容，按全文删除显示"));
              }
            } else {
              newText = document.content;
              newLabel = t("当前");
            }
            if (source.missing) {
              notes.push(
                source.reason === "untracked"
                  ? t(
                      "该文件尚未被 Git 跟踪（新文件或还未 git add），{0} 中还没有基线；提交后即可正常对比。当前按全文新增显示",
                      oldLabel,
                    )
                  : source.reason === "no-head"
                    ? t("仓库还没有提交（HEAD 不存在），当前按全文新增显示")
                    : t(
                        "该文件在「{0}」中没有基线（新增文件，或相对该提交重命名/移动）。当前按全文新增显示",
                        oldLabel,
                      ),
              );
            }
          }

          const rendered = isMarkdown
            ? await renderMarkdownToHtml(newText, { annotateSource: true })
            : "";
          if (cancelled) return;
          setLabels({ old: oldLabel, next: newLabel });
          setNote(notes.length > 0 ? notes.join(getLocale() === "zh" ? "；" : "; ") : null);
          setResult({ oldText, newText });
          setHtml(rendered);
          setNavIndex(-1);
          setStatus("ready");
        } catch (error) {
          if (cancelled) return;
          setResult(null);
          setHtml("");
          setStatus("error");
          setMessage(describeError(error));
        }
      })();
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    active,
    diff.paneMode,
    diff.base,
    diff.ref,
    diff.target,
    // 历史提交对比只改 refA/refB；缺少这两项会导致 chip 更新而内容不刷新。
    diff.refA,
    diff.refB,
    document.content,
    document.savedContent,
    document.encoding,
    document.format,
    document.id,
    document.path,
    refreshKey,
  ]);

  /** 跳到指定改动块；索引越界时循环。 */
  const jumpTo = (index: number): void => {
    const hunks = baseDiff?.hunks ?? [];
    if (hunks.length === 0) return;
    const next = ((index % hunks.length) + hunks.length) % hunks.length;
    setNavIndex(next);
    const hunk = hunks[next];
    if (!hunk) return;
    if (paneView !== "render") {
      setReveal({ line: Math.max(1, hunk.newStart), token: next });
      return;
    }
    const host = bodyRef.current;
    if (!host) return;
    const cards = host.querySelectorAll<HTMLElement>(".diff-fragment-card");
    const targets =
      cards.length > 0
        ? [...cards]
        : [...host.querySelectorAll<HTMLElement>(".diff-add, .diff-change, [data-diff-ghost]")];
    if (targets.length === 0) return;
    targets[Math.min(next, targets.length - 1)]?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  };

  /** 逐处跳转：预览对比滚动到改动块，分栏移动右侧编辑器光标。 */
  const navTo = (direction: 1 | -1): void => {
    jumpTo(navIndex + direction);
  };

  // 概览条跟随内容区实际滚动容器：分栏是右侧编辑器，预览对比是外层滚动区。
  useEffect(() => {
    if (status !== "ready") {
      setMinimapScroller(null);
      return;
    }
    if (paneView === "render") {
      setMinimapScroller(bodyRef.current);
      return;
    }
    setMinimapScroller(
      bodyRef.current?.querySelector<HTMLElement>(".git-source-new .cm-scroller") ?? null,
    );
  }, [status, paneView, result, baseDiff]);

  /** 点击概览条空白处：按比例滚动。 */
  const scrollToRatio = (ratio: number): void => {
    const scroller = paneView === "render" ? bodyRef.current : minimapScroller;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = Math.max(0, Math.min(1, ratio)) * max;
  };

  // 改动列表弹层：Esc 关闭。
  useEffect(() => {
    if (!listOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setListOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listOpen]);

  const noDiff = Boolean(baseDiff && baseDiff.hunks.length === 0);
  const hunkTotal = baseDiff?.hunks.length ?? 0;
  // 仅支持渲染的格式才需要「对比 / 预览对比」切换；非 Markdown 固定为对比，不显示按钮。
  type ViewButton = { view: GitPaneView; icon: IconName; label: string };
  const viewButtons: ViewButton[] = isMarkdown
    ? [
        { view: "split", icon: "compare", label: PANE_VIEW_LABELS.split },
        { view: "render", icon: "previewDiff", label: PANE_VIEW_LABELS.render },
      ]
    : [];

  const applyPreset = (patch: Partial<DocDiffState>): void => {
    onDiffChange(patch);
    setChipOpen(false);
  };

  // 工具栏渲染到模式条左侧（portal），与右侧「显示模式」按钮同栏。
  const toolbar = (
    <>
      <div className="git-chip-wrap" ref={chipWrapRef}>
          <button
            type="button"
            className="git-diff-chip"
            aria-expanded={chipOpen}
            aria-label={t("对比方式")}
            title={t("对比方式")}
            onClick={() => setChipOpen((open) => !open)}
          >
            <Icon name="git" size={13} />
            <span>{chipLabel}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          {chipOpen && (
            <div className="git-chip-popover" role="menu" aria-label={t("对比方式")}>
              <button
                type="button"
                role="menuitem"
                className={
                  diff.paneMode === "baseline" && diff.base === "head" && diff.target === "buffer"
                    ? "git-chip-option active"
                    : "git-chip-option"
                }
                onClick={() => applyPreset({ paneMode: "baseline", base: "head", target: "buffer" })}
              >
                {t("工作区 ⇄ HEAD")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={
                  diff.paneMode === "baseline" && diff.base === "head" && diff.target === "index"
                    ? "git-chip-option active"
                    : "git-chip-option"
                }
                onClick={() => applyPreset({ paneMode: "baseline", base: "head", target: "index" })}
              >
                {t("HEAD ⇄ 暂存区")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={
                  diff.paneMode === "baseline" && diff.base === "lastSave"
                    ? "git-chip-option active"
                    : "git-chip-option"
                }
                onClick={() =>
                  applyPreset({ paneMode: "baseline", base: "lastSave", target: "buffer" })
                }
              >
                {t("工作区 ⇄ 上次保存")}
              </button>
              <form
                className="git-chip-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const ref = commitDraft.trim();
                  if (!ref) return;
                  applyPreset({ paneMode: "baseline", base: "commit", ref, target: "buffer" });
                }}
              >
                <label>{t("提交 ⇄ 工作区")}</label>
                <input
                  className="git-diff-input"
                  aria-label={t("对比提交")}
                  title={t("支持 HEAD、HEAD~n、分支、tag 与 commit id")}
                  placeholder="HEAD~3 / commit id"
                  value={commitDraft}
                  onChange={(event) => setCommitDraft(event.target.value)}
                />
                <button type="submit" className="button small">
                  {t("应用")}
                </button>
              </form>
              <form
                className="git-chip-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const a = aDraft.trim();
                  const b = bDraft.trim();
                  if (!a || !b) return;
                  applyPreset({ paneMode: "refs", refA: a, refB: b });
                }}
              >
                <label>{t("提交 ⇄ 提交")}</label>
                <div className="git-chip-refs">
                  <input
                    className="git-diff-input"
                    aria-label={t("提交 A（旧）")}
                    title={t("支持 HEAD、HEAD~n、分支、tag 与 commit id")}
                    placeholder={t("提交 A（旧）")}
                    value={aDraft}
                    onChange={(event) => setADraft(event.target.value)}
                  />
                  <span className="git-diff-side">⇄</span>
                  <input
                    className="git-diff-input"
                    aria-label={t("提交 B（新）")}
                    title={t("支持 HEAD、HEAD~n、分支、tag 与 commit id")}
                    placeholder={t("提交 B（新）")}
                    value={bDraft}
                    onChange={(event) => setBDraft(event.target.value)}
                  />
                  <button type="submit" className="button small">
                    {t("应用")}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>

        {status === "loading" && <span className="git-diff-state">{t("读取中…")}</span>}
        {status === "ready" && (
          <select
            className="git-diff-view"
            aria-label={t("差异视图粒度")}
            title={t("差异视图粒度")}
            value={paneView === "render" ? diff.mode : diff.mode === "full" ? "full" : "collapse"}
            onChange={(event) => onDiffChange({ mode: event.target.value as DocDiffState["mode"] })}
          >
            {paneView === "render" && <option value="fragments">{t("仅改动片段")}</option>}
            <option value="collapse">{t("折叠未改动")}</option>
            <option value="full">{t("全文显示")}</option>
          </select>
        )}
        <span className="git-diff-bar-sep" aria-hidden="true" />
        <div className="git-diff-flags" role="group" aria-label={t("Git 忽略参数")}>
            <button
              type="button"
              className={diff.flags.whitespace ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={diff.flags.whitespace}
              aria-label={t("忽略空白")}
              title={t("忽略空白变化（git diff -w）")}
              onClick={() =>
                onDiffChange({ flags: { ...diff.flags, whitespace: !diff.flags.whitespace } })
              }
            >
              <Icon name="whitespace" size={14} />
            </button>
            <button
              type="button"
              className={diff.flags.blankLines ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={diff.flags.blankLines}
              aria-label={t("忽略空行")}
              title={t("忽略只涉及空行的变化（git diff --ignore-blank-lines）")}
              onClick={() =>
                onDiffChange({ flags: { ...diff.flags, blankLines: !diff.flags.blankLines } })
              }
            >
              <Icon name="blankLines" size={14} />
            </button>
            <button
              type="button"
              className={diff.flags.crAtEol ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={diff.flags.crAtEol}
              aria-label={t("忽略行尾 CR")}
              title={t("忽略行尾 CR（git diff --ignore-cr-at-eol）")}
              onClick={() =>
                onDiffChange({ flags: { ...diff.flags, crAtEol: !diff.flags.crAtEol } })
              }
            >
              <Icon name="carriageReturn" size={14} />
            </button>
          </div>
        <span className="git-diff-bar-sep" aria-hidden="true" />
        {status === "ready" && hunkTotal > 0 && baseDiff && (
          <div className="git-diff-nav git-diff-nav-wrap">
            <button
              type="button"
              className={
                listOpen
                  ? "git-diff-count git-diff-count-button active"
                  : "git-diff-count git-diff-count-button"
              }
              aria-expanded={listOpen}
              aria-label={t("改动列表")}
              title={t("改动列表")}
              onClick={() => setListOpen((open) => !open)}
            >
              <span className="git-diff-add">+{baseDiff.stats.added}</span>
              <span className="git-diff-del">−{baseDiff.stats.removed}</span>
            </button>
            <button
              type="button"
              className="git-icon-button"
              aria-label={t("上一处改动")}
              title={t("上一处改动")}
              onClick={() => navTo(-1)}
            >
              <Icon name="chevron-up" size={12} />
            </button>
            <button
              type="button"
              className="git-icon-button"
              aria-label={t("下一处改动")}
              title={t("下一处改动")}
              onClick={() => navTo(1)}
            >
              <Icon name="chevron-down" size={12} />
            </button>
            {listOpen && (
              <>
                <div className="diff-list-backdrop" onClick={() => setListOpen(false)} />
                <div className="diff-list git-diff-list" role="dialog" aria-label={t("改动列表")}>
                  <div className="diff-list-header">
                    <span>
                      {navIndex >= 0
                        ? t("第 {0} 处 / 共 {1} 处", navIndex + 1, hunkTotal)
                        : t("共 {0} 处", hunkTotal)}
                    </span>
                  </div>
                  <ul role="list">
                    {baseDiff.hunks.map((hunk, index) => {
                      const line = Math.max(1, hunk.newStart);
                      return (
                        <li key={`${hunk.kind}-${hunk.newStart}-${index}`}>
                          <button
                            type="button"
                            className={
                              index === navIndex
                                ? `diff-list-item ${hunk.kind} current`
                                : `diff-list-item ${hunk.kind}`
                            }
                            onClick={() => {
                              jumpTo(index);
                              setListOpen(false);
                            }}
                          >
                            <span className={`diff-list-kind ${hunk.kind}`} aria-hidden="true">
                              {hunk.kind === "add" ? "+" : hunk.kind === "delete" ? "−" : "±"}
                            </span>
                            <span className="diff-list-line" title={t("第 {0} 行", line)}>
                              {t("第 {0} 行", line)}
                            </span>
                            <span className="diff-list-label">{describeHunk(hunk)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
        {viewButtons.length > 0 && (
          <>
            <span className="git-diff-bar-sep" aria-hidden="true" />
            <div className="git-diff-views" role="group" aria-label={t("Git 显示方式")}>
              {viewButtons.map(({ view, icon, label }) => (
                <button
                  key={view}
                  type="button"
                  className={paneView === view ? "git-icon-button active" : "git-icon-button"}
                  aria-pressed={paneView === view}
                  aria-label={t(label)}
                  title={t(label)}
                  onClick={() => onDiffChange({ paneView: view })}
                >
                  <Icon name={icon} size={14} />
                </button>
              ))}
            </div>
          </>
        )}
    </>
  );

  return (
    <>
      {toolbarHost && createPortal(toolbar, toolbarHost)}
      <div className="git-diff-pane">

      {status === "error" && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">{message ?? t("读取 Git 差异失败")}</span>
        </div>
      )}
      {note && status === "ready" && <div className="diff-notice">{note}</div>}
      {status === "ready" && paneView === "render" && formatOnlyCount > 0 && (
        <div className="diff-notice">
          {t(
            "有 {0} 处改动仅涉及空白、缩进或 Markdown 标记，渲染结果与原文相同；黄色竖线表示这些源码行发生了变化。",
            formatOnlyCount,
          )}
        </div>
      )}

      <div className="git-diff-body-row">
        <div
          className={
            paneView === "split" || !isMarkdown
              ? "git-diff-scroll git-diff-source"
              : "git-diff-scroll"
          }
          ref={bodyRef}
        >
          {status === "ready" && paneView === "split" ? (
            noDiff ? (
              <p className="placeholder">{t("「{0}」与「{1}」没有差异。", labels.old, labels.next)}</p>
            ) : (
              <SourceDiffPane
                oldText={result?.oldText ?? ""}
                newText={result?.newText ?? ""}
                diff={baseDiff}
                language={sourceLanguageForFormat(document.format)}
                granularity={diff.mode === "full" ? "full" : "collapse"}
                oldLabel={labels.old}
                newLabel={labels.next}
                reveal={reveal}
              />
            )
          ) : status === "ready" && paneView === "render" && model && !noDiff ? (
            <RenderedMarkdown
              html={html}
              filePath={document.path}
              sourceKey={`git-diff:${document.id}:diff`}
              diff={model}
              onDiffModeChange={(mode) => onDiffChange({ mode })}
              className="git-diff-body"
              plainFences
            />
          ) : (
            <p className="placeholder">
              {status === "loading"
                ? t("正在读取提交…")
                : status === "error"
                  ? t("请调整提交引用或 Git 配置后重试。")
                  : status === "ready"
                    ? t("「{0}」与「{1}」没有差异。", labels.old, labels.next)
                    : t("选择提交后显示 Git 差异。")}
            </p>
          )}
        </div>
        {status === "ready" && !noDiff && baseDiff && hunkTotal > 0 && (
          <DiffMinimap
            hunks={baseDiff.hunks}
            totalLines={totalNewLines}
            activeIndex={navIndex}
            scroller={minimapScroller}
            onJump={jumpTo}
            onScrollRatio={scrollToRatio}
          />
        )}
      </div>
      </div>
    </>
  );
}
