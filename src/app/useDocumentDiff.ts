import { useEffect, useRef, useState } from "react";
import type { DocumentState } from "../services/document-manager";
import {
  computeLineDiff,
  type DiffHunk,
  type LineDiff,
} from "../diff/compute";
import type { DiffBase, DiffFlags, GitBaselineReason } from "../shared/diff";
import { describeError, getErrorCode } from "../shared/errors";
import { getLocale, t } from "../i18n";

export interface DiffViewState {
  status: "off" | "loading" | "stale" | "ready" | "error";
  base: DiffBase;
  inRepo: boolean;
  baseLabel: string;
  /** 基线文本，供预览渲染删除幽灵块与词级比较。 */
  oldText: string | null;
  diff: LineDiff | null;
  message: string | null;
}

const OFF_STATE: DiffViewState = {
  status: "off",
  base: "lastSave",
  inRepo: false,
  baseLabel: "上次保存",
  oldText: null,
  diff: null,
  message: null,
};

/** 输入停止后再重算，避免每个按键都跑 diff。见 doc/design.md §21.8.6。 */
const REFRESH_DELAY_MS = 500;
/** 连续输入超过该时长仍未完成重算时提示「改动待刷新」。见 §21.8.5。 */
const STALE_AFTER_MS = 3_000;
/** 超过该字符数不再计算差异，避免主线程长时间阻塞。 */
const MAX_DIFF_CHARS = 2 * 1024 * 1024;

/**
 * 拉取基线并计算行/词 diff。Git 基线由主进程读取，`lastSave` 使用文档快照。
 * 非 Git 仓库或未保存文档自动退化为「上次保存」。见 doc/design.md §21.3、§21.4。
 */
