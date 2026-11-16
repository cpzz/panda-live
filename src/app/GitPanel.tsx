import { useEffect, useMemo, useRef, useState } from "react";
import type { GitChange } from "../shared/git";
import type { GitStore, GitStoreState } from "../services/git-store";
import { localeTag, t } from "../i18n";
import { Icon } from "./icons";

interface GitPanelProps {
  store: GitStore;
  state: GitStoreState;
  /** 打开仓库内文件并进入 Git 差异视图（工作区对比）。 */
  onOpenFile(path: string): void;
  /** 打开已暂存文件并进入 Git 差异视图（HEAD 对比暂存区）。 */
  onOpenStagedFile(path: string): void;
  /** 打开提交详情中的文件并进入 Git 显示模式（该提交 ⇄ 父提交）。 */
  onOpenCommitFile(shortHash: string, file: string): void;
  /** 冲突项只打开文件本身：冲突标记需在源码模式处理，不进入只读差异视图。 */
  onOpenConflictFile(path: string): void;
  /** 仓库内未保存文档数量；>0 时提示 Git 只读取磁盘内容。 */
  dirtyCount: number;
  /** 可切换的工作区目录（多根工作区与工作区外的当前文件目录）。 */
  repos: Array<{ path: string; name: string }>;
  selectedRepo: string | null;
  onSelectRepo(path: string): void;
  /** 保存仓库内全部文档；返回 false 表示仍有文档未保存成功。 */
  onSaveAll(): Promise<boolean>;
}

/** 单个变更涉及的全部路径；重命名/复制需要同时处理旧路径与新路径。 */
function changePaths(change: GitChange): string[] {
  return change.origPath && change.origPath !== change.path
    ? [change.origPath, change.path]
    : [change.path];
}

