import path from "node:path";
import type { GitDiffResult } from "../../src/shared/diff";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCompareResult,
  GitSnapshot,
} from "../../src/shared/git";
import { PandaError } from "../../src/shared/errors";
import { t } from "../../src/i18n";
import type { FileService } from "../services/file-service";
import type { GitService } from "../services/git-service";
import type { SettingsService } from "../services/settings-service";
import { handle } from "./router";

/** 校验仓库相对路径不会逃逸出仓库根，并返回绝对路径。 */
function resolveRepoPath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PandaError("E_PATH_OUTSIDE_ROOT", t("路径不在仓库范围内：{0}", relative));
  }
  return absolute;
}

/** 把 Git 命令失败统一为 `E_GIT_OPERATION`，优先展示 stderr 供用户判断原因。 */
function toOperationError(error: unknown): unknown {
  if (error instanceof PandaError) return error;
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const message = raw
    .replace(/^Command failed:[\s\S]*?\n/u, "")
    .trim();
  return new PandaError("E_GIT_OPERATION", message || t("Git 操作失败"));
}

async function operation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toOperationError(error);
  }
}

/** Git 通道：校验路径后执行仓库操作。见 doc/design.md §21.3。 */
export function registerGitHandlers({
  files,
  git,
  settings,
}: {
  files: FileService;
  git: GitService;
  settings: SettingsService;
}): void {
  const command = (): string => settings.get().git.command;
  const gitSettings = () => settings.get().git;
  /** 网络命令超时（秒 → 毫秒）；由设置控制，默认 120 秒。 */
  const networkTimeout = (): number => gitSettings().networkTimeoutSeconds * 1000;

  const assertRoot = async (root: string): Promise<string> => files.assertAllowed(root);

  const assertPaths = async (root: string, paths: string[]): Promise<void> => {
    for (const relative of paths) {
      await files.assertAllowed(resolveRepoPath(root, relative));
    }
  };

  handle("git:diff", async (request): Promise<GitDiffResult> => {
    const target = await files.assertAllowed(request.path);
    return git.readBaseline(target, request.base, request.ref, command());
  });

  handle("git:snapshot", async (request): Promise<GitSnapshot> => {
    const target = await files.assertAllowed(request.path);
    const snapshot = await git.snapshot(target, command());
    // 单个文件可能位于仓库子目录：把探测到的仓库根登记为允许根，后续操作才能通过校验。
    if (snapshot.root) await files.registerRoot(snapshot.root).catch(() => undefined);
    return snapshot;
  });

  handle("git:stage", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    await assertPaths(root, request.paths);
    return operation(() => git.stage(root, request.paths, command()));
  });

  handle("git:unstage", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    await assertPaths(root, request.paths);
    return operation(() => git.unstage(root, request.paths, command()));
  });

  handle("git:discard", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    await assertPaths(root, request.paths);
    return operation(() => git.discard(root, request.paths, command()));
  });

  handle("git:commit", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() => git.commit(root, request.message, request.amend, command()));
  });

  handle("git:branches", async (request): Promise<GitBranch[]> => {
    const root = await assertRoot(request.root);
    return operation(() => git.branches(root, command()));
  });

  handle("git:checkout", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() => git.checkout(root, request.branch, request.create, command()));
  });

  handle("git:deleteBranch", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() => git.deleteBranch(root, request.branch, command()));
  });

  handle("git:fetch", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() =>
      git.fetch(root, command(), {
        prune: gitSettings().fetchPrune,
        timeoutMs: networkTimeout(),
      }),
    );
  });

  handle("git:pull", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() =>
      git.pull(root, command(), {
        strategy: gitSettings().pullStrategy,
        timeoutMs: networkTimeout(),
      }),
    );
  });

  handle("git:push", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() =>
      git.push(root, request.setUpstream, command(), { timeoutMs: networkTimeout() }),
    );
  });

  handle("git:log", async (request): Promise<GitCommit[]> => {
    const root = await assertRoot(request.root);
    return operation(() => git.log(root, request.limit, request.skip ?? 0, command()));
  });

  handle("git:commitDetail", async (request): Promise<GitCommitDetail> => {
    const root = await assertRoot(request.root);
    return operation(() => git.commitDetail(root, request.hash, command()));
  });

  handle("git:fileLog", async (request): Promise<GitCommit[]> => {
    const target = await files.assertAllowed(request.path);
    return operation(() => git.fileLog(target, request.limit, request.skip ?? 0, command()));
  });

  handle("git:resolveRef", async (request): Promise<string | null> => {
    const target = await files.assertAllowed(request.path);
    return operation(() => git.resolveRef(target, request.ref, command()));
  });

  handle("git:compare", async (request): Promise<GitCompareResult> => {
    const root = await assertRoot(request.root);
    return operation(() => git.compare(root, request.base, request.target, command()));
  });

  handle("git:abort", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() => git.abort(root, command()));
  });

  handle("git:continue", async (request): Promise<GitSnapshot> => {
    const root = await assertRoot(request.root);
    return operation(() => git.continue(root, command()));
  });
}
