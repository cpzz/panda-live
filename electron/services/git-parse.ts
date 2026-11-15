import type { GitBranch, GitChange, GitChangeKind, GitCommit } from "../../src/shared/git";

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

function changeKind(indexStatus: string, worktreeStatus: string, untracked: boolean, conflicted: boolean): GitChangeKind {
  if (untracked) return "untracked";
  if (conflicted) return "conflicted";
  const code = indexStatus !== "." ? indexStatus : worktreeStatus;
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/**
 * 解析 `git status --porcelain=v2 --branch -z`。
 * 路径可能含空格与中文，因此只能按固定字段数切分，不能简单 split(" ") 取最后一段。
 */
export function parseGitStatus(output: string): ParsedStatus {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: GitChange[] = [];
  const tokens = output.split("\0");

  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index] ?? "";
    if (!record) continue;

    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        detached = true;
        branch = null;
      } else {
        branch = value || null;
      }
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("# ")) continue;

    const type = record[0];
    if (type === "?") {
      const path = record.slice(2);
      if (path) {
        changes.push({
          path,
          kind: "untracked",
          staged: false,
          unstaged: true,
          untracked: true,
          conflicted: false,
          indexStatus: "?",
          worktreeStatus: "?",
        });
      }
      continue;
    }
    if (type === "!" || (type !== "1" && type !== "2" && type !== "u")) continue;

    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    const indexStatus = xy[0] ?? ".";
    const worktreeStatus = xy[1] ?? ".";
    const conflicted = type === "u";
    const isRename = type === "2";
    const pathIndex = isRename ? 9 : conflicted ? 10 : 8;
    const path = fields.slice(pathIndex).join(" ");
    if (!path) continue;
    const origPath = isRename ? tokens[index + 1] : undefined;
    if (isRename) index += 1;
    changes.push({
      path,
      origPath: origPath || undefined,
      kind: changeKind(indexStatus, worktreeStatus, false, conflicted),
      staged: indexStatus !== "." && indexStatus !== "?",
      unstaged: worktreeStatus !== ".",
      untracked: false,
      conflicted,
      indexStatus,
      worktreeStatus,
    });
  }

  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { branch, detached, upstream, ahead, behind, changes };
}

/** 解析 `for-each-ref` 的制表符分隔输出。 */
export function parseGitBranches(output: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [refName, name, head, upstream] = line.split("\t");
    if (!refName || !name) continue;
    const remote = refName.startsWith("refs/remotes/");
    if (remote && name.endsWith("/HEAD")) continue;
    branches.push({
      name,
      current: head === "*",
      remote,
      upstream: upstream || undefined,
    });
  }
  return branches;
}

const LOG_FIELD = "\x1f";
const LOG_RECORD = "\x1e";

/** 解析 `git log --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e`。 */
export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of output.split(LOG_RECORD)) {
    const clean = record.replace(/^\r?\n/u, "");
    if (!clean.trim()) continue;
    const [hash, shortHash, subject, author, date] = clean.split(LOG_FIELD);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
    });
  }
  return commits;
}

/** 解析 `git show --name-only -z --format=` 的文件列表。 */
export function parseCommitFiles(output: string): string[] {
  return output
    .split("\0")
    .map((value) => value.replace(/^\r?\n/u, "").trim())
    .filter((value) => value.length > 0);
}
