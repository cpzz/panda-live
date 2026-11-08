import { describeError } from "../shared/errors";
import type { DirEntry, FileRef, FsChangedEvent } from "../shared/ipc";

export interface WorkspaceNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  expanded: boolean;
  children: WorkspaceNode[] | null;
}

export interface WorkspaceState {
  root: FileRef | null;
  nodes: WorkspaceNode[];
  visible: boolean;
  watchId: string | null;
  error: string | null;
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, "")}/${name}`;
}

function toNodes(entries: DirEntry[]): WorkspaceNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    expanded: false,
    children: null,
  }));
}

/**
 * 工作区树：懒加载目录、监听刷新与文件操作。
 * 目录变化由主进程合并后经 `fs:changed` 到达，这里再做一次 200 ms 合并。见 doc/design.md §12.5。
 */
export class WorkspaceStore {
  private state: WorkspaceState = {
    root: null,
    nodes: [],
    visible: true,
    watchId: null,
    error: null,
  };
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private expandedSnapshot: string[] = [];

  readonly getState = (): WorkspaceState => this.state;

  readonly subscribe = (listener: (state: WorkspaceState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get rootPath(): string | null {
    return this.state.root?.path ?? null;
  }

  /** 由会话恢复的展开节点列表。 */
  collectExpanded(): string[] {
    const paths: string[] = [];
    const walk = (nodes: WorkspaceNode[]): void => {
      for (const node of nodes) {
        if (node.kind !== "dir" || !node.expanded) continue;
        paths.push(node.path);
        if (node.children) walk(node.children);
      }
    };
    walk(this.state.nodes);
    return paths;
  }

  async openPicker(): Promise<void> {
    try {
      const ref = await window.panda.dialog.openDirectory();
      if (!ref) return;
      await this.openPath(ref.path, []);
    } catch (error) {
      this.commit({ error: describeError(error) });
    }
  }

  async openPath(rootPath: string, expandedPaths: string[] = []): Promise<void> {
    try {
      if (this.state.watchId) {
        const watchId = this.state.watchId;
        this.commit({ watchId: null });
        await window.panda.fs.unwatch({ watchId }).catch(() => undefined);
      }
      const result = await window.panda.workspace.open({ path: rootPath });
      const nodes = toNodes(result.entries);
      await this.applyExpanded(nodes, new Set(expandedPaths));
      const { watchId } = await window.panda.fs.watch({ paths: [result.root.path] });
      this.commit({ root: result.root, nodes, watchId, visible: true, error: null });
    } catch (error) {
      this.commit({ error: describeError(error) });
    }
  }

  async close(): Promise<void> {
    const watchId = this.state.watchId;
    this.commit({ root: null, nodes: [], watchId: null, error: null });
    if (watchId) await window.panda.fs.unwatch({ watchId }).catch(() => undefined);
  }

  setVisible(visible: boolean): void {
    this.commit({ visible });
  }

  async toggle(nodePath: string): Promise<void> {
    const node = this.findNode(nodePath);
    if (!node || node.kind !== "dir") return;
    if (node.expanded) {
      node.expanded = false;
      this.commit({ nodes: [...this.state.nodes] });
      return;
    }
    node.expanded = true;
    if (!node.children) {
      try {
        node.children = await this.loadChildren(node.path);
      } catch (error) {
        node.expanded = false;
        this.commit({ nodes: [...this.state.nodes], error: describeError(error) });
        return;
      }
    }
    this.commit({ nodes: [...this.state.nodes] });
  }

  async refresh(): Promise<void> {
    if (!this.state.root) return;
    this.refreshTimer = null;
    try {
      const expandedSnapshot = this.state.root.path ? this.collectExpanded() : [];
      this.expandedSnapshot = expandedSnapshot;
      this.commit({ nodes: await this.refreshDir(this.state.root.path, this.state.nodes) });
    } catch (error) {
      this.commit({ error: describeError(error) });
    }
  }

  async createNode(parentPath: string, kind: "file" | "dir", name: string): Promise<FileRef | null> {
    try {
      const ref = await window.panda.fs.create({ path: joinPath(parentPath, name), kind });
      await this.refresh();
      return ref;
    } catch (error) {
      this.commit({ error: describeError(error) });
      return null;
    }
  }

  async renameNode(nodePath: string, newName: string): Promise<FileRef | null> {
    try {
      const ref = await window.panda.fs.rename({ path: nodePath, newName });
      await this.refresh();
      return ref;
    } catch (error) {
      this.commit({ error: describeError(error) });
      return null;
    }
  }

  async deleteNode(nodePath: string, recursive: boolean): Promise<boolean> {
    try {
      await window.panda.fs.remove({ path: nodePath, recursive });
      await this.refresh();
      return true;
    } catch (error) {
      this.commit({ error: describeError(error) });
      return false;
    }
  }

  async reveal(nodePath: string): Promise<void> {
    await window.panda.shell.reveal(nodePath).catch(() => undefined);
  }

  /** 主进程推送的目录变化：仅处理当前工作区，并按 200 ms 合并刷新。 */
  handleFsChanged(event: FsChangedEvent): void {
    if (!this.state.root || event.watchId !== this.state.watchId) return;
    if (!event.changes.some((change) => change.path.startsWith(this.state.root?.path ?? ""))) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, 200);
  }

  private async applyExpanded(nodes: WorkspaceNode[], expanded: Set<string>): Promise<void> {
    for (const node of nodes) {
      if (node.kind !== "dir" || !expanded.has(node.path)) continue;
      node.expanded = true;
      node.children = await this.loadChildren(node.path);
      await this.applyExpanded(node.children, expanded);
    }
  }

  private async refreshDir(dirPath: string, previous: WorkspaceNode[]): Promise<WorkspaceNode[]> {
    const { entries } = await window.panda.fs.readDir({ path: dirPath });
    const before = new Map(previous.map((node) => [node.path, node]));
    const nodes = toNodes(entries);
    for (const node of nodes) {
      const old = before.get(node.path);
      if (node.kind !== "dir") continue;
      const expanded = old?.expanded ?? this.expandedSnapshot.includes(node.path);
      node.expanded = expanded;
      if (expanded && old?.children) {
        node.children = await this.refreshDir(node.path, old.children);
      } else if (expanded) {
        node.children = await this.loadChildren(node.path);
      }
    }
    return nodes;
  }

  private async loadChildren(dirPath: string): Promise<WorkspaceNode[]> {
    const { entries } = await window.panda.fs.readDir({ path: dirPath });
    return toNodes(entries);
  }

  private findNode(nodePath: string): WorkspaceNode | null {
    let found: WorkspaceNode | null = null;
    const walk = (nodes: WorkspaceNode[]): void => {
      for (const node of nodes) {
        if (found) return;
        if (node.path === nodePath) {
          found = node;
          return;
        }
        if (node.children) walk(node.children);
      }
    };
    walk(this.state.nodes);
    return found;
  }

  private commit(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
