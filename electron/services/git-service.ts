import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PandaError } from "../../src/shared/errors";
import { t } from "../../src/i18n";
import type { GitBaselineReason, GitDiffBase, GitDiffResult } from "../../src/shared/diff";
import type { GitPullStrategy } from "../../src/shared/settings";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCompareFile,
  GitCompareResult,
  GitOperation,
  GitSnapshot,
} from "../../src/shared/git";
import {
  parseCommitFiles,
  parseDiffNameStatus,
  parseDiffNumstat,
  parseGitBranches,
  parseGitLog,
  parseGitStatus,
} from "./git-parse";

/** Git 命令统一超时；超时后不阻塞编辑。见 doc/design.md §21.3。 */
const GIT_TIMEOUT_MS = 5_000;
/** 提交可能触发 hooks；网络命令可能有认证/传输等待。 */
const GIT_COMMIT_TIMEOUT_MS = 60_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;
/** 大仓库 status 可能超过普通只读命令的 5s。 */
const GIT_STATUS_TIMEOUT_MS = 15_000;
/** 单次命令输出上限，避免把超大文件读进内存。 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** 允许的提交引用：分支、tag、HEAD~n、短/长 commit id；禁止以 `-` 开头。 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,119}$/;

interface GitOutput {
  stdout: string;
  stderr: string;
}

interface GitCommand {
  /** 可执行文件或命令名，例如 `git`、`C:\Program Files\Git\cmd\git.exe`、`wsl`。 */
  command: string;
  /** 命令前缀参数，例如 `wsl git` 中的 `git`。 */
  args: string[];
  /** 用户填写的原始命令，用于错误提示。 */
  label: string;
}

const commandCache = new Map<string, GitCommand>();

/**
 * 解析用户配置的 Git 命令，支持带引号的路径与命令前缀参数：
 * `git`、`"C:\Program Files\Git\cmd\git.exe"`、`wsl git`、`wsl -d Ubuntu git`。
 */
export function parseGitCommand(line: string | undefined): GitCommand {
  const raw = (line ?? "").trim();
  const cached = commandCache.get(raw);
  if (cached) return cached;

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);

  const command: GitCommand =
    tokens.length === 0
      ? { command: "git", args: [], label: "git" }
      : { command: tokens[0]!, args: tokens.slice(1), label: raw };
  if (commandCache.size > 8) commandCache.clear();
  commandCache.set(raw, command);
  return command;
}

interface RunOptions {
  timeout?: number;
  /** 写入 git 的标准输入（提交消息等）。 */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** 执行 Git 命令；固定参数、`shell: false`，失败时抛出携带错误码的异常。 */
function runGit(
  args: string[],
  cwd: string,
  git: GitCommand,
  options: RunOptions = {},
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      git.command,
      [...git.args, ...args],
      {
        cwd,
        timeout: options.timeout ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        shell: false,
        encoding: "utf8",
        env: {
          ...process.env,
          // 认证依赖系统 Git Credential Manager / SSH Agent；禁止终端交互挂起。
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GIT_PAGER: "cat",
          LC_ALL: "C",
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const details = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string;
        };
        if (details.code === "ENOENT") {
          reject(
            new PandaError(
              "E_GIT_MISSING",
              t(
                "未找到 Git 命令「{0}」：请在设置 → Git 指定 Git 路径，或填写 wsl git",
                git.label,
              ),
            ),
          );
          return;
        }
        if (details.killed || details.code === "ETIMEDOUT") {
          reject(new PandaError("E_GIT_TIMEOUT", t("Git 命令超时，请稍后重试")));
          return;
        }
        if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new PandaError("E_GIT_TOO_LARGE", t("Git 输出超过大小上限")));
          return;
        }
        // 其余错误交给调用方判断（例如路径不在基线中）。
        reject(Object.assign(error, { stderr }));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  const parts = [stderr, (error as Error | undefined)?.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  return parts.toLowerCase();
}

/** 非仓库结果只缓存一段时间，`git init` 后无需重启即可恢复。 */
const NEGATIVE_CACHE_MS = 5_000;

/**
 * 读取 Git 基线文本。只负责取旧文本，当前文本由渲染进程提供。
 * Git 命令可由设置覆盖（如 `wsl git`）；路径解析以文件所在目录为工作目录，
 * 避免 WSL 返回的 `/mnt/...` 路径与 Windows 路径混用。见 doc/design.md §21.3。
 */
export class GitService {
  private readonly repoRoots = new Map<string, { root: string | null; at: number }>();

