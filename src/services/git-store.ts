import { describeError } from "../shared/errors";
import type { GitBranch, GitCommit, GitCommitDetail, GitSnapshot } from "../shared/git";
import { pathKey } from "../utils/paths";

export interface GitStoreState {
  /** 用于探测仓库的路径（工作区根或当前文件目录）。 */
  path: string | null;
  snapshot: GitSnapshot | null;
  branches: GitBranch[];
  commits: GitCommit[];
  /** 历史列表是否还有更早的提交可加载。 */
  commitsHasMore: boolean;
  detail: GitCommitDetail | null;
  loading: boolean;
  /** 正在执行的 Git 操作名称；非空时禁用写操作按钮。 */
  busy: string | null;
  error: string | null;
  /** 每次成功写操作后递增，供差异视图等订阅方刷新基线。 */
  version: number;
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/u, "")}/${relative}`;
}

/** 判断路径是否位于指定目录内（归一化分隔符与 Windows 盘符大小写）。 */
function isPathUnder(filePath: string, root: string): boolean {
  const target = pathKey(filePath);
  const base = pathKey(root);
  return target === base || target.startsWith(`${base}/`);
}

/** 历史列表默认每页条数；可在设置中改为 100 / 200。 */
const DEFAULT_COMMIT_PAGE_SIZE = 50;

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
    commitsHasMore: false,
    detail: null,
    loading: false,
    busy: null,
    error: null,
    version: 0,
  };

  private readonly listeners = new Set<(state: GitStoreState) => void>();
  private refreshToken = 0;
  private detailToken = 0;
  /** 当前已加载到的时间线深度；刷新时保持，切换仓库时重置。 */
  private commitLimit = DEFAULT_COMMIT_PAGE_SIZE;
  /** 每页提交条数；由设置同步。 */
  private pageSize = DEFAULT_COMMIT_PAGE_SIZE;

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

  /**
   * 切换探测路径；同一路径重复设置时保留现有快照。
   * 新路径仍位于当前仓库内时（例如打开仓库里的其他文件，探测路径从根变成子目录），
   * 保留快照、提交列表与已展开的提交详情，避免侧栏整块闪烁或详情被清空。
   */
  async setPath(path: string | null): Promise<void> {
    if (this.state.path === path) return;
    // 作废在途的刷新与提交详情，避免旧仓库结果覆盖新状态。
    this.refreshToken += 1;
    this.detailToken += 1;
    const previousRoot = this.state.snapshot?.root ?? null;
    const sameRepo = path !== null && previousRoot !== null && isPathUnder(path, previousRoot);
    // 仅切换仓库时重置分页深度；同仓库内换探测路径保留用户已加载的历史。
    if (!sameRepo) this.commitLimit = this.pageSize;
    this.patch({
      path,
      loading: false,
      busy: null,
      error: null,
      ...(sameRepo
        ? {}
        : {
            snapshot: null,
            branches: [],
            commits: [],
            commitsHasMore: false,
            detail: null,
          }),
    });
    if (path) await this.refresh();
  }

  /** 同步设置中的历史页大小；变更后按新页大小重新加载第一页。 */
  setHistoryPageSize(size: number): void {
    if (!Number.isFinite(size) || size <= 0 || size === this.pageSize) return;
    this.pageSize = size;
    this.commitLimit = size;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const path = this.state.path;
    if (!path) return;
    const token = ++this.refreshToken;
    const previousRoot = this.state.snapshot?.root ?? null;
    this.patch({ loading: true, error: null });
    try {
      const snapshot = await window.panda.git.snapshot({ path });
      if (token !== this.refreshToken || this.state.path !== path) return;
      if (!snapshot.inRepo || !snapshot.root) {
        this.patch({
          snapshot,
          branches: [],
          commits: [],
          commitsHasMore: false,
          detail: null,
          loading: false,
        });
        return;
      }
      const root = snapshot.root;
      const limit = this.commitLimit;
      const [branches, commits] = await Promise.all([
        window.panda.git.branches({ root }).catch(() => []),
        window.panda.git.log({ root, limit }).catch(() => []),
      ]);
      if (token !== this.refreshToken || this.state.path !== path) return;
      // 探测到的是另一个仓库（如嵌套仓库）时，原提交详情已不适用。
      const rootChanged = previousRoot !== null && pathKey(previousRoot) !== pathKey(root);
      this.patch({
        snapshot,
        branches,
        commits,
        commitsHasMore: commits.length === limit,
        loading: false,
        ...(rootChanged ? { detail: null } : {}),
      });
    } catch (error) {
      if (token !== this.refreshToken || this.state.path !== path) return;
      this.patch({ loading: false, error: describeError(error) });
    }
  }

  /** 追加更早的提交；返回追加后的历史是否还有下一页。 */
  async loadMoreCommits(): Promise<void> {
    const root = this.root;
    if (!root || this.state.loading || !this.state.commitsHasMore) return;
    const token = this.refreshToken;
    const skip = this.state.commits.length;
    try {
      const page = await window.panda.git.log({ root, limit: this.pageSize, skip });
      if (token !== this.refreshToken || this.root !== root) return;
      // 历史在分页期间可能被改写；按 hash 去重，避免重复条目。
      const seen = new Set(this.state.commits.map((commit) => commit.hash));
      const appended = page.filter((commit) => !seen.has(commit.hash));
      this.commitLimit = skip + page.length;
      this.patch({
        commits: [...this.state.commits, ...appended],
        commitsHasMore: page.length === this.pageSize,
        error: null,
      });
    } catch (error) {
      if (token !== this.refreshToken || this.root !== root) return;
      this.patch({ error: describeError(error) });
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
    const token = ++this.detailToken;
    try {
      const detail = await window.panda.git.commitDetail({ root, hash });
      // 仓库已切换或又发起了新的详情请求时丢弃旧结果。
      if (token !== this.detailToken || this.root !== root) return;
      this.patch({ detail, error: null });
    } catch (error) {
      if (token !== this.detailToken || this.root !== root) return;
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
    // 作废操作开始前在途的刷新，避免旧快照晚到覆盖操作结果。
    this.refreshToken += 1;
    this.patch({ busy: label, error: null });
    try {
      const snapshot = await action(root);
      // 操作期间切换了仓库：结果不属于当前仓库，直接丢弃。
      if (this.root !== root) return;
      const [branches, commits] = await Promise.all([
        window.panda.git.branches({ root }).catch(() => this.state.branches),
        window.panda.git.log({ root, limit: this.commitLimit }).catch(() => this.state.commits),
      ]);
      if (this.root !== root) return;
      // 作废操作期间发起的刷新：它们读到的可能是操作前的状态。
      this.refreshToken += 1;
      this.patch({
        snapshot,
        branches,
        commits,
        commitsHasMore: commits.length === this.commitLimit,
        loading: false,
        busy: null,
        version: this.state.version + 1,
      });
    } catch (error) {
      if (this.root !== root) return;
      this.refreshToken += 1;
      this.patch({ loading: false, busy: null, error: describeError(error) });
      throw error;
    }
  }

  private patch(patch: Partial<GitStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