/** 消除重复路径，避免重命名条目在批量操作中重复执行。 */
function allPaths(changes: GitChange[]): string[] {
  return [...new Set(changes.flatMap(changePaths))];
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/u, "")}/${relative}`;
}

/** 保留 porcelain v2 的两位状态码：第一位是索引，第二位是工作区。 */
function statusLabel(change: GitChange): string {
  if (change.untracked) return "??";
  const index = change.indexStatus === "." ? " " : change.indexStatus;
  const worktree = change.worktreeStatus === "." ? " " : change.worktreeStatus;
  return `${index}${worktree}`;
}

/** 历史与详情统一显示本地时间，ISO 字符串仅在 tooltip 中保留。 */
function formatCommitDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString(localeTag(), {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  });
}

function ChangeRow({
  change,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  disabled,
}: {
  change: GitChange;
  onOpen(change: GitChange): void;
  onStage?(change: GitChange): void;
  onUnstage?(change: GitChange): void;
  onDiscard?(change: GitChange): void;
  disabled: boolean;
}) {
  const display = change.origPath ? `${change.origPath} → ${change.path}` : change.path;
  // 工作区没有文件内容时（删除、或已暂存重命名后又删除新路径）无法打开。
  const staticRow = change.kind === "deleted" || change.worktreeStatus === "D";
  const label = statusLabel(change);
  return (
    <div
      className={staticRow ? "git-change-row git-change-row-static" : "git-change-row"}
      title={display}
      tabIndex={staticRow ? undefined : 0}
      onClick={() => {
        if (!staticRow) onOpen(change);
      }}
      onKeyDown={(event) => {
        // 只处理行本身获得焦点时的按键，避免与行内操作按钮的 Enter/Space 重复触发。
        if (event.target !== event.currentTarget) return;
        if (staticRow || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onOpen(change);
      }}
    >
      <span
        className={`git-change-status status-${change.kind}`}
        title={`${change.indexStatus}${change.worktreeStatus}`}
      >
        {label}
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
            onClick={() => onStage(change)}
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
            onClick={() => onUnstage(change)}
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
  onOpenStagedFile,
  onOpenCommitFile,
  onOpenConflictFile,
  dirtyCount,
  repos,
  selectedRepo,
  onSelectRepo,
  onSaveAll,
}: GitPanelProps) {
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  /** 提交前的保存阶段尚未进入 store.busy，用本地状态防止重复提交。 */
  const [committing, setCommitting] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchWrapRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const [newBranch, setNewBranch] = useState("");
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const previousRepoRef = useRef(selectedRepo);

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
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy && !committing;
  const commitHint = committing
    ? t("提交中…")
    : busy
      ? t("正在执行其他 Git 操作")
      : stagedCount === 0
        ? t("请先暂存文件")
        : message.trim().length === 0
          ? t("请填写提交信息")
          : t("提交（Ctrl+Enter）");
  const localBranches = state.branches.filter((branch) => !branch.remote);

  // 切换仓库时清空提交草稿与 Amend，避免把上一个仓库的信息带到新仓库。
  useEffect(() => {
    if (previousRepoRef.current === selectedRepo) return;
    previousRepoRef.current = selectedRepo;
    setMessage("");
    setAmend(false);
    setDetailHash(null);
    setTab("changes");
  }, [selectedRepo]);

  // 分支菜单：点击外部或按 Esc 关闭；打开后把焦点移入第一项。
  useEffect(() => {
    if (!branchOpen) return;
    branchMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
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

  // 多根工作区：允许切换到其他目录对应的仓库；操作进行中禁止切换。
  // 同名目录用路径后缀区分，避免下拉里出现无法辨别的重复项。
  const repoLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const repo of repos) counts.set(repo.name, (counts.get(repo.name) ?? 0) + 1);
    return new Map(
      repos.map((repo) => [
        repo.path,
        (counts.get(repo.name) ?? 0) > 1 ? `${repo.name} — ${repo.path}` : repo.name,
      ]),
    );
  }, [repos]);
  const repoPicker =
    repos.length > 1 ? (
      <label className="git-repo-picker">
        <Icon name="folder" size={12} />
        <select
          className="git-repo-select"
          aria-label={t("选择仓库")}
          title={repos.find((repo) => repo.path === selectedRepo)?.path ?? ""}
          value={selectedRepo ?? ""}
          disabled={busy || committing}
          onChange={(event) => {
            if (busy || committing) return;
            onSelectRepo(event.target.value);
          }}
        >
          {repos.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repoLabels.get(repo.path) ?? repo.name}
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

  const openChange = (change: GitChange, target: "worktree" | "index"): void => {
    if (change.kind === "deleted") return;
    const absolute = joinPath(root, change.path);
    if (target === "index") {
      onOpenStagedFile(absolute);
    } else {
      onOpenFile(absolute);
    }
  };
  // 同一路径可能同时出现在已暂存与更改分组：只有已暂存分组对比索引。
  const openWorktreeChange = (change: GitChange): void => openChange(change, "worktree");
  const openStagedChange = (change: GitChange): void => openChange(change, "index");

  const confirmDiscard = (targets: GitChange[]): void => {
    const names = targets
      .map((change) => (change.origPath ? `${change.origPath} → ${change.path}` : change.path))
      .join("\n");
    const hasUntracked = targets.some((change) => change.untracked);
    const prompt = hasUntracked
      ? t(
          "确定放弃以下文件的修改吗？\n{0}\n\n未跟踪文件将移入系统回收站。",
          names,
        )
      : t("确定放弃以下文件的修改吗？\n{0}", names);
    if (!window.confirm(prompt)) return;
    const tracked = allPaths(targets.filter((change) => !change.untracked));
    const untracked = allPaths(targets.filter((change) => change.untracked));
    void store.discard(tracked, untracked).catch(() => undefined);
  };

  const confirmDirty = (action: "pull" | "push" | "checkout" | "commit"): boolean => {
    if (dirtyCount === 0) return true;
    if (action === "commit") {
      return window.confirm(
        t(
          "仓库内有 {0} 个未保存文档，提交只会包含已暂存内容。是否先保存全部文档？",
          dirtyCount,
        ),
      );
    }
    const text =
      action === "checkout"
        ? t("仓库内有 {0} 个未保存文档，切换分支只使用磁盘内容。是否继续？", dirtyCount)
        : t("仓库内有 {0} 个未保存文档，Git 只使用磁盘内容。是否继续？", dirtyCount);
    return window.confirm(text);
  };

  const push = (): void => {
    if (!snapshot.upstream) {
      if (!snapshot.branch || snapshot.detached) {
        void store.push().catch(() => undefined);
        return;
      }
      if (!window.confirm(t("分支「{0}」没有上游分支，是否推送并设置上游？", snapshot.branch))) {
        return;
      }
      void store.push(true).catch(() => undefined);
      return;
    }
    void store.push().catch(() => undefined);
  };

  const sync = (action: "fetch" | "pull" | "push"): void => {
    if (action !== "fetch" && !confirmDirty(action)) return;
    if (action === "push") {
      push();
      return;
    }
    void (action === "fetch" ? store.fetch() : store.pull()).catch(() => undefined);
  };

  const checkout = (branch: string): void => {
    setBranchOpen(false);
    if (branch === snapshot.branch) return;
    if (!confirmDirty("checkout")) return;
    void store.checkout(branch).catch(() => undefined);
  };

  const runCommit = (): void => {
    const text = message.trim();
    if (!text || stagedCount === 0 || busy || committing) return;
    if (!confirmDirty("commit")) return;
    setCommitting(true);
    void (async () => {
      try {
        if (dirtyCount > 0) {
          const saved = await onSaveAll();
          // 保存失败时不再提交，避免把磁盘上的旧内容当作最新改动。
          if (!saved) return;
        }
        await store.commit(text, amend);
        // 提交期间用户可能继续输入；只清空本次提交使用的文本。
        setMessage((current) => (current.trim() === text ? "" : current));
        setAmend(false);
      } finally {
        setCommitting(false);
      }
    })().catch(() => undefined);
  };

  const abortLabel =
    snapshot.operation === "merge"
      ? t("合并")
      : snapshot.operation === "rebase"
        ? t("变基")
        : t("拣选");

  return (
    <div className="git-panel" aria-busy={busy}>
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
            <div
              className="git-branch-menu"
              role="menu"
              ref={branchMenuRef}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="menuitem"]:not([disabled]), .git-branch-input, .git-branch-create button:not([disabled])',
                  ),
                );
                if (items.length === 0) return;
                event.preventDefault();
                const current = items.indexOf(document.activeElement as HTMLElement);
                const next =
                  event.key === "ArrowDown"
                    ? (current + 1 + items.length) % items.length
                    : (current - 1 + items.length) % items.length;
                items[next]?.focus();
              }}
            >
              {localBranches.map((branch) => (
                <div key={branch.name} className="git-branch-row" role="none">
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
                role="none"
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
            title={t("刷新")}
            aria-label={t("刷新")}
            disabled={busy}
            onClick={() => void store.refresh()}
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="git-icon-button"
            title={t("获取（fetch）")}
            aria-label={t("获取")}
            disabled={busy}
            onClick={() => sync("fetch")}
          >
            <Icon name="reset" size={13} />
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
          <button
            type="button"
            className="git-icon-button"
            title={t("关闭")}
            aria-label={t("关闭")}
            onClick={() => store.dismissError()}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {dirtyCount > 0 && (
        <div className="git-dirty-notice">
          <span>{t("有 {0} 个未保存文档，Git 操作只使用磁盘内容。", dirtyCount)}</span>
          <button
            type="button"
            className="button small"
            onClick={() => void onSaveAll().catch(() => undefined)}
          >
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
            onClick={() => {
              if (
                !window.confirm(
                  t("确定中止{0}吗？当前操作的中间状态会被丢弃。", abortLabel),
                )
              ) {
                return;
              }
              void store.abort().catch(() => undefined);
            }}
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
                  runCommit();
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
                title={commitHint}
                onClick={runCommit}
              >
                {state.busy === "提交" || committing ? t("提交中…") : t("提交")}
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
                  onOpen={() => onOpenConflictFile(joinPath(root, change.path))}
                  onStage={(target) =>
                    void store.stage(changePaths(target)).catch(() => undefined)
                  }
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
                    void store.unstage(allPaths(groups.staged)).catch(() => undefined)
                  }
                >
                  {t("全部取消暂存")}
                </button>
              </header>
              {groups.staged.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  onOpen={openStagedChange}
                  onUnstage={(target) =>
                    void store.unstage(changePaths(target)).catch(() => undefined)
                  }
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
                    void store.stage(allPaths(groups.unstaged)).catch(() => undefined)
                  }
                >
                  {t("全部暂存")}
                </button>
              </header>
              {groups.unstaged.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  onOpen={openWorktreeChange}
                  onStage={(target) => void store.stage(changePaths(target)).catch(() => undefined)}
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
                    void store.stage(allPaths(groups.untracked)).catch(() => undefined)
                  }
                >
                  {t("全部暂存")}
                </button>
              </header>
              {groups.untracked.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  onOpen={openWorktreeChange}
                  onStage={(target) => void store.stage(changePaths(target)).catch(() => undefined)}
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
              disabled={busy}
              onClick={() => void store.refresh()}
            >
              <Icon name="refresh" size={12} />
            </button>
          </div>
          {state.commits.length === 0 && <p className="placeholder">{t("还没有提交")}</p>}
          {state.commits.map((commit) => {
            const expanded = detailHash === commit.hash;
            const detail = expanded && state.detail?.hash === commit.hash ? state.detail : null;
            return (
              <div key={commit.hash} className="git-commit-item">
                <button
                  type="button"
                  className={expanded ? "git-commit-row active" : "git-commit-row"}
                  aria-expanded={expanded}
                  title={`${commit.hash}\n${commit.author}\n${formatCommitDate(commit.date)}`}
                  onClick={() => {
                    if (expanded) {
                      setDetailHash(null);
                      return;
                    }
                    setDetailHash(commit.hash);
                    void store.loadCommitDetail(commit.hash);
                  }}
                >
                  <span className="git-commit-toggle" aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                  <span className="git-commit-text">
                    <span className="git-commit-subject">{commit.subject}</span>
                    <span className="git-commit-meta">
                      {commit.shortHash} · {commit.author} · {formatCommitDate(commit.date)}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div className="git-commit-expand">
                    {!detail && <p className="placeholder">{t("读取提交详情…")}</p>}
                    {detail && detail.body.trim() && <pre>{detail.body.trim()}</pre>}
                    {detail && detail.files.length === 0 && (
                      <p className="placeholder">{t("没有变更文件")}</p>
                    )}
                    {detail && detail.files.length > 0 && (
                      <ul>
                        {detail.files.slice(0, 100).map((file) => (
                          <li key={file}>
                            <button
                              type="button"
                              className="git-detail-file"
                              title={t("查看该提交与其父提交的差异")}
                              onClick={() => onOpenCommitFile(detail.shortHash, file)}
                            >
                              {file}
                            </button>
                          </li>
                        ))}
                        {detail.files.length > 100 && (
                          <li className="git-detail-more">
                            {t("还有 {0} 个文件…", detail.files.length - 100)}
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {state.busy && (
        <div className="git-busy" role="status" aria-live="polite">
          {t("{0}…", t(state.busy))}
        </div>
      )}
    </div>
  );
}
