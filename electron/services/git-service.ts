import { execFile } from "node:child_process";
import path from "node:path";
import { PandaError } from "../../src/shared/errors";
import { t } from "../../src/i18n";
import type { GitBaselineReason, GitDiffBase, GitDiffResult } from "../../src/shared/diff";

/** Git 命令统一超时；超时后不阻塞编辑。见 doc/design.md §21.3。 */
const GIT_TIMEOUT_MS = 5_000;
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

/** 执行只读 Git 命令；固定参数、`shell: false`，失败时抛出携带错误码的异常。 */
function runGit(args: string[], cwd: string, git: GitCommand): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      git.command,
      [...git.args, ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        shell: false,
        encoding: "utf8",
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
                "未找到 Git 命令「{0}」：请在设置 → 改动对比 指定 Git 路径，或填写 wsl git",
                git.label,
              ),
            ),
          );
          return;
        }
        if (details.killed || details.code === "ETIMEDOUT") {
          reject(new PandaError("E_GIT_TIMEOUT", t("Git 命令超时（5 s）")));
          return;
        }
        if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new PandaError("E_GIT_TOO_LARGE", t("Git 基线文本超过大小上限")));
          return;
        }
        // 其余错误交给调用方判断（例如路径不在基线中）。
        reject(Object.assign(error, { stderr }));
      },
    );
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
      if (text.includes("not a valid object name")) {
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
      root = output.stdout.trim() || null;
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
