import { describeError } from "../shared/errors";
import type { DirEntry, FileRef, FsChangedEvent } from "../shared/ipc";
import { pathKey } from "../utils/paths";

export interface WorkspaceNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  expanded: boolean;
  children: WorkspaceNode[] | null;
}

/** 一个已打开的工作区根目录及其懒加载树。 */
export interface WorkspaceRootState {
  root: FileRef;
  nodes: WorkspaceNode[];
  watchId: string | null;
}

export interface WorkspaceState {
  roots: WorkspaceRootState[];
  visible: boolean;
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
 * 工作区树：支持同时打开多个根目录，懒加载目录、监听刷新与文件操作。
 * 目录变化由主进程合并后经 `fs:changed` 到达，这里再做一次 200 ms 合并。见 doc/design.md §12.5。
 */
export class WorkspaceStore {
  private state: WorkspaceState = {
    roots: [],
    visible: true,
    error: null,
  };
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  readonly getState = (): WorkspaceState => this.state;

  readonly subscribe = (listener: (state: WorkspaceState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 展开节点列表（跨全部根目录），用于会话恢复。 */
  collectExpanded(): string[] {
    return this.state.roots.flatMap((entry) => this.collectExpandedFrom(entry.nodes));
  }

  /** 每个根目录及其展开节点，用于会话持久化。 */
  collectRoots(): { rootPath: string; expanded: string[] }[] {
    return this.state.roots.map((entry) => ({
      rootPath: entry.root.path,
      expanded: this.collectExpandedFrom(entry.nodes),
    }));
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

  /** 打开（追加）一个根目录；重复路径只刷新，不会移除已打开的其他目录。 */
  async openPath(rootPath: string, expandedPaths: string[] = []): Promise<void> {
    const existing = this.state.roots.find((entry) => entry.root.path === rootPath);
    if (existing) {
      await this.refresh(rootPath);
      return;
    }
    try {
      const result = await window.panda.workspace.open({ path: rootPath });
      const nodes = toNodes(result.entries);
      await this.applyExpanded(nodes, new Set(expandedPaths));
      const { watchId } = await window.panda.fs.watch({ paths: [result.root.path] });
      this.commit({
        roots: [...this.state.roots, { root: result.root, nodes, watchId }],
        visible: true,
        error: null,
      });
    } catch (error) {
      this.commit({ error: describeError(error) });
    }
  }

  /** 移除一个根目录并停止监听。 */
  async closeRoot(rootPath: string): Promise<void> {
    const entry = this.state.roots.find((item) => item.root.path === rootPath);
    if (!entry) return;
    this.commit({ roots: this.state.roots.filter((item) => item.root.path !== rootPath) });
    if (entry.watchId) await window.panda.fs.unwatch({ watchId: entry.watchId }).catch(() => undefined);
  }

  setVisible(visible: boolean): void {
    this.commit({ visible });
  }

  async toggle(nodePath: string): Promise<void> {
    const node = this.findNode(nodePath);
    if (!node || node.kind !== "dir") return;
    if (node.expanded) {
      node.expanded = false;
      this.commit({ roots: [...this.state.roots] });
      return;
    }
    node.expanded = true;
    if (!node.children) {
      try {
        node.children = await this.loadChildren(node.path);
      } catch (error) {
        node.expanded = false;
        this.commit({ roots: [...this.state.roots], error: describeError(error) });
        return;
      }
    }
    this.commit({ roots: [...this.state.roots] });
  }

  /** 展开指定文件的全部父目录，供侧栏自动跟随当前标签。 */
  async revealPath(filePath: string): Promise<void> {
    const target = pathKey(filePath);
    for (const entry of this.state.roots) {
      const root = pathKey(entry.root.path);
      if (!target.startsWith(`${root}/`)) continue;
      const parts = target.slice(root.length + 1).split("/");
      let nodes = entry.nodes;
      let current = root;
      let changed = false;
      for (let index = 0; index < parts.length - 1; index += 1) {
        current = `${current}/${parts[index]}`;
        const dir = nodes.find(
          (node) => node.kind === "dir" && pathKey(node.path) === current,
        );
        if (!dir) return;
        if (!dir.expanded) {
          dir.expanded = true;
          changed = true;
        }
        if (!dir.children) {
          try {
            dir.children = await this.loadChildren(dir.path);
            changed = true;
          } catch {
            dir.expanded = false;
            return;
          }
        }
        nodes = dir.children;
      }
      if (changed) this.commit({ roots: [...this.state.roots] });
      return;
    }
  }

  /**
   * 刷新指定根目录；省略参数时刷新全部。见 doc/design.md §12.5。
   */
  async refresh(rootPath?: string): Promise<void> {
    this.refreshTimer = null;
    const targets = rootPath
      ? this.state.roots.filter((entry) => entry.root.path === rootPath)
      : this.state.roots;
    if (targets.length === 0) return;
    try {
      const refreshed = new Map<string, WorkspaceNode[]>();
      for (const entry of targets) {
        const expanded = new Set(this.collectExpandedFrom(entry.nodes));
        refreshed.set(entry.root.path, await this.refreshDir(entry.root.path, entry.nodes, expanded));
      }
      this.commit({
        roots: this.state.roots.map((entry) => ({
          ...entry,
          nodes: refreshed.get(entry.root.path) ?? entry.nodes,
        })),
      });
    } catch (error) {
      this.commit({ error: describeError(error) });
    }
  }

  /** 刷新任意目录的内容（行级刷新）；路径是根目录时回退到 refresh，文件行由调用方传父目录。 */
  async refreshNode(dirPath: string): Promise<void> {
    const node = this.findNode(dirPath);
    if (node) {
      if (node.kind !== "dir") return;
      try {
        node.children = await this.loadChildren(node.path);
        this.commit({ roots: [...this.state.roots] });
      } catch (error) {
        this.commit({ error: describeError(error) });
      }
      return;
    }
    const entry = this.state.roots.find((item) => pathKey(item.root.path) === pathKey(dirPath));
    if (entry) await this.refresh(entry.root.path);
  }

  /** 确保目录展开（已展开时不动），供新建文件/目录后展示结果。 */
  async expand(dirPath: string): Promise<void> {
    const node = this.findNode(dirPath);
    if (!node || node.kind !== "dir" || node.expanded) return;
    await this.toggle(dirPath);
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

  /** 主进程推送的目录变化：匹配监听 id 后按 200 ms 合并刷新全部根目录。 */
  handleFsChanged(event: FsChangedEvent): void {
    const entry = this.state.roots.find((item) => item.watchId === event.watchId);
    if (!entry) return;
    if (!event.changes.some((change) => pathKey(change.path).startsWith(pathKey(entry.root.path)))) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, 200);
  }

  private collectExpandedFrom(nodes: WorkspaceNode[]): string[] {
    const paths: string[] = [];
    const walk = (items: WorkspaceNode[]): void => {
      for (const node of items) {
        if (node.kind !== "dir" || !node.expanded) continue;
        paths.push(node.path);
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return paths;
  }

  private async applyExpanded(nodes: WorkspaceNode[], expanded: Set<string>): Promise<void> {
    for (const node of nodes) {
      if (node.kind !== "dir" || !expanded.has(node.path)) continue;
      node.expanded = true;
      node.children = await this.loadChildren(node.path);
      await this.applyExpanded(node.children, expanded);
    }
  }

  private async refreshDir(
    dirPath: string,
    previous: WorkspaceNode[],
    expanded: Set<string>,
  ): Promise<WorkspaceNode[]> {
    const { entries } = await window.panda.fs.readDir({ path: dirPath });
    const before = new Map(previous.map((node) => [node.path, node]));
    const nodes = toNodes(entries);
    for (const node of nodes) {
      if (node.kind !== "dir") continue;
      const old = before.get(node.path);
      const isExpanded = old?.expanded ?? expanded.has(node.path);
      node.expanded = isExpanded;
      if (isExpanded && old?.children) {
        node.children = await this.refreshDir(node.path, old.children, expanded);
      } else if (isExpanded) {
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
    for (const entry of this.state.roots) walk(entry.nodes);
    return found;
  }

  private commit(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