export function useDocumentDiff({
  document,
  enabled,
  base,
  ref,
  flags,
  refreshKey,
  onFallback,
}: {
  document: DocumentState | null;
  enabled: boolean;
  base: DiffBase;
  /** `base === "commit"` 时用于读取基线的提交引用。 */
  ref: string;
  /** 与 GitPane 共享的忽略参数。 */
  flags: DiffFlags;
  /** 手动重算信号：连续输入进入「改动待刷新」后由用户触发。 */
  refreshKey: number;
  onFallback(): void;
}): DiffViewState {
  const [state, setState] = useState<DiffViewState>(OFF_STATE);
  const previousRef = useRef<{ documentId: string | null; diff: LineDiff | null }>({
    documentId: null,
    diff: null,
  });
  /** 最近一次成功对比的文档、文本与时间，用于判断装饰是否已经落后。 */
  const readyRef = useRef<{ documentId: string; content: string; at: number } | null>(null);
  /** 当前这轮「内容已变但尚未重算」的起点；输入停止并重算后清空。 */
  const staleSinceRef = useRef<number | null>(null);
  /** Git 不可用时记录原因，退化到「上次保存」后仍向用户提示如何配置。 */
  const fallbackHintRef = useRef<string | null>(null);
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  useEffect(() => {
    if (!document || !enabled) {
      setState((current) =>
        current.status === "off" ? current : { ...current, status: "off", diff: null, message: null },
      );
      return;
    }

    const target = document;
    let cancelled = false;
    const sameDocument = previousRef.current.documentId === target.id;
    const previous = sameDocument ? previousRef.current.diff : null;
    if (!sameDocument) previousRef.current = { documentId: target.id, diff: null };

    setState((current) => ({
      status: previous ? "ready" : "loading",
      base,
      inRepo: sameDocument ? current.inRepo : false,
      baseLabel: current.baseLabel,
      oldText: previous ? current.oldText : null,
      diff: previous,
      message: null,
    }));

    // 大文档直接跳过，避免 diff 与装饰阻塞输入。见 §21.9。
    if (target.content.length > MAX_DIFF_CHARS) {
      setState((current) => ({
        ...current,
        status: "error",
        base,
        diff: null,
        oldText: null,
        message: t("文件超过 2 MB，已跳过差异对比"),
      }));
      return;
    }

    if (base === "commit" && ref.trim().length === 0) {
      setState((current) => ({
        ...current,
        status: "error",
        base,
        diff: null,
        oldText: null,
        message: t("请输入提交引用，例如 HEAD~3、main 或 commit id"),
      }));
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          let oldText: string | null = null;
          let inRepo = false;
          let baseLabel = "上次保存";
          let reason: GitBaselineReason | undefined;

          // 非 UTF-8 文本与 Git 字节基线不可比，仅允许「上次保存」。
          if (
            base !== "lastSave" &&
            target.path &&
            target.encoding !== "utf-8" &&
            target.encoding !== "utf-8-bom"
          ) {
            if (cancelled) return;
            setState((current) => ({
              ...current,
              status: "error",
              base,
              message: t("该编码不支持与 Git 基线对比，请改用「上次保存」"),
            }));
            return;
          }

          if (base === "lastSave" || !target.path) {
            if (base !== "lastSave") {
              // 未保存的文档没有 Git 路径，直接退化为快照对比。
              fallbackHintRef.current = t("未保存的文档没有 Git 路径，已改用上次保存");
              onFallbackRef.current();
              return;
            }
            oldText = target.savedContent;
          } else {
            const result = await window.panda.git.diff({
              path: target.path,
              base,
              ref: base === "commit" ? ref.trim() : undefined,
              newText: target.content,
            });
            // 等待期间切换了文档或基线时，后续结果一律丢弃。
            if (cancelled) return;
            if (!result.inRepo) {
              fallbackHintRef.current = t("未检测到 Git 仓库，已改用上次保存");
              onFallbackRef.current();
              return;
            }
            if (result.reason === "invalid-ref") {
              setState((current) => ({
                ...current,
                status: "error",
                base,
                inRepo: true,
                baseLabel: result.baseLabel,
                oldText: null,
                diff: null,
                message: t("无法解析提交「{0}」，请检查引用是否存在", ref.trim()),
              }));
              return;
            }
            inRepo = true;
            baseLabel = result.baseLabel;
            oldText = result.oldText;
            reason = result.reason;
            fallbackHintRef.current = null;
          }
          if (cancelled) return;

          if (reason === "lfs") {
            setState((current) => ({
              ...current,
              status: "error",
              base,
              inRepo,
              baseLabel,
              oldText: null,
              diff: null,
              message: t("LFS 指针文件不支持差异对比"),
            }));
            return;
          }

          // oldText 为 null 表示基线中不存在该文件，按全文新增处理。
          const diff = computeLineDiff(oldText ?? "", target.content, {
            ignoreWhitespace: flags.whitespace,
            ignoreBlankLines: flags.blankLines,
            ignoreCrAtEol: flags.crAtEol,
          });
          previousRef.current = { documentId: target.id, diff };
          readyRef.current = { documentId: target.id, content: target.content, at: Date.now() };
          staleSinceRef.current = null;
          const notices: string[] = [];
          if (base === "lastSave" && fallbackHintRef.current) {
            notices.push(fallbackHintRef.current);
          }
          if (reason === "no-head") notices.push(t("空仓库：按全文新增展示"));
          if (diff.wordDiffSkipped) notices.push(t("文件较大：仅显示块级差异"));
          setState((current) => ({
            status: "ready",
            base,
            // 快照对比不探测仓库，沿用上一次 Git 探测结果以保留基线选项。
            inRepo: base === "lastSave" ? current.inRepo : inRepo,
            baseLabel,
            oldText: oldText ?? "",
            diff,
            message:
              notices.length > 0
                ? notices.join(getLocale() === "zh" ? "；" : "; ")
                : null,
          }));
        } catch (error) {
          if (cancelled) return;
          const code = getErrorCode(error);
          if (code === "E_GIT_MISSING") {
            fallbackHintRef.current = t(
              "未找到 Git，已改用上次保存；可在 设置 → Git 指定 Git 路径或填写 wsl git",
            );
            onFallbackRef.current();
            return;
          }
          if (code === "E_GIT_NOT_REPO") {
            fallbackHintRef.current = t("未检测到 Git 仓库，已改用上次保存");
            onFallbackRef.current();
            return;
          }
          setState((current) => ({
            ...current,
            status: "error",
            base,
            message: describeError(error),
          }));
        }
      })();
    }, REFRESH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    document?.id,
    document?.content,
    document?.savedContent,
    document?.path,
    enabled,
    base,
    ref,
    flags.whitespace,
    flags.blankLines,
    flags.crAtEol,
    refreshKey,
  ]);

  // 连续输入让装饰落后超过 3 s 时提示「改动待刷新」；输入停止并完成重算后自动恢复。
  // 定时器以「内容首次偏离」为起点，因此不会被每个按键重置。
  useEffect(() => {
    const ready = readyRef.current;
    if (!document || !enabled || !ready || ready.documentId !== document.id) {
      staleSinceRef.current = null;
      return;
    }
    if (ready.content === document.content) {
      staleSinceRef.current = null;
      return;
    }
    staleSinceRef.current ??= Date.now();
    const content = document.content;
    const delay = Math.max(0, STALE_AFTER_MS - (Date.now() - staleSinceRef.current));
    const timer = setTimeout(() => {
      const latest = readyRef.current;
      if (cancelledStale(latest, document.id, content)) return;
      setState((current) => (current.status === "ready" ? { ...current, status: "stale" } : current));
    }, delay);
    return () => clearTimeout(timer);
  }, [document?.id, document?.content, enabled]);

  return state;
}

/** stale 定时器触发时再次确认内容仍落后于最近一次对比结果。 */
function cancelledStale(
  latest: { documentId: string; content: string } | null,
  documentId: string,
  content: string,
): boolean {
  return !latest || latest.documentId !== documentId || latest.content === content;
}

/** 生成源码 gutter 标记：新行新增/修改，删除落在锚点行。 */
export function diffLineMarkers(diff: LineDiff | null) {
  if (!diff) return [];
  const markers = new Map<number, "add" | "change" | "delete">();
  for (const [line] of diff.deletionsAt) markers.set(line, "delete");
  for (const [line, kind] of diff.newLineKinds) markers.set(line, kind);
  return [...markers]
    .map(([line, kind]) => ({ line, kind }))
    .sort((a, b) => a.line - b.line);
}

/** 改动列表用的摘要文本。 */
export function describeHunk(hunk: DiffHunk): string {
  if (hunk.kind === "add") return t("新增 {0} 行", hunk.newCount);
  if (hunk.kind === "delete") return t("删除 {0} 行", hunk.oldCount);
  return t("修改 {0} 行", hunk.newCount);
}
