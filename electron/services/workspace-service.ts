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

    const state: WatcherState = {
      watcher: chokidar.watch(resolved, {
        ignoreInitial: true,
        // 忽略原子写入使用的中转文件，避免自动保存触发自身监听。
        ignored: (target) => path.basename(target).startsWith(".tmp-"),
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
      .on("unlinkDir", record("unlink"));

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
