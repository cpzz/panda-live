import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitService, parseGitCommand } from "../../electron/services/git-service";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Windows 上 Git 对象只读/句柄未释放会让 rmSync 抛 EPERM；重试并容忍最终失败。 */
function rmTempRepo(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // 清理失败不影响测试结论；临时目录由系统回收。
  }
}

/** 开发机或 CI 未安装 Git 时跳过；其余情况下该用例覆盖真实仓库行为。 */
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Windows 且安装了 WSL Git 时，额外验证真实基线读取与未跟踪诊断。 */
const hasWslGit = (() => {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("wsl", ["git", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasWslGit)("WSL Git 基线诊断", () => {
  it("已跟踪文件返回内容，未跟踪文件标记为 untracked", async () => {
    const service = new GitService();
    const root = process.cwd();
    const tracked = await service.readBaseline(
      path.join(root, "package.json"),
      "commit",
      "HEAD",
      "wsl git",
    );
    expect(tracked.inRepo).toBe(true);
    expect(tracked.oldText).toContain('"name"');

    const missing = await service.readBaseline(
      path.join(root, "__panda_untracked__.md"),
      "commit",
      "HEAD",
      "wsl git",
    );
    expect(missing.reason).toBe("untracked");
  }, 20_000);
});

describe("自定义 Git 命令", () => {
  it("解析命令、WSL 前缀参数与带引号的路径", () => {
    expect(parseGitCommand("")).toMatchObject({ command: "git", args: [] });
    expect(parseGitCommand("git")).toMatchObject({ command: "git", args: [] });
    expect(parseGitCommand("wsl git")).toMatchObject({ command: "wsl", args: ["git"] });
    expect(parseGitCommand("wsl -d Ubuntu git")).toMatchObject({
      command: "wsl",
      args: ["-d", "Ubuntu", "git"],
    });
    expect(parseGitCommand('"C:\\Program Files\\Git\\cmd\\git.exe"')).toMatchObject({
      command: "C:\\Program Files\\Git\\cmd\\git.exe",
      args: [],
    });
  });

  it("命令不存在时返回 E_GIT_MISSING 并提示配置路径", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "panda-git-missing-"));
    const target = path.join(dir, "a.md");
    writeFileSync(target, "x\n", "utf8");
    try {
      await expect(
        new GitService().readBaseline(target, "head", undefined, "panda-not-a-real-git"),
      ).rejects.toMatchObject({ code: "E_GIT_MISSING" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 初始化临时仓库并写入可复用的提交身份，避免依赖全局 Git 配置。 */
function initRepo(dir: string): void {
  git(dir, "init");
  git(dir, "config", "user.email", "test@panda.local");
  git(dir, "config", "user.name", "Panda Test");
}

describe.skipIf(!hasGit)("Git 基线缺失原因", () => {
  it("已暂存的新增文件在 HEAD 中没有基线（blob-missing）", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "panda-git-added-"));
    try {
      initRepo(repo);
      writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
      git(repo, "add", "base.txt");
      git(repo, "commit", "-m", "init");

      const added = path.join(repo, "c.txt");
      writeFileSync(added, "this is a test 4\n", "utf8");
      git(repo, "add", "c.txt");

      const result = await new GitService().readBaseline(added, "head");
      expect(result.inRepo).toBe(true);
      expect(result.oldText).toBeNull();
      // 文件已进入索引，Git 只能判定「该提交中没有这个路径」，
      // 因此 reason 是 blob-missing，而不是 untracked。
      expect(result.reason).toBe("blob-missing");
    } finally {
      rmTempRepo(repo);
    }
  });

  it("提交新增文件后同一路径可读取 HEAD 基线", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "panda-git-added-"));
    try {
      initRepo(repo);
      writeFileSync(path.join(repo, "base.txt"), "base\n", "utf8");
      git(repo, "add", "base.txt");
      git(repo, "commit", "-m", "init");

      const added = path.join(repo, "c.txt");
      writeFileSync(added, "this is a test 4\n", "utf8");
      git(repo, "add", "c.txt");
      git(repo, "commit", "-m", "add c");

      const result = await new GitService().readBaseline(added, "head");
      expect(result.oldText).toContain("this is a test 4");
      expect(result.reason).toBeUndefined();
    } finally {
      rmTempRepo(repo);
    }
  });

  it("没有 HEAD 的空仓库返回 no-head 而不是 blob-missing", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "panda-git-empty-"));
    try {
      initRepo(repo);
      const target = path.join(repo, "a.txt");
      writeFileSync(target, "x\n", "utf8");
      git(repo, "add", "a.txt");

      const result = await new GitService().readBaseline(target, "head");
      expect(result.oldText).toBeNull();
      expect(result.reason).toBe("no-head");
    } finally {
      rmTempRepo(repo);
    }
  });
});

describe.skipIf(!hasGit)("Git 基线读取", () => {
  let repo: string;
  let file: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "panda-git-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@panda.local");
    git(repo, "config", "user.name", "Panda Test");
    file = path.join(repo, "doc.md");
    writeFileSync(file, "# 标题\n\n正文\n", "utf8");
    git(repo, "add", "doc.md");
    git(repo, "commit", "-m", "init");
  });

  afterAll(() => {
    rmTempRepo(repo);
  });

  it("读取 HEAD 基线而不是工作区内容", async () => {
    writeFileSync(file, "# 标题\n\n正文修改\n", "utf8");
    const result = await new GitService().readBaseline(file, "head");
    expect(result.inRepo).toBe(true);
    expect(result.baseLabel).toBe("HEAD");
    expect(result.oldText).toContain("正文");
    expect(result.oldText).not.toContain("正文修改");
  });

  it("未跟踪文件返回空基线", async () => {
    const other = path.join(repo, "new.md");
    writeFileSync(other, "new\n", "utf8");
    const result = await new GitService().readBaseline(other, "head");
    expect(result.inRepo).toBe(true);
    expect(result.oldText).toBeNull();
    expect(result.reason).toBe("untracked");
  }, 30_000);

  it("支持 HEAD~1 与 commit id 作为基线", async () => {
    const custom = mkdtempSync(path.join(tmpdir(), "panda-git-ref-"));
    const target = path.join(custom, "doc.md");
    try {
      git(custom, "init");
      git(custom, "config", "user.email", "test@panda.local");
      git(custom, "config", "user.name", "Panda Test");
      writeFileSync(target, "# v1\n", "utf8");
      git(custom, "add", "doc.md");
      git(custom, "commit", "-m", "v1");
      const first = git(custom, "rev-parse", "HEAD").trim();
      writeFileSync(target, "# v2\n", "utf8");
      git(custom, "add", "doc.md");
      git(custom, "commit", "-m", "v2");

      const relative = await new GitService().readBaseline(target, "commit", "HEAD~1");
      expect(relative.inRepo).toBe(true);
      expect(relative.oldText).toContain("# v1");
      expect(relative.oldText).not.toContain("# v2");

      const byId = await new GitService().readBaseline(target, "commit", first);
      expect(byId.oldText).toContain("# v1");

      const invalid = await new GitService().readBaseline(target, "commit", "no-such-ref");
      expect(invalid.reason).toBe("invalid-ref");
      expect(invalid.oldText).toBeNull();
    } finally {
      rmTempRepo(custom);
    }
  }, 30_000);

  it("非仓库返回 inRepo=false", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "panda-nogit-"));
    try {
      const target = path.join(outside, "a.md");
      writeFileSync(target, "x\n", "utf8");
      const result = await new GitService().readBaseline(target, "head");
      expect(result.inRepo).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
