import { describe, expect, it } from "vitest";
import {
  parseCommitFiles,
  parseDiffNameStatus,
  parseDiffNumstat,
  parseGitBranches,
  parseGitLog,
  parseGitStatus,
} from "../../electron/services/git-parse";

describe("Git porcelain v2 解析", () => {
  it("解析分支、ahead/behind、修改、重命名、冲突与未跟踪文件", () => {
    const output = [
      "# branch.oid 1234567890abcdef\0",
      "# branch.head main\0",
      "# branch.upstream origin/main\0",
      "# branch.ab +2 -1\0",
      "1 .M N... 100644 100644 100644 a b src/a.ts\0",
      "2 R. N... 100644 100644 100644 a b R100 docs/新 名.md\0docs/旧 名.md\0",
      "u UU N... 100644 100644 100644 100644 a b c src/conflict.ts\0",
      "? assets/图 1.png\0",
    ].join("");

    const status = parseGitStatus(output);
    expect(status.branch).toBe("main");
    expect(status.detached).toBe(false);
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.changes).toHaveLength(4);

    const modified = status.changes.find((change) => change.path === "src/a.ts");
    expect(modified).toMatchObject({ staged: false, unstaged: true, kind: "modified" });

    const renamed = status.changes.find((change) => change.path === "docs/新 名.md");
    expect(renamed).toMatchObject({
      origPath: "docs/旧 名.md",
      staged: true,
      kind: "renamed",
    });

    const conflicted = status.changes.find((change) => change.path === "src/conflict.ts");
    expect(conflicted).toMatchObject({ conflicted: true, kind: "conflicted" });

    const untracked = status.changes.find((change) => change.path === "assets/图 1.png");
    expect(untracked).toMatchObject({ untracked: true, staged: false, kind: "untracked" });
  });

  it("无上游分支时 ahead/behind 为 0", () => {
    const status = parseGitStatus("# branch.head feature\0");
    expect(status).toMatchObject({
      branch: "feature",
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
    });
  });

  it("detached HEAD 不产生分支名", () => {
    const status = parseGitStatus("# branch.head (detached)\0");
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
  });
});

describe("Git 分支与提交解析", () => {
  it("区分本地/远程分支并跳过远程 HEAD", () => {
    const output = [
      "refs/heads/main\tmain\t*\torigin/main",
      "refs/heads/dev\tdev\t\t",
      "refs/remotes/origin/main\torigin/main\t\t",
      "refs/remotes/origin/HEAD\torigin/HEAD\t\t",
    ].join("\n");
    expect(parseGitBranches(output)).toEqual([
      { name: "main", current: true, remote: false, upstream: "origin/main" },
      { name: "dev", current: false, remote: false, upstream: undefined },
      { name: "origin/main", current: false, remote: true, upstream: undefined },
    ]);
  });

  it("解析提交记录并去掉记录前换行", () => {
    const output = [
      "abc123\x1fabc123\x1f修复问题\x1fAlice\x1f2026-01-01T10:00:00+08:00",
      "\x1e\n",
      "def456\x1fdef456\x1f新增功能\x1fBob\x1f2026-01-02T10:00:00+08:00",
      "\x1e",
    ].join("");
    expect(parseGitLog(output)).toEqual([
      {
        hash: "abc123",
        shortHash: "abc123",
        subject: "修复问题",
        author: "Alice",
        date: "2026-01-01T10:00:00+08:00",
      },
      {
        hash: "def456",
        shortHash: "def456",
        subject: "新增功能",
        author: "Bob",
        date: "2026-01-02T10:00:00+08:00",
      },
    ]);
  });

  it("解析完整提交信息（文件历史气泡）", () => {
    const output =
      "abc123\x1fabc123\x1f修复问题\x1fAlice\x1f2026-01-01T10:00:00+08:00\x1f修复问题\n\n补充说明\x1e";
    expect(parseGitLog(output)).toEqual([
      {
        hash: "abc123",
        shortHash: "abc123",
        subject: "修复问题",
        author: "Alice",
        date: "2026-01-01T10:00:00+08:00",
        body: "修复问题\n\n补充说明",
      },
    ]);
  });

  it("解析提交文件列表", () => {
    expect(parseCommitFiles("\nsrc/a.ts\0docs/新.md\0")).toEqual(["src/a.ts", "docs/新.md"]);
  });
});

describe("Git 比较解析", () => {
  it("解析 name-status，含重命名与特殊字符路径", () => {
    const output = [
      "M\0src/a.ts\0",
      "A\0docs/新 文件.md\0",
      "D\0old.txt\0",
      "R100\0old name.txt\0new name.txt\0",
    ].join("");
    expect(parseDiffNameStatus(output)).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "docs/新 文件.md" },
      { status: "D", path: "old.txt" },
      { status: "R", path: "new name.txt", origPath: "old name.txt" },
    ]);
  });

  it("解析 numstat，含重命名与二进制文件", () => {
    const output = [
      "2\t1\tsrc/a.ts\0",
      "-\t-\tassets/logo.png\0",
      "0\t0\t\0old name.txt\0new name.txt\0",
    ].join("");
    const stats = parseDiffNumstat(output);
    expect(stats.get("src/a.ts")).toEqual({ additions: 2, deletions: 1, binary: false });
    expect(stats.get("assets/logo.png")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stats.get("new name.txt")).toEqual({ additions: 0, deletions: 0, binary: false });
  });
});
