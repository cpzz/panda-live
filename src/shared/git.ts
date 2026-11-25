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

/** 已配置的远程；`url` 取 fetch 地址，单独配置过 pushurl 的会在改地址时一并同步。 */
export interface GitRemote {
  name: string;
  url: string;
}

export interface GitSnapshot {
  inRepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 已配置的远程；空数组表示仓库还没有 remote（例如只做本地版本管理）。 */
  remotes: GitRemote[];
  /** 当前是否有未完成的 merge/rebase/cherry-pick。 */
  operation: GitOperation;
  changes: GitChange[];
}

/**
 * 推送/拉取使用的远端：优先 origin，否则取第一个已配置的 remote。
 * 界面展示目标与主进程执行共用同一规则，避免窗口写的目标与实际推送目标不一致。
 */
export function pickRemote(remotes: readonly GitRemote[]): GitRemote | null {
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
}

/** 远程名允许的字符集：首字符不能是连字符，避免被 Git 当成选项。 */
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

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
  /** 完整提交信息（仅文件历史等需要气泡展示时返回）。 */
  body?: string;
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  /** 原始完整提交信息（%B，含换行结构），供 Amend 回填使用。 */
  rawMessage: string;
  files: string[];
}

/** 仓库级比较中的单文件状态（Git name-status 首字母）。 */
export type GitCompareStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface GitCompareFile {
  path: string;
  origPath?: string;
  status: GitCompareStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** 工作区未跟踪文件（只出现在 target 为工作区时）。 */
  untracked?: boolean;
}

export interface GitCompareResult {
  baseLabel: string;
  /** null 表示目标为工作区。 */
  targetLabel: string | null;
  baseHash: string;
  targetHash: string | null;
  files: GitCompareFile[];
  additions: number;
  deletions: number;
}
