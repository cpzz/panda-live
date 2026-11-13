import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  DirEntry,
  FileChange,
  FsChangedEvent,
  WatchResult,
  WorkspaceOpenResult,
} from "../../src/shared/ipc";
import type { FileService } from "./file-service";

/** 工作区树默认忽略项。见 doc/design.md §12.5。 */
const ALWAYS_IGNORED = new Set([".git", "node_modules", "dist", "release"]);

function ignoredEntry(entry: DirEntry): boolean {
  if (entry.kind !== "dir") return false;
  return ALWAYS_IGNORED.has(entry.name) || entry.name.startsWith(".");
}

/**
 * 监听时的忽略规则：目录树不展示的隐藏目录/大目录不再递归监听，
 * 避免对 `.venv` 等目录内的符号链接或无权限文件做 stat 触发 EACCES。
 * `stats` 缺失时按目录处理，优先保证不进入不可访问路径。
 * `roots` 为用户显式监听的路径：其自身（即使以「.」开头）不被忽略。
 */
function ignoredWatchPath(
  target: string,
  stats: { isDirectory(): boolean } | undefined,
  roots: ReadonlySet<string>,
): boolean {
  const resolved = path.resolve(target);
  if (roots.has(resolved)) return false;
  const base = path.basename(resolved);
  if (base.startsWith(".tmp-")) return true;
  // 祖先目录任一为忽略目录则整体忽略：否则隐藏目录（如应用的 .dev-user-data）
  // 内的文件仍会被逐个 watch，Windows 上与 Chromium 写 Preferences*.tmp 撞锁即 EBUSY。
  // 显式监听的根目录所在前缀不计入祖先检查。
  const inRoot = [...roots].find((root) => resolved.startsWith(root + path.sep));
  const relative = inRoot ? resolved.slice(inRoot.length + 1) : resolved;
  const ancestors = relative.split(/[\\/]/).slice(0, -1);
  if (
    ancestors.some((segment) => ALWAYS_IGNORED.has(segment) || (segment.startsWith(".") && segment !== "." && segment !== ".."))
  ) {
    return true;
  }
  const directory = stats ? stats.isDirectory() : true;
  if (!directory) return false;
  return ALWAYS_IGNORED.has(base) || base.startsWith(".");
}

interface WatcherState {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  pending: Map<string, FileChange["type"]>;
  debounceMs: number;
}

/**
 * 工作区目录树与文件监听。
 * 监听使用 chokidar，事件按 300 ms（单文件）/ 500 ms（目录）合并后回传渲染进程。
 * 见 doc/design.md §12.3、§12.5。
 */
export class WorkspaceService {
  private readonly watchers = new Map<string, WatcherState>();

  constructor(
    private readonly files: FileService,
    private readonly emit: (event: FsChangedEvent) => void,
  ) {}

  async open(dirPath: string): Promise<WorkspaceOpenResult> {
    const root = await this.files.registerRoot(dirPath);
    return { root, entries: await this.list(root.path) };
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    return (await this.files.listDir(dirPath)).filter((entry) => !ignoredEntry(entry));
  }

  async watch(paths: string[]): Promise<WatchResult> {
    const resolved = await Promise.all(paths.map((target) => this.files.assertAllowed(target)));
    const watchId = randomUUID();
    let directory = false;
    for (const target of resolved) {
      const stats = await fs.stat(target).catch(() => null);
      if (stats?.isDirectory()) directory = true;
    }

    const roots = new Set(resolved.map((target) => path.resolve(target)));
    const state: WatcherState = {
      watcher: chokidar.watch(resolved, {
        ignoreInitial: true,
        // 用户显式打开的根目录即使以「.」开头也要监听。
        ignored: (target, stats) => ignoredWatchPath(target, stats, roots),
        // 不跟进符号链接：虚拟环境等目录中的链接可能指向无权限目标。
        followSymlinks: false,
      }),
      timer: null,
      pending: new Map(),
      debounceMs: directory ? 500 : 300,
    };

    const record = (type: FileChange["type"]) => (target: string) => {
      if (path.basename(target).startsWith(".tmp-")) return;
      state.pending.set(target, type);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => this.flush(watchId, state), state.debounceMs);
    };

    state.watcher
      .on("add", record("add"))
      .on("addDir", record("add"))
      .on("change", record("change"))
      .on("unlink", record("unlink"))
      .on("unlinkDir", record("unlink"))
      // 单个路径无权限/已消失不应中断整个监听，也不应冒泡为未处理的 Promise 拒绝。
      .on("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return;
        console.warn("[workspace] watch error", error);
      });

    this.watchers.set(watchId, state);
    return { watchId };
  }

  async unwatch(watchId: string): Promise<void> {
    const state = this.watchers.get(watchId);
    if (!state) return;
    this.watchers.delete(watchId);
    if (state.timer) clearTimeout(state.timer);
    await state.watcher.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const ids = [...this.watchers.keys()];
    await Promise.all(ids.map((watchId) => this.unwatch(watchId)));
  }

  private flush(watchId: string, state: WatcherState): void {
    state.timer = null;
    if (state.pending.size === 0) return;
    const changes: FileChange[] = [...state.pending.entries()].map(([target, type]) => ({
      path: target,
      type,
    }));
    state.pending.clear();
    this.emit({ watchId, changes });
  }
}
