/** Git 状态与操作的数据契约：主进程解析，渲染进程只消费结构化结果。 */

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

/** 单个工作区变更；`path` 为仓库根下的相对路径。 */
export interface GitChange {
  path: string;
  origPath?: string;
  kind: GitChangeKind;
  /** 已进入暂存区。 */
  staged: boolean;
  /** 工作区仍有未暂存修改。 */
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** porcelain v2 的两位状态码，用于界面显示原始状态。 */
  indexStatus: string;
  worktreeStatus: string;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | null;

export interface GitSnapshot {
  inRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 当前是否有未完成的 merge/rebase/cherry-pick。 */
  operation: GitOperation;
  changes: GitChange[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** ISO 8601 作者时间。 */
  date: string;
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  files: string[];
}
