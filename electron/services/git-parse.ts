import type {
  GitBranch,
  GitChange,
  GitChangeKind,
  GitCommit,
  GitCompareStatus,
  GitRemote,
} from "../../src/shared/git";

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

/** 解析 `git log --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e`（可选第 6 段为完整提交信息）。 */
export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of output.split(LOG_RECORD)) {
    const clean = record.replace(/^\r?\n/u, "");
    if (!clean.trim()) continue;
    const [hash, shortHash, subject, author, date, body] = clean.split(LOG_FIELD);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      body: body?.trim() || undefined,
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

export interface ParsedDiffFile {
  status: GitCompareStatus;
  path: string;
  origPath?: string;
}

/** 解析 `git diff --name-status -z --find-renames`；重命名/复制后跟旧路径与新路径。 */
export function parseDiffNameStatus(output: string): ParsedDiffFile[] {
  const tokens = output.split("\0");
  const files: ParsedDiffFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token) continue;
    const status = token[0] as GitCompareStatus;
    if (status === "R" || status === "C") {
      const origPath = tokens[index + 1];
      const path = tokens[index + 2];
      index += 2;
      if (origPath && path) files.push({ status, path, origPath });
      continue;
    }
    const path = tokens[index + 1];
    index += 1;
    if (path) files.push({ status, path });
  }
  return files;
}

export interface ParsedDiffStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * 解析 `git diff --numstat -z --find-renames`。
 * 普通记录为 `增\t删\t路径\0`；重命名记录为 `增\t删\t\0旧路径\0新路径\0`。
 * 二进制文件增删列均为 `-`。
 */
export function parseDiffNumstat(output: string): Map<string, ParsedDiffStat> {
  const stats = new Map<string, ParsedDiffStat>();
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    if (!filePath) {
      // 重命名：当前记录以空路径结尾，后面两个 token 是旧路径与新路径。
      index += 2;
      filePath = tokens[index] ?? "";
    }
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    stats.set(filePath, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return stats;
}

/**
 * 解析 `git remote -v`：每个 remote 两行（fetch / push），名称与地址之间是制表符。
 * 地址本身可能含空格，所以只按首个制表符切分；同名只保留一条，优先 fetch 地址。
 */
export function parseGitRemoteList(output: string): GitRemote[] {
  const found = new Map<string, GitRemote>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(.*?)\t(.*) \((fetch|push)\)$/u.exec(line);
    if (!match) continue;
    const [, name, url, kind] = match;
    if (!name || !url) continue;
    if (kind === "fetch" || !found.has(name)) {
      found.set(name, { name, url });
    }
  }
  return [...found.values()];
}
