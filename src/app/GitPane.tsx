import { useEffect, useMemo, useRef, useState } from "react";
import { computeLineDiff, normalizeFormatText } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import type { DocumentState } from "../services/document-manager";
import type { DocDiffState, GitBaselineReason } from "../shared/diff";
import { describeError } from "../shared/errors";
import { getLocale, t } from "../i18n";
import { sourceLanguageForFormat } from "../source/language";
import { Icon } from "./icons";
import { RenderedMarkdown } from "./RenderedMarkdown";
import { SourceDiffPane } from "./SourceDiffPane";

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
  onDiffChange(patch: Partial<DocDiffState>): void;
  onReturnToEdit(): void;
}

/**
 * Git 差异面板：基线 chip 选择「工作区⇄HEAD / HEAD⇄暂存区 / 提交⇄工作区 / 提交⇄提交」，
 * 粒度与忽略参数与状态栏共享同一份 diffOptions。只渲染差异结果，不提供编辑。
 * 见 doc/design.md §21.3、§21.15、§22.9。
 */
export function GitPane({
  document,
  active,
  diff,
  refreshKey,
  onDiffChange,
  onReturnToEdit,
}: GitPaneProps) {
  const [chipOpen, setChipOpen] = useState(false);
  const chipWrapRef = useRef<HTMLDivElement>(null);
  const [commitDraft, setCommitDraft] = useState(diff.ref || "HEAD");
  const [aDraft, setADraft] = useState(diff.refA);
  const [bDraft, setBDraft] = useState(diff.refB);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [labels, setLabels] = useState({ old: "", next: "" });
  const [result, setResult] = useState<{ oldText: string; newText: string } | null>(null);
  const [sourceMode, setSourceMode] = useState<"diff" | "before" | "after">("diff");
  const [html, setHtml] = useState("");
  const [oldHtml, setOldHtml] = useState("");
  const [navIndex, setNavIndex] = useState(-1);
  const [reveal, setReveal] = useState<{ line: number; token: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Markdown 走渲染态差异，其他格式走并排源码差异。见 §21.15。
  const isMarkdown = document.format === "markdown";

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
        ? (diff.ref.trim() || "HEAD")
        : t("上次保存");
  const chipLabel =
    diff.paneMode === "refs"
      ? `${diff.refA} ⇄ ${diff.refB}`
      : diff.target === "index"
        ? `${baseName} ⇄ ${t("暂存区")}`
        : `${t("工作区")} ⇄ ${baseName}`;

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
                  : t(
                      "提交「{0}」中不存在该文件的当前路径（可能已重命名/移动，或添加时间晚于该提交）。当前按全文新增显示",
                      oldLabel,
                    ),
              );
            }
          }

          const [rendered, renderedOld] = isMarkdown
            ? await Promise.all([
                renderMarkdownToHtml(newText, { annotateSource: true }),
                renderMarkdownToHtml(oldText, { annotateSource: true }),
              ])
            : ["", ""];
          if (cancelled) return;
          setLabels({ old: oldLabel, next: newLabel });
          setNote(notes.length > 0 ? notes.join(getLocale() === "zh" ? "；" : "; ") : null);
          setResult({ oldText, newText });
          setHtml(rendered);
          setOldHtml(renderedOld);
          setNavIndex(-1);
          setStatus("ready");
        } catch (error) {
          if (cancelled) return;
          setResult(null);
          setHtml("");
          setOldHtml("");
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
    document.content,
    document.savedContent,
    document.encoding,
    document.format,
    document.id,
    document.path,
    refreshKey,
  ]);

  /** 逐处跳转：Markdown 渲染态滚动到改动块，源码态移动右侧编辑器光标。 */
  const navTo = (direction: 1 | -1): void => {
    const hunks = baseDiff?.hunks ?? [];
    if (hunks.length === 0) return;
    const next = (navIndex + direction + hunks.length) % hunks.length;
    setNavIndex(next);
    const hunk = hunks[next];
    if (!hunk) return;
    if (!isMarkdown || sourceMode !== "diff") {
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

  const sourceText = sourceMode === "before" ? (result?.oldText ?? "") : (result?.newText ?? "");
  const sourceEmpty = sourceMode !== "diff" && sourceText.trim().length === 0;
  const hunkTotal = baseDiff?.hunks.length ?? 0;

  const applyPreset = (patch: Partial<DocDiffState>): void => {
    onDiffChange(patch);
    setChipOpen(false);
  };

  return (
    <div className="git-diff-pane">
      <div className="git-diff-bar">
        <button
          type="button"
          className="git-icon-button"
          title={t("返回编辑")}
          aria-label={t("返回编辑")}
          onClick={onReturnToEdit}
        >
          <Icon name="pencil" size={14} />
        </button>
        <span className="git-diff-file" title={document.path ?? ""}>
          {document.name}
        </span>

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

        <div className="git-source-switch" role="group" aria-label={t("显示内容")}>
          <button
            type="button"
            className={sourceMode === "diff" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "diff"}
            aria-label={t("对比")}
            title={t("对比：显示改动前后差异")}
            onClick={() => setSourceMode("diff")}
          >
            <Icon name="compare" size={14} />
          </button>
          <button
            type="button"
            className={sourceMode === "before" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "before"}
            aria-label={t("源文件")}
            title={t("源文件：显示改动前内容")}
            onClick={() => setSourceMode("before")}
          >
            <Icon name="fileBefore" size={14} />
          </button>
          <button
            type="button"
            className={sourceMode === "after" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "after"}
            aria-label={t("改动后")}
            title={t("改动后：显示改动后内容")}
            onClick={() => setSourceMode("after")}
          >
            <Icon name="fileAfter" size={14} />
          </button>
        </div>

        {status === "loading" && <span className="git-diff-state">{t("读取中…")}</span>}
        {status === "ready" && sourceMode === "diff" && isMarkdown && (
          <select
            className="git-diff-view"
            aria-label={t("差异视图粒度")}
            title={t("差异视图粒度")}
            value={diff.mode}
            onChange={(event) => onDiffChange({ mode: event.target.value as DocDiffState["mode"] })}
          >
            <option value="fragments">{t("仅改动片段")}</option>
            <option value="collapse">{t("折叠未改动")}</option>
            <option value="full">{t("全文标注")}</option>
          </select>
        )}
        {sourceMode === "diff" && (
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
        )}
        {status === "ready" && sourceMode === "diff" && hunkTotal > 0 && baseDiff && (
          <span className="git-diff-nav">
            <span className="git-diff-count">
              <span className="git-diff-add">+{baseDiff.stats.added}</span>
              <span className="git-diff-del">−{baseDiff.stats.removed}</span>
            </span>
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
          </span>
        )}
      </div>

      {status === "error" && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">{message ?? t("读取 Git 差异失败")}</span>
        </div>
      )}
      {note && status === "ready" && <div className="diff-notice">{note}</div>}
      {status === "ready" && sourceMode === "diff" && formatOnlyCount > 0 && (
        <div className="diff-notice">
          {t(
            "有 {0} 处改动仅涉及空白、缩进或 Markdown 标记，渲染结果与原文相同；黄色竖线表示这些源码行发生了变化。",
            formatOnlyCount,
          )}
        </div>
      )}

      <div className={isMarkdown ? "git-diff-scroll" : "git-diff-scroll git-diff-source"} ref={bodyRef}>
        {status === "ready" && !isMarkdown ? (
          sourceMode === "diff" && baseDiff && baseDiff.hunks.length === 0 ? (
            <p className="placeholder">{t("「{0}」与「{1}」没有差异。", labels.old, labels.next)}</p>
          ) : sourceMode !== "diff" && sourceEmpty ? (
            <p className="placeholder">{t("该提交中没有可显示的文件内容。")}</p>
          ) : (
            <SourceDiffPane
              oldText={result?.oldText ?? ""}
              newText={result?.newText ?? ""}
              diff={sourceMode === "diff" ? baseDiff : null}
              language={sourceLanguageForFormat(document.format)}
              mode={sourceMode}
              oldLabel={labels.old}
              newLabel={labels.next}
              reveal={sourceMode === "diff" ? reveal : null}
            />
          )
        ) : status === "ready" && sourceMode !== "diff" ? (
          sourceEmpty ? (
            <p className="placeholder">{t("该提交中没有可显示的文件内容。")}</p>
          ) : (
            <RenderedMarkdown
              html={sourceMode === "before" ? oldHtml : html}
              filePath={document.path}
              sourceKey={`git-diff:${document.id}:${sourceMode}`}
              diff={null}
              className="git-diff-body"
            />
          )
        ) : status === "ready" && model && model.diff.hunks.length > 0 ? (
          <RenderedMarkdown
            html={html}
            filePath={document.path}
            sourceKey={`git-diff:${document.id}:diff`}
            diff={model}
            onDiffModeChange={(mode) => onDiffChange({ mode })}
            className="git-diff-body"
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
    </div>
  );
}
