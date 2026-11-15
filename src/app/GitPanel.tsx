import { useEffect, useMemo, useRef, useState } from "react";
import type { GitChange } from "../shared/git";
import type { GitStore, GitStoreState } from "../services/git-store";
import { t } from "../i18n";
import { Icon } from "./icons";

interface GitPanelProps {
  store: GitStore;
  state: GitStoreState;
  /** 打开仓库内文件并进入 Git 差异视图。 */
  onOpenFile(path: string): void;
  /** 仓库内未保存文档数量；>0 时提示 Git 只读取磁盘内容。 */
  dirtyCount: number;
  /** 可切换的工作区目录（多根工作区与工作区外的当前文件目录）。 */
  repos: Array<{ path: string; name: string }>;
  selectedRepo: string | null;
  onSelectRepo(path: string): void;
  onSaveAll(): Promise<void>;
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/u, "")}/${relative}`;
}

function statusLabel(change: GitChange): string {
  if (change.conflicted) return "U";
  if (change.untracked) return "?";
  const code = change.staged ? change.indexStatus : change.worktreeStatus;
  return code === "." ? "M" : code;
}

function ChangeRow({
  change,
  root,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  disabled,
}: {
  change: GitChange;
  root: string;
  onOpenFile(path: string): void;
  onStage?(path: string): void;
  onUnstage?(path: string): void;
  onDiscard?(change: GitChange): void;
  disabled: boolean;
}) {
  const display = change.origPath ? `${change.origPath} → ${change.path}` : change.path;
  return (
    <div
      className="git-change-row"
      title={display}
      onClick={() => {
        if (change.kind === "deleted") return;
        onOpenFile(joinPath(root, change.path));
      }}
    >
      <span className={`git-change-status status-${statusLabel(change).toLowerCase()}`}>
        {statusLabel(change)}
      </span>
      <span className="git-change-path">{display}</span>
      <span className="git-change-actions" onClick={(event) => event.stopPropagation()}>
        {onStage && (
          <button
            type="button"
            className="git-icon-button"
            title={change.conflicted ? t("标记为已解决") : t("暂存")}
            aria-label={change.conflicted ? t("标记为已解决") : t("暂存")}
            disabled={disabled}
            onClick={() => onStage(change.path)}
          >
            <Icon name="file-plus" size={13} />
          </button>
        )}
        {onUnstage && (
          <button
            type="button"
            className="git-icon-button"
            title={t("取消暂存")}
            aria-label={t("取消暂存")}
            disabled={disabled}
            onClick={() => onUnstage(change.path)}
          >
            <Icon name="reset" size={13} />
          </button>
        )}
        {onDiscard && (
          <button
            type="button"
            className="git-icon-button"
            title={t("放弃修改")}
            aria-label={t("放弃修改")}
            disabled={disabled}
            onClick={() => onDiscard(change)}
          >
            <Icon name="trash" size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

/** 源代码管理侧栏：仓库状态、暂存/提交、分支与同步、历史。 */
export function GitPanel({
  store,
  state,
  onOpenFile,
  dirtyCount,
  repos,
  selectedRepo,
  onSelectRepo,
  onSaveAll,
}: GitPanelProps) {
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchWrapRef = useRef<HTMLDivElement>(null);
  const [newBranch, setNewBranch] = useState("");
  const [detailHash, setDetailHash] = useState<string | null>(null);

  const snapshot = state.snapshot;
  const root = snapshot?.root ?? null;
  const changes = snapshot?.changes ?? [];
  const busy = Boolean(state.busy);
  const groups = useMemo(
    () => ({
      conflicts: changes.filter((change) => change.conflicted),
      staged: changes.filter((change) => change.staged && !change.conflicted),
      unstaged: changes.filter(
        (change) => change.unstaged && !change.untracked && !change.conflicted,
      ),
      untracked: changes.filter((change) => change.untracked),
    }),
    [changes],
  );
  const stagedCount = groups.staged.length;
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy;
  const localBranches = state.branches.filter((branch) => !branch.remote);

  // 分支菜单：点击外部或按 Esc 关闭。
  useEffect(() => {
    if (!branchOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !branchWrapRef.current?.contains(event.target)) {
        setBranchOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setBranchOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [branchOpen]);

  // 多根工作区：允许切换到其他目录对应的仓库。
  const repoPicker =
    repos.length > 1 ? (
      <label className="git-repo-picker">
        <Icon name="folder" size={12} />
        <select
          className="git-repo-select"
          aria-label={t("选择仓库")}
          title={repos.find((repo) => repo.path === selectedRepo)?.path ?? ""}
          value={selectedRepo ?? ""}
          onChange={(event) => onSelectRepo(event.target.value)}
        >
          {repos.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repo.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  if (!snapshot || !root) {
    return (
      <div className="git-panel">
        {repoPicker}
        <div className="git-empty">
          <Icon name="git" size={20} />
          <p>{state.loading ? t("读取 Git 状态…") : t("当前工作区不是 Git 仓库")}</p>
          {state.error && <p className="git-empty-detail">{state.error}</p>}
          <button type="button" className="button small" onClick={() => void store.refresh()}>
            {t("重新检测")}
          </button>
        </div>
      </div>
    );
  }

  const confirmDiscard = (targets: GitChange[]): void => {
    const names = targets.map((change) => change.path).join("\n");
    if (!window.confirm(t("确定放弃以下文件的修改吗？\n{0}", names))) return;
    const tracked = targets.filter((change) => !change.untracked).map((change) => change.path);
    const untracked = targets.filter((change) => change.untracked).map((change) => change.path);
    void store.discard(tracked, untracked).catch(() => undefined);
  };

  const sync = (action: "fetch" | "pull" | "push"): void => {
    if (dirtyCount > 0 && action !== "fetch") {
      if (!window.confirm(t("仓库内有 {0} 个未保存文档，Git 只使用磁盘内容。是否继续？", dirtyCount))) {
        return;
      }
    }
    if (action === "push") {
      void store.push().catch(async (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        if (/no upstream|upstream branch/iu.test(text) && snapshot.branch) {
          if (window.confirm(t("分支「{0}」没有上游分支，是否推送并设置上游？", snapshot.branch))) {
            await store.push(true).catch(() => undefined);
          }
        }
      });
      return;
    }
    void (action === "fetch" ? store.fetch() : store.pull()).catch(() => undefined);
  };

  const checkout = (branch: string): void => {
    setBranchOpen(false);
    if (branch === snapshot.branch) return;
    if (dirtyCount > 0) {
      if (!window.confirm(t("仓库内有 {0} 个未保存文档，切换分支只使用磁盘内容。是否继续？", dirtyCount))) {
        return;
      }
    }
    void store.checkout(branch).catch(() => undefined);
  };

  return (
    <div className="git-panel">
      {repoPicker}
      <div className="git-panel-header">
        <div className="git-branch-wrap" ref={branchWrapRef}>
          <button
            type="button"
            className="git-branch-button"
            aria-expanded={branchOpen}
            title={snapshot.detached ? t("detached HEAD") : (snapshot.branch ?? "")}
            onClick={() => setBranchOpen((open) => !open)}
          >
            <Icon name="git" size={13} />
            <span>{snapshot.detached ? t("detached HEAD") : snapshot.branch}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          {branchOpen && (
            <div className="git-branch-menu" role="menu">
              {localBranches.map((branch) => (
                <div key={branch.name} className="git-branch-row">
                  <button
                    type="button"
                    className={branch.current ? "git-branch-item active" : "git-branch-item"}
                    role="menuitem"
                    onClick={() => checkout(branch.name)}
                  >
                    {branch.current && <span className="git-branch-check">✓</span>}
                    <span>{branch.name}</span>
                  </button>
                  {!branch.current && (
                    <button
                      type="button"
                      className="git-icon-button"
                      title={t("删除分支")}
                      aria-label={t("删除分支 {0}", branch.name)}
                      onClick={() => {
                        if (window.confirm(t("确定删除分支「{0}」吗？", branch.name))) {
                          void store.deleteBranch(branch.name).catch(() => undefined);
                        }
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
              ))}
              <form
                className="git-branch-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = newBranch.trim();
                  if (!name) return;
                  setNewBranch("");
                  setBranchOpen(false);
                  void store.checkout(name, true).catch(() => undefined);
                }}
              >
                <input
                  className="git-branch-input"
                  placeholder={t("新分支名")}
                  aria-label={t("新分支名")}
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                />
                <button type="submit" className="button small" disabled={!newBranch.trim() || busy}>
                  {t("创建")}
                </button>
              </form>
            </div>
          )}
        </div>
        <div className="git-sync-actions">
          {snapshot.ahead > 0 && <span className="git-ahead">↑{snapshot.ahead}</span>}
          {snapshot.behind > 0 && <span className="git-behind">↓{snapshot.behind}</span>}
          <button
            type="button"
            className="git-icon-button"
            title={t("获取（fetch）")}
            aria-label={t("获取")}
            disabled={busy}
            onClick={() => sync("fetch")}
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="git-icon-button"
            title={t("拉取（git pull）")}
            aria-label={t("拉取")}
            disabled={busy}
            onClick={() => sync("pull")}
          >
            <Icon name="arrow-down" size={13} />
          </button>
          <button
            type="button"
            className="git-icon-button"
            title={t("推送（git push）")}
            aria-label={t("推送")}
            disabled={busy}
            onClick={() => sync("push")}
          >
            <Icon name="arrow-up" size={13} />
          </button>
        </div>
      </div>

      {state.error && (
        <div className="banner banner-warning git-error" role="alert">
          <span className="banner-text">{state.error}</span>
          <button type="button" className="git-icon-button" onClick={() => store.dismissError()}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {dirtyCount > 0 && (
        <div className="git-dirty-notice">
          <span>{t("有 {0} 个未保存文档，Git 操作只使用磁盘内容。", dirtyCount)}</span>
          <button type="button" className="button small" onClick={() => void onSaveAll()}>
            {t("全部保存")}
          </button>
        </div>
      )}
      {snapshot.operation && (
        <div className="git-operation-notice">
          <span>
            {snapshot.operation === "merge"
              ? t("合并进行中")
              : snapshot.operation === "rebase"
                ? t("变基进行中")
                : t("拣选进行中")}
          </span>
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => void store.continue().catch(() => undefined)}
          >
            {t("继续")}
          </button>
          <button
            type="button"
            className="button small ghost"
            disabled={busy}
            onClick={() => void store.abort().catch(() => undefined)}
          >
            {t("中止")}
          </button>
        </div>
      )}

      <div className="git-panel-tabs" role="tablist" aria-label={t("Git 视图")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          className={tab === "changes" ? "sidebar-tab active" : "sidebar-tab"}
          onClick={() => setTab("changes")}
        >
          {t("更改")}
          {changes.length > 0 && <span className="git-tab-count">{changes.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "sidebar-tab active" : "sidebar-tab"}
          onClick={() => setTab("history")}
        >
          {t("历史")}
        </button>
      </div>

      {tab === "changes" ? (
        <div className="git-panel-body">
          <div className="git-commit-box">
            <textarea
              className="git-commit-input"
              rows={3}
              placeholder={t("提交信息（第一行为标题）")}
              aria-label={t("提交信息")}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canCommit) {
                  event.preventDefault();
                  void store
                    .commit(message.trim(), amend)
                    .then(() => {
                      setMessage("");
                      setAmend(false);
                    })
                    .catch(() => undefined);
                }
              }}
            />
            <div className="git-commit-actions">
              <label className="git-amend">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(event) => setAmend(event.target.checked)}
                />
                <span>Amend</span>
              </label>
              <button
                type="button"
                className="button small primary"
                disabled={!canCommit}
                title={canCommit ? t("提交（Ctrl+Enter）") : t("请先暂存文件并填写提交信息")}
                onClick={() => {
                  void store
                    .commit(message.trim(), amend)
                    .then(() => {
                      setMessage("");
                      setAmend(false);
                    })
                    .catch(() => undefined);
                }}
              >
                {state.busy === "提交" ? t("提交中…") : t("提交")}
              </button>
            </div>
          </div>

          {changes.length === 0 && !state.loading && (
            <p className="placeholder git-clean">{t("工作区没有变更")}</p>
          )}

          {groups.conflicts.length > 0 && (
            <section className="git-change-group">
              <header>
                <span>{t("冲突")}</span>
                <span className="git-group-count">{groups.conflicts.length}</span>
              </header>
              {groups.conflicts.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  root={root}
                  onOpenFile={onOpenFile}
                  onStage={(path) => void store.stage([path]).catch(() => undefined)}
                  disabled={busy}
                />
              ))}
            </section>
          )}

          {groups.staged.length > 0 && (
            <section className="git-change-group">
              <header>
                <span>{t("已暂存")}</span>
                <span className="git-group-count">{groups.staged.length}</span>
                <button
                  type="button"
                  className="git-group-action"
                  disabled={busy}
                  onClick={() =>
                    void store
                      .unstage(groups.staged.map((change) => change.path))
                      .catch(() => undefined)
                  }
                >
                  {t("全部取消暂存")}
                </button>
              </header>
              {groups.staged.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  root={root}
                  onOpenFile={onOpenFile}
                  onUnstage={(path) => void store.unstage([path]).catch(() => undefined)}
                  onDiscard={(target) => confirmDiscard([target])}
                  disabled={busy}
                />
              ))}
            </section>
          )}

          {groups.unstaged.length > 0 && (
            <section className="git-change-group">
              <header>
                <span>{t("更改")}</span>
                <span className="git-group-count">{groups.unstaged.length}</span>
                <button
                  type="button"
                  className="git-group-action"
                  disabled={busy}
                  onClick={() =>
                    void store
                      .stage(groups.unstaged.map((change) => change.path))
                      .catch(() => undefined)
                  }
                >
                  {t("全部暂存")}
                </button>
              </header>
              {groups.unstaged.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  root={root}
                  onOpenFile={onOpenFile}
                  onStage={(path) => void store.stage([path]).catch(() => undefined)}
                  onDiscard={(target) => confirmDiscard([target])}
                  disabled={busy}
                />
              ))}
            </section>
          )}

          {groups.untracked.length > 0 && (
            <section className="git-change-group">
              <header>
                <span>{t("未跟踪")}</span>
                <span className="git-group-count">{groups.untracked.length}</span>
                <button
                  type="button"
                  className="git-group-action"
                  disabled={busy}
                  onClick={() =>
                    void store
                      .stage(groups.untracked.map((change) => change.path))
                      .catch(() => undefined)
                  }
                >
                  {t("全部暂存")}
                </button>
              </header>
              {groups.untracked.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  root={root}
                  onOpenFile={onOpenFile}
                  onStage={(path) => void store.stage([path]).catch(() => undefined)}
                  onDiscard={(target) => confirmDiscard([target])}
                  disabled={busy}
                />
              ))}
            </section>
          )}
        </div>
      ) : (
        <div className="git-panel-body git-history">
          <div className="git-history-header">
            <span>{t("最近提交")}</span>
            <button
              type="button"
              className="git-icon-button"
              title={t("刷新历史")}
              aria-label={t("刷新历史")}
              onClick={() => void store.refresh()}
            >
              <Icon name="refresh" size={12} />
            </button>
          </div>
          {state.commits.length === 0 && <p className="placeholder">{t("还没有提交")}</p>}
          {state.commits.map((commit) => (
            <button
              key={commit.hash}
              type="button"
              className={detailHash === commit.hash ? "git-commit-row active" : "git-commit-row"}
              title={`${commit.hash}\n${commit.author}\n${commit.date}`}
              onClick={() => {
                setDetailHash(commit.hash);
                void store.loadCommitDetail(commit.hash);
              }}
            >
              <span className="git-commit-subject">{commit.subject}</span>
              <span className="git-commit-meta">
                {commit.shortHash} · {commit.author}
              </span>
            </button>
          ))}
          {state.detail && (
            <div className="git-commit-detail">
              <h3>{state.detail.subject}</h3>
              <p className="git-commit-detail-meta">
                {state.detail.shortHash} · {state.detail.author} · {state.detail.date}
              </p>
              {state.detail.body.trim() && <pre>{state.detail.body.trim()}</pre>}
              {state.detail.files.length > 0 && (
                <>
                  <h4>{t("变更文件")}</h4>
                  <ul>
                    {state.detail.files.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {state.busy && <div className="git-busy">{t("{0}…", t(state.busy))}</div>}
    </div>
  );
}