  /** 读取仓库状态快照；`targetPath` 可以是文件或目录。 */
  async snapshot(targetPath: string, commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const absolute = path.resolve(targetPath);
    let directory = absolute;
    try {
      if ((await fs.stat(absolute)).isFile()) directory = path.dirname(absolute);
    } catch {
      directory = path.dirname(absolute);
    }
    const root = await this.resolveRepoRoot(directory, command);
    if (!root) {
      return {
        inRepo: false,
        root: null,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
        changes: [],
      };
    }
    const [status, gitDir] = await Promise.all([
      runGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], root, command, {
        timeout: GIT_STATUS_TIMEOUT_MS,
      }),
      runGit(["rev-parse", "--absolute-git-dir"], root, command),
    ]);
    return {
      inRepo: true,
      root,
      ...parseGitStatus(status.stdout),
      operation: await detectOperation(gitDir.stdout.trim()),
    };
  }

  /** 暂存指定文件；路径为仓库根下的相对路径。 */
  async stage(root: string, paths: string[], commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    await runGit(["--literal-pathspecs", "add", "--", ...paths], root, command);
    return this.snapshot(root, commandLine);
  }

  /** 取消暂存；空仓库没有 HEAD 时回退到 rm --cached。 */
  async unstage(root: string, paths: string[], commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    try {
      await runGit(["restore", "--staged", "--", ...paths], root, command);
    } catch (error) {
      if (error instanceof PandaError) throw error;
      const text = errorText(error);
      if (!text.includes("head") && !text.includes("ambiguous")) throw error;
      await runGit(["rm", "-r", "--cached", "--quiet", "--", ...paths], root, command);
    }
    return this.snapshot(root, commandLine);
  }

  /**
   * 放弃已跟踪文件的修改（同时恢复暂存区与工作区）。
   * 重命名会同时传入旧路径与新路径；新路径在 HEAD 中不存在时无法 restore，
   * 需要从索引移除并删除工作区文件，避免整条命令失败。
   */
  async discard(root: string, paths: string[], commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const restorable: string[] = [];
    const absent: string[] = [];
    for (const relative of paths) {
      try {
        await runGit(["cat-file", "-e", `HEAD:./${relative}`], root, command);
        restorable.push(relative);
      } catch (error) {
        if (error instanceof PandaError) throw error;
        absent.push(relative);
      }
    }
    if (restorable.length > 0) {
      await runGit(
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restorable],
        root,
        command,
      );
    }
    for (const relative of absent) {
      const absolute = path.resolve(root, relative);
      const rel = path.relative(root, absolute);
      // IPC 已校验路径；这里再做一次防御，避免删除仓库外的文件。
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      await runGit(
        ["rm", "-r", "-f", "--cached", "--quiet", "--ignore-unmatch", "--", relative],
        root,
        command,
      );
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.snapshot(root, commandLine);
  }

  async commit(
    root: string,
    message: string,
    amend: boolean,
    commandLine?: string,
  ): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    await runGit(
      ["commit", "--file", "-", ...(amend ? ["--amend"] : [])],
      root,
      command,
      { input: message, timeout: GIT_COMMIT_TIMEOUT_MS },
    );
    return this.snapshot(root, commandLine);
  }

  async branches(root: string, commandLine?: string): Promise<GitBranch[]> {
    const command = parseGitCommand(commandLine);
    const output = await runGit(
      [
        "for-each-ref",
        "--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)",
        "refs/heads",
        "refs/remotes",
      ],
      root,
      command,
    );
    return parseGitBranches(output.stdout);
  }

  async checkout(
    root: string,
    branch: string,
    create: boolean,
    commandLine?: string,
  ): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    await runGit(["check-ref-format", "--branch", branch], root, command);
    await runGit(
      create ? ["switch", "-c", branch] : ["switch", branch],
      root,
      command,
    );
    return this.snapshot(root, commandLine);
  }

  async deleteBranch(root: string, branch: string, commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    await runGit(["check-ref-format", "--branch", branch], root, command);
    await runGit(["branch", "-d", branch], root, command);
    return this.snapshot(root, commandLine);
  }

  /** 网络操作选项：获取是否 prune、超时毫秒数，均由设置传入。 */
  async fetch(
    root: string,
    commandLine?: string,
    options: { prune?: boolean; timeoutMs?: number } = {},
  ): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    // 显式传 --no-prune，保证应用设置优先于用户 Git 配置中的 fetch.prune。
    const args = options.prune === false ? ["fetch", "--no-prune"] : ["fetch", "--prune"];
    await runGit(args, root, command, {
      timeout: options.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS,
    });
    return this.snapshot(root, commandLine);
  }

  /** `config` 遵循用户 Git 配置；其余策略追加明确参数覆盖。 */
  async pull(
    root: string,
    commandLine?: string,
    options: { strategy?: GitPullStrategy; timeoutMs?: number } = {},
  ): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const strategyArgs =
      options.strategy === "merge"
        ? ["--no-rebase"]
        : options.strategy === "rebase"
          ? ["--rebase"]
          : options.strategy === "ff-only"
            ? ["--ff-only"]
            : [];
    await runGit(["pull", ...strategyArgs], root, command, {
      timeout: options.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS,
    });
    return this.snapshot(root, commandLine);
  }

  async push(
    root: string,
    setUpstream: boolean,
    commandLine?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const timeout = options.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
    if (setUpstream) {
      const current = await this.snapshot(root, commandLine);
      if (current.detached || !current.branch) {
        throw new PandaError("E_GIT_OPERATION", t("detached HEAD 无法设置上游分支"));
      }
      const remotes = (await runGit(["remote"], root, command)).stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean);
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      if (!remote) throw new PandaError("E_GIT_OPERATION", t("仓库没有配置远程地址"));
      await runGit(["push", "-u", remote, current.branch], root, command, {
        timeout,
      });
    } else {
      await runGit(["push"], root, command, { timeout });
    }
    return this.snapshot(root, commandLine);
  }

  async log(
    root: string,
    limit: number,
    skip = 0,
    commandLine?: string,
  ): Promise<GitCommit[]> {
    const command = parseGitCommand(commandLine);
    const count = Math.min(200, Math.max(1, Math.floor(limit)));
    const offset = Math.max(0, Math.floor(skip));
    const output = await runGit(
      [
        "log",
        "-n",
        String(count),
        "--skip",
        String(offset),
        "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e",
      ],
      root,
      command,
    );
    return parseGitLog(output.stdout);
  }

  /** 把相对文件路径对应的仓库中的引用解析成完整 commit hash；失败返回 null。 */
  async resolveRef(filePath: string, ref: string, commandLine?: string): Promise<string | null> {
    const command = parseGitCommand(commandLine);
    const requested = (ref ?? "").trim();
    if (!REF_PATTERN.test(requested)) return null;
    const absolute = path.resolve(filePath);
    const root = await this.resolveRepoRoot(path.dirname(absolute), command);
    if (!root) return null;
    return this.resolveCommit(requested, root, command);
  }

  /** 当前文件的提交历史（跟随重命名，包含合并提交）；供对比基线选择分页使用。 */
  async fileLog(
    filePath: string,
    limit: number,
    skip = 0,
    commandLine?: string,
  ): Promise<GitCommit[]> {
    const command = parseGitCommand(commandLine);
    const absolute = path.resolve(filePath);
    const directory = path.dirname(absolute);
    const root = await this.resolveRepoRoot(directory, command);
    if (!root) {
      throw new PandaError(
        "E_GIT_OPERATION",
        t("未检测到 Git 仓库，请检查设置 → Git 中的 Git 命令"),
      );
    }
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PandaError("E_GIT_OPERATION", t("路径不在仓库范围内：{0}", filePath));
    }
    const count = Math.min(200, Math.max(1, Math.floor(limit)));
    const offset = Math.max(0, Math.floor(skip));
    // Git 的 --follow 会重写历史，`--skip` 与之组合时会失效；先多取再切片。
    const fetchCount = Math.min(1000, count + offset);
    try {
      const output = await runGit(
        [
          "log",
          "--follow",
          "--full-history",
          "-n",
          String(fetchCount),
          "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%B%x1e",
          "--",
          relative.split(path.sep).join("/"),
        ],
        root,
        command,
        { timeout: GIT_STATUS_TIMEOUT_MS },
      );
      return parseGitLog(output.stdout).slice(offset, offset + count);
    } catch (error) {
      if (error instanceof PandaError) throw error;
      const text = errorText(error);
      // 空仓库（还没有 HEAD）或路径从未被跟踪时没有历史，按空列表返回。
      if (text.includes("does not have any commits") || text.includes("unknown revision")) {
        return [];
      }
      throw error;
    }
  }

  /**
   * 仓库级比较：base 必填；target 为空表示工作区。
   * 返回变更文件、状态与增删统计，供侧栏「比较」视图使用。
   */
  async compare(
    root: string,
    base: string,
    target?: string,
    commandLine?: string,
  ): Promise<GitCompareResult> {
    const command = parseGitCommand(commandLine);
    const baseRef = (base ?? "").trim();
    const targetRef = (target ?? "").trim();
    if (!REF_PATTERN.test(baseRef)) {
      throw new PandaError("E_GIT_OPERATION", t("提交引用不合法：{0}", baseRef));
    }
    if (targetRef && !REF_PATTERN.test(targetRef)) {
      throw new PandaError("E_GIT_OPERATION", t("提交引用不合法：{0}", targetRef));
    }
    const baseHash = await this.resolveCommit(baseRef, root, command);
    if (!baseHash) {
      throw new PandaError("E_GIT_OPERATION", t("无法解析提交「{0}」", baseRef));
    }
    const targetHash = targetRef ? await this.resolveCommit(targetRef, root, command) : null;
    if (targetRef && !targetHash) {
      throw new PandaError("E_GIT_OPERATION", t("无法解析提交「{0}」", targetRef));
    }

    const range = targetHash ? [baseHash, targetHash] : [baseHash];
    const [names, stats] = await Promise.all([
      runGit(["diff", "--name-status", "-z", "--find-renames", ...range], root, command, {
        timeout: GIT_STATUS_TIMEOUT_MS,
      }),
      runGit(["diff", "--numstat", "-z", "--find-renames", ...range], root, command, {
        timeout: GIT_STATUS_TIMEOUT_MS,
      }),
    ]);
    const statMap = parseDiffNumstat(stats.stdout);
    const files: GitCompareFile[] = parseDiffNameStatus(names.stdout).map((file) => {
      const stat = statMap.get(file.path);
      return {
        ...file,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
      };
    });

    // `git diff` 不含未跟踪文件；目标为工作区时补上，保证「当前 ⇄ commit」完整。
    if (!targetHash) {
      const untracked = await runGit(
        ["ls-files", "--others", "--exclude-standard", "-z"],
        root,
        command,
        { timeout: GIT_STATUS_TIMEOUT_MS },
      ).catch(() => null);
      for (const item of (untracked?.stdout ?? "").split("\0")) {
        if (!item) continue;
        if (files.some((file) => file.path === item)) continue;
        files.push({
          path: item,
          status: "A",
          additions: 0,
          deletions: 0,
          binary: false,
          untracked: true,
        });
      }
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
      baseLabel: baseRef,
      targetLabel: targetRef || null,
      baseHash,
      targetHash,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  async commitDetail(root: string, hash: string, commandLine?: string): Promise<GitCommitDetail> {
    const command = parseGitCommand(commandLine);
    // 拒绝以 `-` 开头的参数式“哈希”，避免把用户输入当成 git show 选项。
    if (!REF_PATTERN.test(hash)) {
      throw new PandaError("E_GIT_OPERATION", t("提交引用不合法：{0}", hash));
    }
    const meta = await runGit(
      ["show", "-s", "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%b", hash],
      root,
      command,
    );
    const [fullHash, shortHash, subject, author, date, body] = meta.stdout.split("\x1f");
    const files = await runGit(
      // 合并提交默认不输出文件列表：--first-parent 按第一父提交比较，
      // 与 `git diff HEAD~1 --name-only` 一致；--root 保证首个提交也能列出文件。
      ["show", "--first-parent", "--root", "--name-only", "-z", "--format=", hash],
      root,
      command,
    );
    return {
      hash: fullHash ?? hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      body: body ?? "",
      files: parseCommitFiles(files.stdout),
    };
  }

  /** 中止当前 merge/rebase/cherry-pick。 */
  async abort(root: string, commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const current = await this.snapshot(root, commandLine);
    const args =
      current.operation === "merge"
        ? ["merge", "--abort"]
        : current.operation === "rebase"
          ? ["rebase", "--abort"]
          : current.operation === "cherry-pick"
            ? ["cherry-pick", "--abort"]
            : null;
    if (!args) throw new PandaError("E_GIT_OPERATION", t("当前没有可中止的 Git 操作"));
    await runGit(args, root, command, { timeout: GIT_COMMIT_TIMEOUT_MS });
    return this.snapshot(root, commandLine);
  }

  /** 继续当前 merge/rebase/cherry-pick；冲突需先标记为已解决。 */
  async continue(root: string, commandLine?: string): Promise<GitSnapshot> {
    const command = parseGitCommand(commandLine);
    const current = await this.snapshot(root, commandLine);
    const args =
      current.operation === "merge"
        ? ["merge", "--continue"]
        : current.operation === "rebase"
          ? ["rebase", "--continue"]
          : current.operation === "cherry-pick"
            ? ["cherry-pick", "--continue"]
            : null;
    if (!args) throw new PandaError("E_GIT_OPERATION", t("当前没有可继续的 Git 操作"));
    await runGit(args, root, command, { timeout: GIT_COMMIT_TIMEOUT_MS });
    return this.snapshot(root, commandLine);
  }

  async readBaseline(
    filePath: string,
    base: GitDiffBase,
    ref?: string,
    commandLine?: string,
  ): Promise<GitDiffResult> {
    const requested = (ref ?? "").trim();
    const command = parseGitCommand(commandLine);
    const baseLabel =
      base === "head" ? "HEAD" : base === "index" ? t("暂存区") : displayRef(requested);
    const absolute = path.resolve(filePath);
    const directory = path.dirname(absolute);
    const repoRoot = await this.resolveRepoRoot(directory, command);
    if (!repoRoot) {
      return { inRepo: false, baseLabel, repoRoot: null, oldText: null, reason: "blob-missing" };
    }

    let commit = "HEAD";
    if (base === "commit") {
      if (!REF_PATTERN.test(requested)) {
        return { inRepo: true, baseLabel, repoRoot, oldText: null, reason: "invalid-ref" };
      }
      const resolved = await this.resolveCommit(requested, directory, command);
      if (!resolved) {
        return { inRepo: true, baseLabel, repoRoot, oldText: null, reason: "invalid-ref" };
      }
      commit = resolved;
    }

    const fileName = path.basename(absolute);
    const spec = base === "index" ? `:./${fileName}` : `${commit}:./${fileName}`;

    let content: string;
    try {
      const output = await runGit(["cat-file", "blob", spec], directory, command);
      content = output.stdout;
    } catch (error) {
      if (error instanceof PandaError) throw error;
      const text = errorText(error);
      if (text.includes("too large") || text.includes("maxbuffer")) {
        throw new PandaError("E_GIT_TOO_LARGE", t("Git 基线文本超过大小上限"));
      }
      let reason: GitBaselineReason;
      if (
        base === "head" &&
        (text.includes("invalid object name") || text.includes("not a valid object name"))
      ) {
        // 空仓库还没有 HEAD；Git 新版输出 invalid object name，旧版为 not a valid object name。
        reason = "no-head";
      } else {
        // 区分「文件根本没被 Git 跟踪」与「该提交/路径下没有文件」。
        const tracked = await this.isTracked(fileName, directory, command);
        reason = tracked ? "blob-missing" : "untracked";
      }
      return { inRepo: true, baseLabel, repoRoot, oldText: null, reason };
    }

    if (content.startsWith(LFS_POINTER_PREFIX)) {
      return { inRepo: true, baseLabel, repoRoot, oldText: content, reason: "lfs" };
    }
    return {
      inRepo: true,
      baseLabel,
      repoRoot,
      oldText: stripBom(content),
    };
  }

  /** 把 `HEAD~3`、分支名或 commit id 解析成完整 commit hash。 */
  private async resolveCommit(
    ref: string,
    directory: string,
    command: GitCommand,
  ): Promise<string | null> {
    try {
      const output = await runGit(
        ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        directory,
        command,
      );
      return output.stdout.trim() || null;
    } catch (error) {
      if (error instanceof PandaError) throw error;
      return null;
    }
  }

  /** 文件是否已被 Git 跟踪（存在于 index）。仅用于缺失基线的诊断。 */
  private async isTracked(
    fileName: string,
    directory: string,
    command: GitCommand,
  ): Promise<boolean> {
    try {
      await runGit(["ls-files", "--error-unmatch", "--", `./${fileName}`], directory, command);
      return true;
    } catch (error) {
      if (error instanceof PandaError) throw error;
      return false;
    }
  }

  /** 找到最近的仓库根；非仓库返回 null，Git 不可用或超时抛出错误。 */
  private async resolveRepoRoot(directory: string, command: GitCommand): Promise<string | null> {
    const key = `${command.label}\0${directory}`;
    const cached = this.repoRoots.get(key);
    if (cached !== undefined) {
      if (cached.root !== null || Date.now() - cached.at < NEGATIVE_CACHE_MS) return cached.root;
    }

    let root: string | null;
    try {
      const output = await runGit(["rev-parse", "--show-toplevel"], directory, command);
      // Git 在 Windows 上返回正斜杠路径；统一成本地分隔符，便于与工作区树/已打开文档路径比较。
      root = output.stdout.trim() ? path.normalize(output.stdout.trim()) : null;
    } catch (error) {
      if (error instanceof PandaError) throw error;
      root = null;
    }
    this.repoRoots.set(key, { root, at: Date.now() });
    return root;
  }
}

/** commit id 只显示前 7 位，其余引用保持原样。 */
function displayRef(ref: string): string {
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

/** 通过 git-dir 下的状态文件判断当前是否有未完成操作。 */
async function detectOperation(gitDir: string): Promise<GitOperation> {
  if (!gitDir) return null;
  const candidates: Array<[string, Exclude<GitOperation, null>]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
  ];
  for (const [file, operation] of candidates) {
    try {
      await fs.access(path.join(gitDir, file));
      return operation;
    } catch {
      // 继续检查下一个标记文件。
    }
  }
  return null;
}
