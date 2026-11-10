import { useEffect, useMemo, useState } from "react";
import { computeLineDiff, normalizeFormatText, type LineDiff } from "../diff/compute";
import type { PreviewDiffModel } from "../diff/preview";
import { renderMarkdownToHtml } from "../formats/markdown/preview";
import type { DocumentState } from "../services/document-manager";
import type { DiffViewMode, GitBaselineReason } from "../shared/diff";
import { describeError } from "../shared/errors";
import { Icon } from "./icons";
import { RenderedMarkdown } from "./RenderedMarkdown";

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
}: {
  document: DocumentState;
  active: boolean;
}) {
  const [compareMode, setCompareMode] = useState<CompareMode>("buffer");
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
    if (!baseDiff) return 0;
    return baseDiff.hunks.filter(
      (hunk) => normalizeFormatText(hunk.oldText) === normalizeFormatText(hunk.newText),
    ).length;
  }, [baseDiff]);

  useEffect(() => {
    if (!active) return;
    if (document.format !== "markdown") {
      setStatus("error");
      setMessage("Git 差异视图只支持 Markdown 渲染");
      return;
    }
    if (!document.path) {
      setStatus("error");
      setMessage("请先保存文档：Git 差异需要文件路径");
      return;
    }
    if (document.encoding !== "utf-8" && document.encoding !== "utf-8-bom") {
      setStatus("error");
      setMessage("该编码不支持与 Git 基线对比，请改用 UTF-8 文件");
      return;
    }
    const path = document.path;
    const oldRef = compareMode === "buffer" ? singleRef : aRef;
    const nextRef = compareMode === "buffer" ? null : bRef;
    if (oldRef.trim().length === 0 || (nextRef !== null && nextRef.trim().length === 0)) {
      setStatus("error");
      setMessage("请输入提交引用，例如 HEAD、HEAD~3、分支名或 commit id");
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
              throw new Error("未检测到 Git 仓库，请检查设置 → 改动对比 中的 Git 命令");
            }
            if (result.reason === "invalid-ref") {
              throw new Error(`无法解析提交「${ref.trim()}」`);
            }
            if (result.reason === "lfs") {
              throw new Error("LFS 指针文件不支持差异对比");
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
            newText = document.content;
            oldLabel = singleRef.trim();
            newLabel = "当前";
            if (source.missing) {
              notes.push(
                source.reason === "untracked"
                  ? `该文件尚未被 Git 跟踪（新文件或还未 git add），${oldLabel} 中还没有基线；提交后即可正常对比。当前按全文新增显示`
                  : `提交「${oldLabel}」中不存在该文件的当前路径（可能已重命名/移动，或添加时间晚于该提交）。当前按全文新增显示`,
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
                  ? `文件尚未被 Git 跟踪，「${oldLabel}」中按空文本处理`
                  : `提交「${oldLabel}」中不存在该文件，按空文本处理`,
              );
            }
            if (right.missing) {
              notes.push(
                right.reason === "untracked"
                  ? `文件尚未被 Git 跟踪，「${newLabel}」中按全文删除显示`
                  : `提交「${newLabel}」中不存在该文件，按全文删除显示`,
              );
            }
          }

          const [rendered, renderedOld] = await Promise.all([
            renderMarkdownToHtml(newText, { annotateSource: true }),
            renderMarkdownToHtml(oldText, { annotateSource: true }),
          ]);
          if (cancelled) return;
          setLabels({ old: oldLabel, next: newLabel });
          setNote(notes.length > 0 ? notes.join("；") : null);
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
              ? "当前 ⇄ 提交（点击切换为提交 ⇄ 提交）"
              : "提交 ⇄ 提交（点击切换为当前 ⇄ 提交）"
          }
          aria-label={compareMode === "buffer" ? "切换到提交 ⇄ 提交" : "切换到当前 ⇄ 提交"}
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
              aria-label="对比提交"
              title="支持 HEAD、HEAD~n、分支、tag 与 commit id"
              placeholder="HEAD / HEAD~3 / commit id"
              value={singleDraft}
              onChange={(event) => setSingleDraft(event.target.value)}
            />
            <button
              type="submit"
              className="git-icon-button"
              title="读取并对比"
              aria-label="读取并对比"
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
              aria-label="提交 A（旧）"
              title="支持 HEAD、HEAD~n、分支、tag 与 commit id"
              placeholder="提交 A（旧）"
              value={aDraft}
              onChange={(event) => setADraft(event.target.value)}
            />
            <span className="git-diff-side">⇄</span>
            <input
              className="git-diff-input"
              aria-label="提交 B（新）"
              title="支持 HEAD、HEAD~n、分支、tag 与 commit id"
              placeholder="提交 B（新）"
              value={bDraft}
              onChange={(event) => setBDraft(event.target.value)}
            />
            <button
              type="submit"
              className="git-icon-button"
              title="读取并对比"
              aria-label="读取并对比"
            >
              <Icon name="refresh" size={14} />
            </button>
          </form>
        )}

        <div className="git-source-switch" role="group" aria-label="显示内容">
          <button
            type="button"
            className={sourceMode === "diff" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "diff"}
            aria-label="对比"
            title="对比：显示改动前后差异"
            onClick={() => setSourceMode("diff")}
          >
            <Icon name="compare" size={14} />
          </button>
          <button
            type="button"
            className={sourceMode === "before" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "before"}
            aria-label="源文件"
            title="源文件：显示改动前内容"
            onClick={() => setSourceMode("before")}
          >
            <Icon name="fileBefore" size={14} />
          </button>
          <button
            type="button"
            className={sourceMode === "after" ? "git-icon-button active" : "git-icon-button"}
            aria-pressed={sourceMode === "after"}
            aria-label="改动后"
            title="改动后：显示改动后内容"
            onClick={() => setSourceMode("after")}
          >
            <Icon name="fileAfter" size={14} />
          </button>
        </div>

        {status === "loading" && <span className="git-diff-state">读取中…</span>}
        {status === "ready" && sourceMode === "diff" && (
          <select
            className="git-diff-view"
            aria-label="差异视图粒度"
            title="差异视图粒度"
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as DiffViewMode)}
          >
            <option value="fragments">仅改动片段</option>
            <option value="collapse">折叠未改动</option>
            <option value="full">全文标注</option>
          </select>
        )}
        {sourceMode === "diff" && (
          <div className="git-diff-flags" role="group" aria-label="Git 忽略参数">
            <button
              type="button"
              className={ignoreWhitespace ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreWhitespace}
              aria-label="忽略空白"
              title="忽略空白变化（git diff -w）"
              onClick={() => setIgnoreWhitespace((value) => !value)}
            >
              <Icon name="whitespace" size={14} />
            </button>
            <button
              type="button"
              className={ignoreBlankLines ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreBlankLines}
              aria-label="忽略空行"
              title="忽略只涉及空行的变化（git diff --ignore-blank-lines）"
              onClick={() => setIgnoreBlankLines((value) => !value)}
            >
              <Icon name="blankLines" size={14} />
            </button>
            <button
              type="button"
              className={ignoreCrAtEol ? "git-icon-button active" : "git-icon-button"}
              aria-pressed={ignoreCrAtEol}
              aria-label="忽略行尾 CR"
              title="忽略行尾 CR（git diff --ignore-cr-at-eol）"
              onClick={() => setIgnoreCrAtEol((value) => !value)}
            >
              <Icon name="carriageReturn" size={14} />
            </button>
          </div>
        )}
      </div>

      {status === "error" && (
        <div className="banner banner-warning" role="alert">
          <span className="banner-text">{message ?? "读取 Git 差异失败"}</span>
        </div>
      )}
      {note && status === "ready" && <div className="diff-notice">{note}</div>}
      {status === "ready" && sourceMode === "diff" && formatOnlyCount > 0 && (
        <div className="diff-notice">
          有 {formatOnlyCount} 处改动仅涉及空白、缩进或 Markdown 标记，渲染结果与原文相同；黄色竖线表示这些源码行发生了变化。
        </div>
      )}

      <div className="git-diff-scroll">
        {status === "ready" && sourceMode !== "diff" ? (
          sourceEmpty ? (
            <p className="placeholder">该提交中没有可显示的文件内容。</p>
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
              ? "正在读取提交…"
              : status === "error"
                ? "请调整提交引用或 Git 配置后重试。"
                : status === "ready"
                  ? `「${labels.old}」与「${labels.next}」没有差异。`
                  : "选择提交后显示渲染后的 Git 差异。"}
          </p>
        )}
      </div>
    </div>
  );
}
