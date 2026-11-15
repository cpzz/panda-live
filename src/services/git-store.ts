import { describeError } from "../shared/errors";
import type { GitBranch, GitCommit, GitCommitDetail, GitSnapshot } from "../shared/git";

export interface GitStoreState {
  /** 用于探测仓库的路径（工作区根或当前文件目录）。 */
  path: string | null;
  snapshot: GitSnapshot | null;
  branches: GitBranch[];
  commits: GitCommit[];
  detail: GitCommitDetail | null;
  loading: boolean;
  /** 正在执行的 Git 操作名称；非空时禁用写操作按钮。 */
  busy: string | null;
  error: string | null;
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/u, "")}/${relative}`;
}

/**
 * 渲染进程侧 Git 状态：按探测路径加载快照、分支与最近提交。
 * 所有写操作经主进程 Git 服务执行，成功后刷新快照。见 doc/design.md Git 方案。
 */
export class GitStore {
  private state: GitStoreState = {
    path: null,
    snapshot: null,
    branches: [],
    commits: [],
    detail: null,
    loading: false,
    busy: null,
    error: null,
  };

  private readonly listeners = new Set<(state: GitStoreState) => void>();
  private refreshToken = 0;

  readonly getState = (): GitStoreState => this.state;

  readonly subscribe = (listener: (state: GitStoreState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get root(): string | null {
    return this.state.snapshot?.root ?? null;
  }

  /** 切换探测路径；同一路径重复设置时保留现有快照。 */
  async setPath(path: string | null): Promise<void> {
    if (this.state.path === path) return;
    this.patch({
      path,
      snapshot: null,
      branches: [],
      commits: [],
      detail: null,
      error: null,
    });
    if (path) await this.refresh();
  }

  async refresh(): Promise<void> {
    const path = this.state.path;
    if (!path) return;
    const token = ++this.refreshToken;
    this.patch({ loading: true, error: null });
    try {
      const snapshot = await window.panda.git.snapshot({ path });
      if (token !== this.refreshToken) return;
      if (!snapshot.inRepo || !snapshot.root) {
        this.patch({ snapshot, branches: [], commits: [], loading: false });
        return;
      }
      const [branches, commits] = await Promise.all([
        window.panda.git.branches({ root: snapshot.root }).catch(() => []),
        window.panda.git.log({ root: snapshot.root, limit: 50 }).catch(() => []),
      ]);
      if (token !== this.refreshToken) return;
      this.patch({ snapshot, branches, commits, loading: false });
    } catch (error) {
      if (token !== this.refreshToken) return;
      this.patch({ loading: false, error: describeError(error) });
    }
  }

  async stage(paths: string[]): Promise<void> {
    await this.operate("暂存", async (root) => window.panda.git.stage({ root, paths }));
  }

  async unstage(paths: string[]): Promise<void> {
    await this.operate("取消暂存", async (root) => window.panda.git.unstage({ root, paths }));
  }

  /** 放弃已跟踪文件的修改；未跟踪文件移入回收站。 */
  async discard(paths: string[], untrackedPaths: string[]): Promise<void> {
    await this.operate("放弃修改", async (root) => {
      if (paths.length > 0) await window.panda.git.discard({ root, paths });
      for (const relative of untrackedPaths) {
        await window.panda.fs.trash({ path: joinPath(root, relative) });
      }
      return window.panda.git.snapshot({ path: root });
    });
  }

  async commit(message: string, amend: boolean): Promise<void> {
    await this.operate("提交", async (root) =>
      window.panda.git.commit({ root, message, amend }),
    );
  }

  async fetch(): Promise<void> {
    await this.operate("获取", async (root) => window.panda.git.fetch({ root }));
  }

  async pull(): Promise<void> {
    await this.operate("拉取", async (root) => window.panda.git.pull({ root }));
  }

  async push(setUpstream = false): Promise<void> {
    await this.operate("推送", async (root) =>
      window.panda.git.push({ root, setUpstream }),
    );
  }

  async checkout(branch: string, create = false): Promise<void> {
    await this.operate("切换分支", async (root) =>
      window.panda.git.checkout({ root, branch, create }),
    );
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.operate("删除分支", async (root) =>
      window.panda.git.deleteBranch({ root, branch }),
    );
  }

  async abort(): Promise<void> {
    await this.operate("中止操作", async (root) => window.panda.git.abort({ root }));
  }

  async continue(): Promise<void> {
    await this.operate("继续操作", async (root) => window.panda.git.continue({ root }));
  }

  async loadCommitDetail(hash: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    try {
      const detail = await window.panda.git.commitDetail({ root, hash });
      this.patch({ detail, error: null });
    } catch (error) {
      this.patch({ error: describeError(error) });
    }
  }

  clearDetail(): void {
    this.patch({ detail: null });
  }

  dismissError(): void {
    this.patch({ error: null });
  }

  private async operate(
    label: string,
    action: (root: string) => Promise<GitSnapshot>,
  ): Promise<void> {
    const root = this.root;
    if (!root || this.state.busy) return;
    this.patch({ busy: label, error: null });
    try {
      const snapshot = await action(root);
      const [branches, commits] = await Promise.all([
        window.panda.git.branches({ root }).catch(() => this.state.branches),
        window.panda.git.log({ root, limit: 50 }).catch(() => this.state.commits),
      ]);
      this.patch({ snapshot, branches, commits, busy: null });
    } catch (error) {
      this.patch({ busy: null, error: describeError(error) });
      throw error;
    }
  }

  private patch(patch: Partial<GitStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
