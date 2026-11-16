/**
 * 渲染态 Git 差异的类型契约。见 doc/design.md §21.3。
 * `lastSave` 使用应用内快照，不走主进程；其余基线由主进程读取。
 */
export type DiffBase = "head" | "index" | "commit" | "lastSave";

/** 需要主进程读取 Git 对象的基线。 */
export type GitDiffBase = Exclude<DiffBase, "lastSave">;

/** 渲染态差异的视图粒度。见 doc/design.md §21.6、§21.8.2。 */
export type DiffViewMode = "full" | "collapse" | "fragments";

/** 与 git diff 对齐的比较选项，状态栏就地标注与 GitPane 共享。 */
export interface DiffFlags {
  whitespace: boolean;
  blankLines: boolean;
  crAtEol: boolean;
}

/**
 * 每个文档的差异状态：状态栏就地标注与 GitPane 差异视图的唯一事实源。
 * 就地标注始终比较 `base ⇄ 缓冲区`；`target/paneMode/refA/refB` 只影响 GitPane。
 * 见 doc/design.md §21.8、§22.9。
 */
export interface DocDiffState {
  /** 状态栏就地标注开关。 */
  enabled: boolean;
  base: DiffBase;
  /** `base === "commit"` 时的提交引用。 */
  ref: string;
  /** GitPane 的「新」侧：工作区缓冲区或暂存区。 */
  target: "buffer" | "index";
  mode: DiffViewMode;
  flags: DiffFlags;
  /** GitPane 比较模式：基线⇄新侧，或提交⇄提交。 */
  paneMode: "baseline" | "refs";
  refA: string;
  refB: string;
}

export const DEFAULT_DOC_DIFF: DocDiffState = {
  enabled: false,
  base: "head",
  ref: "",
  target: "buffer",
  mode: "full",
  flags: { whitespace: false, blankLines: false, crAtEol: true },
  paneMode: "baseline",
  refA: "HEAD~1",
  refB: "HEAD",
};

export interface GitDiffRequest {
  path: string;
  base: GitDiffBase;
  /** `base === "commit"` 时的提交引用，例如 `HEAD~3`、分支名或 commit id。 */
  ref?: string;
  /** 编辑器当前缓冲区，主进程不参与比较，仅随请求传递。 */
  newText: string;
}

export type GitBaselineReason =
  | "no-head"
  | "blob-missing"
  | "untracked"
  | "invalid-ref"
  | "lfs";

export interface GitDiffResult {
  inRepo: boolean;
  baseLabel: string;
  /** 仓库根目录；非仓库时为 null。 */
  repoRoot: string | null;
  /** null 表示基线中不存在该文件（新增 / 未跟踪 / 空仓库）。 */
  oldText: string | null;
  reason?: GitBaselineReason;
}
