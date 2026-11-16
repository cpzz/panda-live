import { useEffect, useMemo, useState } from "react";
import { computeLineDiff, normalizeFormatText, type LineDiff } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import type { DocumentState } from "../services/document-manager";
import type { DiffViewMode, GitBaselineReason } from "../shared/diff";
import { describeError } from "../shared/errors";
import { getLocale, t } from "../i18n";
import { sourceLanguageForFormat } from "../source/language";
import { Icon } from "./icons";
import { RenderedMarkdown } from "./RenderedMarkdown";
import { SourceDiffPane } from "./SourceDiffPane";

type CompareMode = "buffer" | "refs";
type Status = "idle" | "loading" | "ready" | "error";

interface RefText {
  text: string;
  missing: boolean;
  reason?: GitBaselineReason;
}

/**
 * Git 差异面板：默认「当前缓冲区 ⇄ 指定提交」，可切换为「提交 A ⇄ 提交 B」。
 * 只渲染差异结果，不提供编辑。见 doc/design.md §21.3、§21.15。
 */
export function GitPane({
  document,
  active,
  initialTarget = "worktree",
}: {
  document: DocumentState;
  active: boolean;
  /** 从侧栏「已暂存」进入时默认对比暂存区。 */
  initialTarget?: "worktree" | "index";
}) {
  const [compareMode, setCompareMode] = useState<CompareMode>("buffer");
  const [compareTarget, setCompareTarget] = useState<"worktree" | "index">(initialTarget);
  const [singleDraft, setSingleDraft] = useState("HEAD");
  const [singleRef, setSingleRef] = useState("HEAD");
  const [aDraft, setADraft] = useState("HEAD~1");
  const [bDraft, setBDraft] = useState("HEAD");
  const [aRef, setARef] = useState("HEAD~1");
  const [bRef, setBRef] = useState("HEAD");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [labels, setLabels] = useState({ old: "", next: "" });
  const [result, setResult] = useState<{ oldText: string; newText: string } | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>("fragments");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreBlankLines, setIgnoreBlankLines] = useState(false);
  const [ignoreCrAtEol, setIgnoreCrAtEol] = useState(true);
  const [sourceMode, setSourceMode] = useState<"diff" | "before" | "after">("diff");
  const [html, setHtml] = useState("");
  const [oldHtml, setOldHtml] = useState("");
  // Markdown 走渲染态差异，其他格式走并排源码差异。见 §21.15。
  const isMarkdown = document.format === "markdown";

  const baseDiff = useMemo<LineDiff | null>(() => {
    if (!result) return null;
    return computeLineDiff(result.oldText, result.newText, {
      ignoreWhitespace,
      ignoreBlankLines,
      ignoreCrAtEol,
    });
  }, [result, ignoreWhitespace, ignoreBlankLines, ignoreCrAtEol]);

  // 默认只展示改动片段；卡片内「返回全文」可切回完整文档。
  const model = useMemo<PreviewDiffModel | null>(() => {
    if (!result || !baseDiff) return null;
    return { oldText: result.oldText, newText: result.newText, diff: baseDiff, mode: viewMode };
  }, [result, baseDiff, viewMode]);
  const formatOnlyCount = useMemo(() => {
    if (!baseDiff || !isMarkdown) return 0;
    return baseDiff.hunks.filter(
      (hunk) => normalizeFormatText(hunk.oldText) === normalizeFormatText(hunk.newText),
    ).length;
  }, [baseDiff, isMarkdown]);

  useEffect(() => {
    if (!active) return;
    const markdown = document.format === "markdown";
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
    const path = document.path;
    const oldRef = compareMode === "buffer" ? singleRef : aRef;
    const nextRef = compareMode === "buffer" ? null : bRef;
    if (oldRef.trim().length === 0 || (nextRef !== null && nextRef.trim().length === 0)) {
      setStatus("error");
      setMessage(t("请输入提交引用，例如 HEAD、HEAD~3、分支名或 commit id"));
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setMessage(null);
    setNote(null);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const read = async (ref: string): Promise<RefText> => {
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

          let oldText: string;
          let newText: string;
          let oldLabel: string;
          let newLabel: string;
          const notes: string[] = [];

          if (compareMode === "buffer") {
            const source = await read(singleRef);
            if (cancelled) return;
            oldText = source.text;
            oldLabel = singleRef.trim();
            if (compareTarget === "index") {
              // 暂存区内容作为「新」侧，展示 HEAD（或指定提交） ⇄ 索引 的已暂存差异。
              const staged = await window.panda.git.diff({
                path,
                base: "index",
                newText: "",
              });
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
          } else {
            const left = await read(aRef);
            if (cancelled) return;
            const right = await read(bRef);
            if (cancelled) return;
            oldText = left.text;
            newText = right.text;
            oldLabel = aRef.trim();
            newLabel = bRef.trim();
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
          }

          const [rendered, renderedOld] = markdown
            ? await Promise.all([
                renderMarkdownToHtml(newText, { annotateSource: true }),
                renderMarkdownToHtml(oldText, { annotateSource: true }),
              ])
            : ["", ""];
          if (cancelled) return;
          setLabels({ old: oldLabel, next: newLabel });
          setNote(
            notes.length > 0 ? notes.join(getLocale() === "zh" ? "；" : "; ") : null,
          );
          setResult({ oldText, newText });
          setHtml(rendered);
          setOldHtml(renderedOld);
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
    compareMode,
    compareTarget,
    document.content,
    document.encoding,
    document.format,
    document.id,
    document.path,
    singleRef,
    aRef,
    bRef,
  ]);

  const sourceText = sourceMode === "before" ? (result?.oldText ?? "") : (result?.newText ?? "");
  const sourceEmpty = sourceMode !== "diff" && sourceText.trim().length === 0;

  return (
    <div className="git-diff-pane">
      <div className="git-diff-bar">
        <button
          type="button"
          className="git-icon-button"
          title={
            compareMode === "buffer"
              ? t("当前 ⇄ 提交（点击切换为提交 ⇄ 提交）")
              : t("提交 ⇄ 提交（点击切换为当前 ⇄ 提交）")
          }
          aria-label={
            compareMode === "buffer" ? t("切换到提交 ⇄ 提交") : t("切换到当前 ⇄ 提交")
          }
          aria-pressed={compareMode === "refs"}
          onClick={() => setCompareMode((mode) => (mode === "buffer" ? "refs" : "buffer"))}
        >
          <Icon name={compareMode === "buffer" ? "git" : "split"} size={14} />
        </button>

        {compareMode === "buffer" ? (
          <form
            className="git-diff-form"
            onSubmit={(event) => {
              event.preventDefault();
              setSingleRef(singleDraft.trim());
            }}
          >
            <input
              className="git-diff-input"
              aria-label={t("对比提交")}
              title={t("支持 HEAD、HEAD~n、分支、tag 与 commit id")}
              placeholder="HEAD / HEAD~3 / commit id"
              value={singleDraft}
              onChange={(event) => setSingleDraft(event.target.value)}
            />
            <button
              type="submit"
              className="git-icon-button"
              title={t("读取并对比")}
              aria-label={t("读取并对比")}
            >
              <Icon name="refresh" size={14} />
            </button>
          </form>
        ) : (
          <form
            className="git-diff-form"
            onSubmit={(event) => {
              event.preventDefault();
              setARef(aDraft.trim());
              setBRef(bDraft.trim());
            }}
          >
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
            <button
              type="submit"
              className="git-icon-button"
              title={t("读取并对比")}
              aria-label={t("读取并对比")}
            >
              <Icon name="refresh" size={14} />
            </button>
          </form>
        )}

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
        {compareMode === "buffer" && (
          <select
            className="git-diff-view"
            aria-label={t("对比基线")}
            title={t("对比基线")}
            value={compareTarget}
            onChange={(event) => setCompareTarget(event.target.value as "worktree" | "index")}
          >
            <option value="worktree">{t("工作区")}</option>
            <option value="index">{t("暂存区")}</option>
          </select>
        )}
        {status === "ready" && sourceMode === "diff" && isMarkdown && (
          <select
            className="git-diff-view"
            aria-label={t("差异视图粒度")}
            title={t("差异视图粒度")}
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as DiffViewMode)}
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
              className={ignoreWhitespace ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreWhitespace}
              aria-label={t("忽略空白")}
              title={t("忽略空白变化（git diff -w）")}
              onClick={() => setIgnoreWhitespace((value) => !value)}
            >
              <Icon name="whitespace" size={14} />
            </button>
            <button
              type="button"
              className={ignoreBlankLines ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreBlankLines}
              aria-label={t("忽略空行")}
              title={t("忽略只涉及空行的变化（git diff --ignore-blank-lines）")}
              onClick={() => setIgnoreBlankLines((value) => !value)}
            >
              <Icon name="blankLines" size={14} />
            </button>
            <button
              type="button"
              className={ignoreCrAtEol ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreCrAtEol}
              aria-label={t("忽略行尾 CR")}
              title={t("忽略行尾 CR（git diff --ignore-cr-at-eol）")}
              onClick={() => setIgnoreCrAtEol((value) => !value)}
            >
              <Icon name="carriageReturn" size={14} />
            </button>
          </div>
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

      <div className={isMarkdown ? "git-diff-scroll" : "git-diff-scroll git-diff-source"}>
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
            onDiffModeChange={setViewMode}
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
