import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  pickRemote,
  REMOTE_NAME_PATTERN,
  type GitChange,
  type GitCompareFile,
  type GitCompareResult,
} from "../shared/git";
import type { GitPullStrategy } from "../shared/settings";
import type { GitStore, GitStoreState } from "../services/git-store";
import { describeError } from "../shared/errors";
import { relativeToRoot } from "../utils/paths";
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
  /** 打开「比较」视图中的文件；target 为 null 表示目标为工作区。 */
  onOpenCompareFile(filePath: string, base: string, target: string | null): void;
  /** 冲突项只打开文件本身：冲突标记需在源码模式处理，不进入只读差异视图。 */
  onOpenConflictFile(path: string): void;
  /** 打开未保存文档：只切到编辑器，不保存、不进差异视图（磁盘上仍是旧内容）。 */
  onOpenDocument(path: string): void;
  /** 仓库内未保存文档；「未保存」分组据此列出，Git 操作仍只读取磁盘内容。 */
  dirtyFiles: Array<{ id: string; path: string }>;
  /** 可切换的工作区目录（多根工作区与工作区外的当前文件目录）。 */
  repos: Array<{ path: string; name: string }>;
  selectedRepo: string | null;
  onSelectRepo(path: string): void;
  /** 保存仓库内全部文档；返回 false 表示仍有文档未保存成功。 */
  onSaveAll(): Promise<boolean>;
  /** 设置里的默认拉取方式；决定确认窗口里「拉取方式」的初值，窗口内可临时改。 */
  pullStrategy: GitPullStrategy;
  /** 只记入通知历史、不弹气泡：用于同步结果留痕（结果已在同步窗口里呈现）。 */
  onRecord(kind: "info" | "error", message: string): void;
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

/** 比较视图的单字母状态映射到现有状态色块样式。 */
function compareKind(status: GitCompareFile["status"]): GitChange["kind"] {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
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

/**
 * 同步窗口中的分支值：短名右对齐；长名在自身区域内左右滚动，
 * 只有真正溢出时才出现细滚动条，避免短名下方多出一条装饰性细线。
 */
function SyncValue({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setOverflowing(element.scrollWidth > element.clientWidth + 1);
    update();
    // 容器宽度变化（窗口缩放、语言切换）后重新判断是否需要滑块。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      className={overflowing ? "git-sync-value is-overflowing" : "git-sync-value"}
      title={text}
    >
      <span className="git-sync-value-text">{text}</span>
    </span>
  );
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
      className={[
        "git-change-row",
        staticRow ? "git-change-row-static" : "",
        change.conflicted ? "git-change-row-conflict" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
            <Icon name="plus" size={13} />
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
            <Icon name="minus" size={13} />
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

/**
 * 分组标题：整块可点折叠，右侧可挂一个批量操作（全部暂存 / 全部保存）。
 * 折叠状态只影响列表，不影响计数与操作。
 */
function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle(): void;
  action?: ReactNode;
}) {
  return (
    <header>
      <button
        type="button"
        className="git-group-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <Icon name="chevron-down" size={11} />
        <span>{label}</span>
        <span className="git-group-count">{count}</span>
      </button>
      {action}
    </header>
  );
}

/** 未保存项只有路径：磁盘上是旧内容，因此不提供暂存/放弃等 Git 操作。 */
function UnsavedRow({ path, onOpen }: { path: string; onOpen(): void }) {
  return (
    <div
      className="git-change-row"
      title={path}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="git-change-status status-modified" title={t("有未保存修改")}>
        ●
      </span>
      <span className="git-change-path">{path}</span>
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
  onOpenCompareFile,
  onOpenConflictFile,
  onOpenDocument,
  dirtyFiles,
  repos,
  selectedRepo,
  onSelectRepo,
  onSaveAll,
  pullStrategy,
  onRecord,
}: GitPanelProps) {
  const [tab, setTab] = useState<"changes" | "history" | "compare">("changes");
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  /** 取消勾选或切换仓库时作废在途的 HEAD 提交信息读取。 */
  const amendTokenRef = useRef(0);
  /** 提交前的保存阶段尚未进入 store.busy，用本地状态防止重复提交。 */
  const [committing, setCommitting] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchWrapRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  /** pull/push 共用的同步窗口：确认 → 执行中 → 结果，三步都在同一个窗口里。 */
  const [syncDialog, setSyncDialog] = useState<"pull" | "push" | null>(null);
  /** 窗口阶段：执行中禁止关闭，结果态需用户点「完成」才收起。 */
  const [syncPhase, setSyncPhase] = useState<"confirm" | "running" | "done">("confirm");
  /** 结果态要展示的文案；失败时为完整的 Git 报错。 */
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** 拉取窗口内对「拉取方式」的临时覆盖；null 表示沿用设置里的值。 */
  const [strategyOverride, setStrategyOverride] = useState<GitPullStrategy | null>(null);
  const [syncForce, setSyncForce] = useState(false);
  /** 设置远程地址对话框：入口在工具栏，既能首次配置，也能修改当前远程的地址。 */
  const [remoteDialog, setRemoteDialog] = useState(false);
  const [remoteName, setRemoteName] = useState("origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteSaving, setRemoteSaving] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [detailHash, setDetailHash] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 折叠的分组 id；缺省即展开。只存内存，切仓库与持续刷新都保留用户的选择。 */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [baseDraft, setBaseDraft] = useState("HEAD~1");
  const [targetDraft, setTargetDraft] = useState("HEAD");
  const [appliedCompare, setAppliedCompare] = useState({ base: "HEAD~1", target: "HEAD" });
  const [compareResult, setCompareResult] = useState<GitCompareResult | null>(null);
  const [compareStatus, setCompareStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparePicker, setComparePicker] = useState<"base" | "target" | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerLoadingMore, setPickerLoadingMore] = useState(false);
  const compareTokenRef = useRef(0);
  /** 上一次比较使用的仓库与引用；相同则只静默刷新，不把列表换成“读取中”。 */
  const compareKeyRef = useRef("");
  const compareWrapRef = useRef<HTMLDivElement>(null);
  const compareTouchedRef = useRef(false);
  const previousRepoRef = useRef(selectedRepo);

  const snapshot = state.snapshot;
  const root = snapshot?.root ?? null;
  const changes = snapshot?.changes ?? [];
  const busy = Boolean(state.busy);
  /** 仓库内未保存文档；数量只用于确认文案，列表本身直接渲染。 */
  const dirtyCount = dirtyFiles.length;
  /**
   * 与 Git 分组一样按路径排序，避免顺序随打开先后跳动。
   * 用码位比较而不是 localeCompare：Git 的 status 输出就是码位序，
   * 用本地化排序会让中文文件名在两组里排出不同顺序。
   */
  const unsavedFiles = useMemo(
    () =>
      dirtyFiles
        .map((file) => ({
          ...file,
          relative: relativeToRoot(file.path, snapshot?.root ?? ""),
        }))
        .sort((a, b) => {
          if (a.relative === b.relative) return 0;
          return a.relative < b.relative ? -1 : 1;
        }),
    [dirtyFiles, snapshot?.root],
  );
  /** 分组折叠：缺省展开；只影响列表，不影响计数与批量操作。 */
  const toggleGroup = (key: string): void =>
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  /** 已配置的远程；为空说明这个仓库只做本地版本管理，联网操作一律不可用。 */
  const remotes = snapshot?.remotes ?? [];
  const hasRemote = remotes.length > 0;
  const currentRemote = pickRemote(remotes);
  const pushRemote = currentRemote?.name ?? null;
  // 拉取不依赖 behind：git pull 自身会先 fetch，只有「工作区干净 + 有上游 + 在分支上」才安全。
  // 未跟踪文件不拦，它们只在极少数情况下才会被远端提交覆盖。
  const hasTrackedChanges = changes.some((change) => !change.untracked);
  const pullBlockReason = !snapshot
    ? t("请先打开一个 Git 仓库")
    : snapshot.detached
      ? t("分离的 HEAD 无法拉取，请先切换到分支。")
      : !hasRemote
        ? t("仓库没有配置远程地址，无法拉取。")
        : !snapshot.upstream
          ? t("该分支没有上游分支，无法拉取。")
          : hasTrackedChanges
            ? t("工作区有未提交改动，请先提交或暂存。")
            : null;
  // 无待推送内容时禁用推送；无上游分支时仍保留首次推送入口。
  const pushBlockReason = !snapshot
    ? t("请先打开一个 Git 仓库")
    : snapshot.detached
      ? t("分离的 HEAD 无法推送，请先切换到分支。")
      : !hasRemote
        ? t("仓库没有配置远程地址，无法推送。")
        : snapshot.upstream && snapshot.ahead === 0
          ? t("没有需要推送的提交")
          : null;
  const fetchBlockReason = !snapshot
    ? t("请先打开一个 Git 仓库")
    : !hasRemote
      ? t("仓库没有配置远程地址，无法获取。")
      : null;
  const canPull = Boolean(snapshot && !pullBlockReason);
  const canPush = Boolean(snapshot && !pushBlockReason);
  const canFetch = Boolean(snapshot && !fetchBlockReason);
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
  // Amend 只改提交信息时允许零暂存提交（git commit --amend 本身支持）。
  const canCommit = (amend || stagedCount > 0) && message.trim().length > 0 && !busy && !committing;
  const commitHint = committing
    ? t("提交中…")
    : busy
      ? t("正在执行其他 Git 操作")
      : stagedCount === 0 && !amend
        ? t("请先暂存文件")
        : message.trim().length === 0
          ? t("请填写提交信息")
          : t("提交（Ctrl+Enter）");
  const localBranches = state.branches.filter((branch) => !branch.remote);

  // 切换仓库时清空提交草稿与 Amend，避免把上一个仓库的信息带到新仓库。
  useEffect(() => {
    if (previousRepoRef.current === selectedRepo) return;
    previousRepoRef.current = selectedRepo;
    amendTokenRef.current += 1;
    setMessage("");
    setAmend(false);
    setDetailHash(null);
    setLoadingMore(false);
    setBaseDraft("HEAD~1");
    setTargetDraft("HEAD");
    setAppliedCompare({ base: "HEAD~1", target: "HEAD" });
    setCompareResult(null);
    setCompareStatus("idle");
    setCompareError(null);
    setComparePicker(null);
    setPickerQuery("");
    compareTouchedRef.current = false;
    setTab("changes");
    setSyncDialog(null);
    setRemoteDialog(false);
    setRemoteUrl("");
    setRemoteError(null);
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

  // 同步窗口：按 Esc 关闭；执行中不响应，避免用户误以为命令被取消。
  useEffect(() => {
    if (!syncDialog) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || syncPhase === "running") return;
      setSyncDialog(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [syncDialog, syncPhase]);

  // 设置远程地址窗口：Esc 关闭；保存中不响应，避免让人误以为写入被取消。
  useEffect(() => {
    if (!remoteDialog) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || remoteSaving) return;
      setRemoteDialog(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [remoteDialog, remoteSaving]);

  // 比较视图的提交选择器：点击外部或按 Esc 关闭。
  useEffect(() => {
    if (!comparePicker) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !compareWrapRef.current?.contains(event.target)) {
        setComparePicker(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setComparePicker(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [comparePicker]);

  // 比较视图：按已应用的引用读取差异文件列表；提交/引用变化时重新读取。
  useEffect(() => {
    if (tab !== "compare" || !root) return;
    const base = appliedCompare.base.trim();
    const target = appliedCompare.target.trim();
    if (!base) return;
    if (target && target.toLowerCase() === base.toLowerCase()) {
      compareTokenRef.current += 1;
      setCompareResult(null);
      setCompareStatus("error");
      setCompareError(t("两侧引用相同"));
      return;
    }
    let cancelled = false;
    const token = ++compareTokenRef.current;
    const key = `${root}|${base}|${target}`;
    const refsChanged = compareKeyRef.current !== key;
    compareKeyRef.current = key;
    // 仓库状态刷新（如打开文件）时引用未变：保留现有结果，等新结果到达再替换。
    if (refsChanged) {
      setCompareStatus("loading");
      setCompareResult(null);
    }
    setCompareError(null);
    const timer = setTimeout(() => {
      void window.panda.git
        .compare({ root, base, target: target || undefined })
        .then((result) => {
          if (cancelled || token !== compareTokenRef.current) return;
          setCompareResult(result);
          setCompareStatus("ready");
        })
        .catch((error) => {
          if (cancelled || token !== compareTokenRef.current) return;
          setCompareResult(null);
          setCompareStatus("error");
          setCompareError(describeError(error));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, root, appliedCompare, state.version, state.snapshot]);

  // 仓库只有一个提交时，HEAD~1 不存在：自动退回 HEAD ⇄ 工作区。
  useEffect(() => {
    if (tab !== "compare" || compareTouchedRef.current || state.commits.length === 0) return;
    if (
      state.commits.length < 2 &&
      appliedCompare.base === "HEAD~1" &&
      appliedCompare.target === "HEAD"
    ) {
      setBaseDraft("HEAD");
      setTargetDraft("");
      setAppliedCompare({ base: "HEAD", target: "" });
    }
  }, [tab, state.commits, appliedCompare]);

  const filteredPickerCommits = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    if (!query) return state.commits;
    return state.commits.filter(
      (commit) =>
        commit.hash.toLowerCase().startsWith(query) ||
        commit.shortHash.toLowerCase().startsWith(query) ||
        commit.subject.toLowerCase().includes(query),
    );
  }, [state.commits, pickerQuery]);

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

  const confirmDirty = (action: "checkout" | "commit"): boolean => {
    if (dirtyCount === 0) return true;
    if (action === "commit") {
      return window.confirm(
        t(
          "仓库内有 {0} 个未保存文档，提交只会包含已暂存内容。是否先保存全部文档？",
          dirtyCount,
        ),
      );
    }
    return window.confirm(
      t("仓库内有 {0} 个未保存文档，切换分支只使用磁盘内容。是否继续？", dirtyCount),
    );
  };

  /** 同步目标的远端引用：有上游用上游全名，无上游按「远端/分支」预估远端地址。 */
  const syncTargetRef = snapshot?.upstream
    ? snapshot.upstream
    : snapshot?.branch && pushRemote
      ? `${pushRemote}/${snapshot.branch}`
      : t("未知");

  /** 本次拉取方式：默认取设置，窗口内选择只覆盖本次执行（不写回设置）。 */
  const syncStrategy: GitPullStrategy = strategyOverride ?? pullStrategy;
  /** 变基态决定提示条措辞；「遵循 Git 配置」不预设结果，措辞保持中性。 */
  const syncRebase = syncStrategy === "rebase";

  /** 只有强制推送会改写远端历史；拉取没有强制模式，提示条保持普通态。 */
  const syncWarn = syncDialog === "push" && syncForce;

  /** 标题随阶段变化：确认是「拉取提交」，执行中「正在拉取」，结束「拉取完成 / 拉取失败」。 */
  const syncTitle = (() => {
    if (!syncDialog) return "";
    const pull = syncDialog === "pull";
    if (syncPhase === "running") return pull ? t("正在拉取") : t("正在推送");
    if (syncPhase === "done") {
      const ok = syncResult?.ok !== false;
      if (pull) return ok ? t("拉取完成") : t("拉取失败");
      return ok ? t("推送完成") : t("推送失败");
    }
    return pull ? t("拉取提交") : t("推送提交");
  })();

  /** 执行中那句说明：只说正在做什么，不预设结果。 */
  const syncRunningText =
    syncDialog === "pull"
      ? t("正在从远端拉取提交，请稍候…")
      : t("正在向远端推送提交，请稍候…");

  /** 打开同步窗口；选项回到默认（拉取取设置里的拉取方式，推送不勾选强制），阶段回到确认。 */
  const openSyncDialog = (kind: "pull" | "push"): void => {
    if (busy) return;
    // 按钮已按条件禁用；这里再拦一次，避免快捷键等路径绕过检查。
    if (kind === "pull" && pullBlockReason) {
      window.alert(pullBlockReason);
      return;
    }
    // 分离的 HEAD、没有远程、没有待推送提交都在这里拦掉，避免执行裸 git push 后被动报错。
    if (kind === "push" && pushBlockReason) {
      window.alert(pushBlockReason);
      return;
    }
    // 每次打开都回到默认：拉取取设置里的拉取方式（清掉上次的临时覆盖），推送不勾选强制。
    setStrategyOverride(null);
    setSyncForce(false);
    setSyncPhase("confirm");
    setSyncResult(null);
    setSyncDialog(kind);
  };

  /** 关闭同步窗口；只有确认态与结果态可关，执行态由界面拦在外面。 */
  const closeSyncDialog = (): void => {
    setSyncDialog(null);
  };

  /**
   * 确认后窗口不关闭：先显示执行中，结束后在同一窗口给出成功/失败结果，
   * 由用户点「完成」收起；结果同时写入通知历史（失败不再额外弹气泡）。
   */
  const confirmSync = (): void => {
    const kind = syncDialog;
    if (!kind || syncPhase !== "confirm") return;
    // store 在已有操作进行时会静默跳过，先挡住，避免窗口误报「完成」。
    if (busy) return;
    // 执行期不再读取界面状态，先把本次参数与计数固定下来。
    const strategy = syncStrategy;
    const force = syncForce;
    const hasUpstream = Boolean(snapshot?.upstream);
    const behind = snapshot?.behind ?? 0;
    const ahead = snapshot?.ahead ?? 0;
    setSyncResult(null);
    setSyncPhase("running");

    const fail = (error: unknown): void => {
      const detail = describeError(error);
      // 历史记录是扁平列表，需要自带结果前缀；窗口标题已经说明失败，正文只放原始报错。
      onRecord(
        "error",
        kind === "pull" ? t("拉取失败：{0}", detail) : t("推送失败：{0}", detail),
      );
      setSyncResult({ ok: false, message: detail });
      setSyncPhase("done");
    };

    if (kind === "pull") {
      void store
        .pull(strategy)
        .then(() => {
          const message =
            behind > 0 ? t("已拉取 {0} 个提交。", behind) : t("拉取完成，已是最新。");
          onRecord("info", message);
          setSyncResult({ ok: true, message });
          setSyncPhase("done");
        })
        .catch(fail);
      return;
    }

    // 无上游分支时首次推送需同时设置上游（确认窗口里已明确提示）。
    void store
      .push(!hasUpstream, force)
      .then(() => {
        const message = force
          ? ahead > 0
            ? t("已强制推送 {0} 个提交。", ahead)
            : t("强制推送完成。")
          : ahead > 0
            ? t("已推送 {0} 个提交。", ahead)
            : t("推送完成。");
        onRecord("info", message);
        setSyncResult({ ok: true, message });
        setSyncPhase("done");
      })
      .catch(fail);
  };

  /**
   * 打开「设置远程地址」：有 remote 时定位到推送会用的那个并回填地址（改地址），
   * 没有时才从 origin + 空地址开始（首次配置）。错误每次都清空，避免带上一次的结果。
   */
  const openRemoteDialog = (): void => {
    setRemoteName(currentRemote?.name ?? "origin");
    setRemoteUrl(currentRemote?.url ?? "");
    setRemoteError(null);
    setRemoteSaving(false);
    setRemoteDialog(true);
  };

  /** 输入变化就清掉上一次的失败原因，避免旧报错挂在新内容下面。 */
  const touchRemote = (): void => {
    if (remoteError) setRemoteError(null);
  };

  /** 已有远程只改地址（set-url），没有才新增（remote add）；都不顺手推送。 */
  const submitRemote = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = remoteName.trim();
    const url = remoteUrl.trim();
    if (!name || !url || remoteSaving || busy) return;
    const existing = remotes.some((remote) => remote.name === name);
    // 只在新增时校验字符集：已有远程可能是 Git 允许、但不在白名单里的名字（如 a+b、中文），
    // 那种情况下名字由下拉给出，用户改不了，不该因此挡住改地址。
    if (!existing && !REMOTE_NAME_PATTERN.test(name)) {
      setRemoteError(t("远程名只能包含字母、数字、点、下划线与连字符。"));
      return;
    }
    setRemoteError(null);
    setRemoteSaving(true);
    void (existing ? store.setRemoteUrl(name, url) : store.addRemote(name, url))
      .then(() => {
        setRemoteDialog(false);
        onRecord(
          "info",
          existing ? t("已更新远程 {0} 的地址。", name) : t("已配置远程 {0}。", name),
        );
      })
      .catch((error) => setRemoteError(describeError(error)))
      .finally(() => setRemoteSaving(false));
  };

  const checkout = (branch: string): void => {
    setBranchOpen(false);
    if (branch === snapshot.branch) return;
    if (!confirmDirty("checkout")) return;
    void store.checkout(branch).catch(() => undefined);
  };

  /** 勾选 Amend 时载入 HEAD 的提交信息；取消勾选清空草稿。 */
  const toggleAmend = (checked: boolean): void => {
    const token = ++amendTokenRef.current;
    setAmend(checked);
    if (!checked) {
      setMessage("");
      return;
    }
    const head = state.commits[0];
    if (!root || !head) {
      setMessage("");
      return;
    }
    void window.panda.git
      .commitDetail({ root, hash: head.hash })
      .then((detail) => {
        if (token !== amendTokenRef.current) return;
        // 用原始完整信息（%B）回填，保留多行结构；subject（%s）会把第一段折叠成一行。
        setMessage(detail.rawMessage.trim());
      })
      .catch(() => {
        if (token === amendTokenRef.current) setMessage("");
      });
  };

  const runCommit = (): void => {
    const text = message.trim();
    if (!text || busy || committing) return;
    // Amend 且零暂存时跳过暂存检查，仅改写上次提交的信息。
    if (!amend && stagedCount === 0) return;
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
        amendTokenRef.current += 1;
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

  /** 应用一个比较引用；target 为空表示工作区。 */
  const applyCompareRef = (which: "base" | "target", value: string): void => {
    compareTouchedRef.current = true;
    const ref = value.trim();
    if (which === "base") {
      if (!ref) return;
      setBaseDraft(ref);
      setAppliedCompare((current) => ({ ...current, base: ref }));
    } else {
      setTargetDraft(ref);
      setAppliedCompare((current) => ({ ...current, target: ref }));
    }
    setComparePicker(null);
    setPickerQuery("");
  };

  const swapCompare = (): void => {
    compareTouchedRef.current = true;
    const base = appliedCompare.base;
    const target = appliedCompare.target.trim();
    if (!target) return;
    setBaseDraft(target);
    setTargetDraft(base);
    setAppliedCompare({ base: target, target: base });
    setComparePicker(null);
  };

  const openCompareFileRow = (file: GitCompareFile): void => {
    if (file.status === "D" || file.binary) return;
    const base = appliedCompare.base.trim();
    if (!base) return;
    onOpenCompareFile(joinPath(root, file.path), base, appliedCompare.target.trim() || null);
  };

  /** 提交选择器；base 与 target 共用，target 额外提供「工作区」。 */
  const commitPickerPanel = (which: "base" | "target") => (
    <div className="git-compare-picker" role="listbox" aria-label={t("选择提交")}>
      {which === "target" && (
        <button
          type="button"
          role="option"
          aria-selected={appliedCompare.target.trim() === ""}
          className={
            appliedCompare.target.trim() === ""
              ? "git-compare-picker-row active"
              : "git-compare-picker-row"
          }
          onClick={() => applyCompareRef("target", "")}
        >
          <span className="git-compare-picker-subject">{t("工作区")}</span>
          <span className="git-compare-picker-meta">{t("磁盘内容（忽略未保存修改）")}</span>
        </button>
      )}
      {pickerQuery.trim().length > 0 && (
        <button
          type="button"
          role="option"
          aria-selected={false}
          className="git-compare-picker-row"
          onClick={() => applyCompareRef(which, pickerQuery)}
        >
          <span className="git-compare-picker-subject">
            {t("使用「{0}」", pickerQuery.trim())}
          </span>
          <span className="git-compare-picker-meta">{t("分支、tag、HEAD~n 或 commit id")}</span>
        </button>
      )}
      {filteredPickerCommits.map((commit) => (
        <button
          key={commit.hash}
          type="button"
          role="option"
          aria-selected={false}
          className="git-compare-picker-row"
          onClick={() => applyCompareRef(which, commit.shortHash)}
        >
          <span className="git-compare-picker-subject">{commit.subject || commit.shortHash}</span>
          <span className="git-compare-picker-meta">
            {commit.shortHash} · {formatCommitDate(commit.date)}
          </span>
        </button>
      ))}
      {filteredPickerCommits.length === 0 && !pickerQuery.trim() && (
        <p className="git-compare-picker-empty">{t("还没有提交")}</p>
      )}
      {state.commitsHasMore && (
        <button
          type="button"
          className="git-compare-picker-more"
          disabled={pickerLoadingMore || busy}
          onClick={() => {
            setPickerLoadingMore(true);
            void store.loadMoreCommits().finally(() => setPickerLoadingMore(false));
          }}
        >
          {pickerLoadingMore ? t("读取中…") : t("加载更多")}
        </button>
      )}
    </div>
  );

  return (
    <div className="git-panel" aria-busy={busy}>
      {repoPicker}
      <div className="git-panel-header">
        <div className="git-branch-wrap">
          {/* 与工作区选择栏同一套构成：左侧图标在框外，右侧是整宽的字段。 */}
          <Icon name="git" size={12} />
          <div className="git-branch-field" ref={branchWrapRef}>
            <button
              type="button"
              className="git-branch-button"
              aria-expanded={branchOpen}
              title={snapshot.detached ? t("detached HEAD") : (snapshot.branch ?? "")}
              onClick={() => setBranchOpen((open) => !open)}
            >
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
        </div>
        <div className="git-sync-actions">
          {snapshot.ahead > 0 && (
            <span
              className="git-ahead"
              title={t("领先上游 {0} 个提交（待推送）", snapshot.ahead)}
            >
              ↑{snapshot.ahead}
            </span>
          )}
          {snapshot.behind > 0 && (
            <span
              className="git-behind"
              title={t("落后上游 {0} 个提交（待拉取）", snapshot.behind)}
            >
              ↓{snapshot.behind}
            </span>
          )}
          {(snapshot.ahead > 0 || snapshot.behind > 0) && (
            <span className="git-sync-divider" aria-hidden="true" />
          )}
          {/* 禁用按钮在 Chromium 下不显示 title，用外层承载原因提示。 */}
          <span className="git-sync-slot" title={fetchBlockReason ?? t("获取（fetch）")}>
            <button
              type="button"
              className="git-icon-button"
              title={fetchBlockReason ?? t("获取（fetch）")}
              aria-label={t("获取")}
              disabled={busy || !canFetch}
              onClick={() => void store.fetch().catch(() => undefined)}
            >
              <Icon name="arrow-down" size={12} />
            </button>
          </span>
          <span className="git-sync-slot" title={pullBlockReason ?? t("拉取（git pull）")}>
            <button
              type="button"
              className="git-icon-button"
              title={pullBlockReason ?? t("拉取（git pull）")}
              aria-label={t("拉取")}
              disabled={busy || !canPull}
              onClick={() => openSyncDialog("pull")}
            >
              <Icon name="cloud-download" size={12} />
            </button>
          </span>
          <span className="git-sync-slot" title={pushBlockReason ?? t("推送（git push）")}>
            <button
              type="button"
              className="git-icon-button"
              title={pushBlockReason ?? t("推送（git push）")}
              aria-label={t("推送")}
              disabled={busy || !canPush}
              onClick={() => openSyncDialog("push")}
            >
              <Icon name="cloud-upload" size={12} />
            </button>
          </span>
          <span className="git-sync-divider" aria-hidden="true" />
          {/* 远程配置与同步操作分开放：它改的是配置，不是一次网络操作。 */}
          <span className="git-sync-slot" title={t("设置远程地址")}>
            <button
              type="button"
              className="git-icon-button"
              title={t("设置远程地址")}
              aria-label={t("设置远程地址")}
              disabled={busy}
              onClick={openRemoteDialog}
            >
              <Icon name="link" size={12} />
            </button>
          </span>
          <span className="git-sync-divider" aria-hidden="true" />
          <button
            type="button"
            className="git-icon-button"
            title={t("刷新")}
            aria-label={t("刷新")}
            disabled={busy}
            onClick={() => void store.refresh()}
          >
            <Icon name="refresh" size={12} />
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "compare"}
          className={tab === "compare" ? "sidebar-tab active" : "sidebar-tab"}
          onClick={() => setTab("compare")}
        >
          {t("比较")}
        </button>
      </div>

      {tab === "compare" ? (
        <div className="git-panel-body git-compare">
          <div className="git-compare-controls" ref={compareWrapRef}>
            <div className="git-compare-field">
              <div className="git-compare-label-row">
                <span className="git-compare-label">{t("基准")}</span>
                <button
                  type="button"
                  className="git-compare-swap"
                  aria-label={t("交换比较方向")}
                  title={t("交换比较方向")}
                  disabled={!appliedCompare.target.trim()}
                  onClick={swapCompare}
                >
                  ⇄
                </button>
              </div>
              <div className="git-compare-input-row">
                <input
                  className="git-compare-input"
                  aria-label={t("基准")}
                  value={baseDraft}
                  placeholder="HEAD~1 / 分支 / commit"
                  onFocus={() => {
                    setComparePicker("base");
                    setPickerQuery(baseDraft);
                  }}
                  onChange={(event) => {
                    compareTouchedRef.current = true;
                    setBaseDraft(event.target.value);
                    setComparePicker("base");
                    setPickerQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyCompareRef("base", baseDraft);
                    } else if (event.key === "Escape") {
                      setComparePicker(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="git-icon-button"
                  aria-label={t("选择提交")}
                  title={t("选择提交")}
                  onClick={() => {
                    setComparePicker(comparePicker === "base" ? null : "base");
                    setPickerQuery(baseDraft);
                  }}
                >
                  <Icon name="chevron-down" size={12} />
                </button>
                {comparePicker === "base" && commitPickerPanel("base")}
              </div>
            </div>
            <div className="git-compare-field">
              <div className="git-compare-label-row">
                <span className="git-compare-label">{t("目标")}</span>
              </div>
              <div className="git-compare-input-row">
                <input
                  className="git-compare-input"
                  aria-label={t("目标")}
                  value={targetDraft}
                  placeholder={t("工作区（留空）")}
                  onFocus={() => {
                    setComparePicker("target");
                    setPickerQuery(targetDraft);
                  }}
                  onChange={(event) => {
                    compareTouchedRef.current = true;
                    setTargetDraft(event.target.value);
                    setComparePicker("target");
                    setPickerQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyCompareRef("target", targetDraft);
                    } else if (event.key === "Escape") {
                      setComparePicker(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="git-icon-button"
                  aria-label={t("选择提交")}
                  title={t("选择提交")}
                  onClick={() => {
                    setComparePicker(comparePicker === "target" ? null : "target");
                    setPickerQuery(targetDraft);
                  }}
                >
                  <Icon name="chevron-down" size={12} />
                </button>
                {comparePicker === "target" && commitPickerPanel("target")}
              </div>
            </div>
          </div>

          {compareStatus === "error" && (
            <div className="banner banner-warning git-error" role="alert">
              <span className="banner-text">{compareError ?? t("比较失败")}</span>
            </div>
          )}
          {compareStatus === "loading" && (
            <p className="placeholder git-compare-empty">{t("读取中…")}</p>
          )}
          {compareStatus === "ready" && compareResult && (
            <>
              <div className="git-compare-summary">
                <span>{t("变更文件 {0}", compareResult.files.length)}</span>
                <span className="git-compare-stats">
                  <span className="git-diff-add">+{compareResult.additions}</span>{" "}
                  <span className="git-diff-del">−{compareResult.deletions}</span>
                </span>
              </div>
              {compareResult.files.length === 0 && (
                <p className="placeholder git-compare-empty">{t("没有差异")}</p>
              )}
              <div className="git-compare-files">
                {compareResult.files.map((file) => {
                  const renamed = file.status === "R" || file.status === "C";
                  const disabled = file.status === "D" || file.binary || renamed;
                  return (
                    <button
                      key={`${file.origPath ?? ""}:${file.path}`}
                      type="button"
                      className={disabled ? "git-compare-file disabled" : "git-compare-file"}
                      disabled={disabled}
                      title={
                        disabled
                          ? file.binary
                            ? t("二进制文件不支持差异预览")
                            : renamed
                              ? t("重命名/复制文件暂不支持预览")
                              : t("已删除文件暂不支持预览")
                          : file.path
                      }
                      onClick={() => openCompareFileRow(file)}
                    >
                      <span className={`git-change-status status-${compareKind(file.status)}`}>
                        {file.status}
                      </span>
                      <span className="git-compare-path">
                        {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                      </span>
                      <span className="git-compare-stats">
                        {file.binary ? t("二进制") : `+${file.additions} −${file.deletions}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {compareStatus === "idle" && !compareResult && (
            <p className="placeholder git-compare-empty">
              {t("选择两个版本后显示变更文件")}
            </p>
          )}
        </div>
      ) : tab === "changes" ? (
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
                  disabled={state.commits.length === 0}
                  onChange={(event) => toggleAmend(event.target.checked)}
                />
                <span>{t("修订上次提交")}</span>
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

          {changes.length === 0 && dirtyFiles.length === 0 && !state.loading && (
            <p className="placeholder git-clean">{t("工作区没有变更")}</p>
          )}

          {groups.conflicts.length > 0 && (
            <section className="git-change-group">
              <GroupHeader
                label={t("冲突")}
                count={groups.conflicts.length}
                collapsed={Boolean(collapsedGroups.conflicts)}
                onToggle={() => toggleGroup("conflicts")}
              />
              {!collapsedGroups.conflicts &&
                groups.conflicts.map((change) => (
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

          {/* 未保存排在 Git 分组之前：它描述内存状态，其它分组描述磁盘状态。 */}
          {unsavedFiles.length > 0 && (
            <section className="git-change-group">
              <GroupHeader
                label={t("未保存")}
                count={unsavedFiles.length}
                collapsed={Boolean(collapsedGroups.unsaved)}
                onToggle={() => toggleGroup("unsaved")}
                action={
                  <button
                    type="button"
                    className="git-group-action"
                    disabled={busy}
                    onClick={() => void onSaveAll().catch(() => undefined)}
                  >
                    {t("全部保存")}
                  </button>
                }
              />
              {!collapsedGroups.unsaved &&
                unsavedFiles.map((file) => (
                  <UnsavedRow
                    key={file.id}
                    path={file.relative}
                    onOpen={() => onOpenDocument(file.path)}
                  />
                ))}
            </section>
          )}

          {groups.untracked.length > 0 && (
            <section className="git-change-group">
              <GroupHeader
                label={t("未跟踪")}
                count={groups.untracked.length}
                collapsed={Boolean(collapsedGroups.untracked)}
                onToggle={() => toggleGroup("untracked")}
                action={
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
                }
              />
              {!collapsedGroups.untracked &&
                groups.untracked.map((change) => (
                  <ChangeRow
                    key={change.path}
                    change={change}
                    onOpen={openWorktreeChange}
                    onStage={(target) =>
                      void store.stage(changePaths(target)).catch(() => undefined)
                    }
                    onDiscard={(target) => confirmDiscard([target])}
                    disabled={busy}
                  />
                ))}
            </section>
          )}

          {groups.unstaged.length > 0 && (
            <section className="git-change-group">
              <GroupHeader
                label={t("更改")}
                count={groups.unstaged.length}
                collapsed={Boolean(collapsedGroups.unstaged)}
                onToggle={() => toggleGroup("unstaged")}
                action={
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
                }
              />
              {!collapsedGroups.unstaged &&
                groups.unstaged.map((change) => (
                  <ChangeRow
                    key={change.path}
                    change={change}
                    onOpen={openWorktreeChange}
                    onStage={(target) =>
                      void store.stage(changePaths(target)).catch(() => undefined)
                    }
                    onDiscard={(target) => confirmDiscard([target])}
                    disabled={busy}
                  />
                ))}
            </section>
          )}

          {groups.staged.length > 0 && (
            <section className="git-change-group">
              <GroupHeader
                label={t("已暂存")}
                count={groups.staged.length}
                collapsed={Boolean(collapsedGroups.staged)}
                onToggle={() => toggleGroup("staged")}
                action={
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
                }
              />
              {!collapsedGroups.staged &&
                groups.staged.map((change) => (
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
          {state.commitsHasMore && (
            <div className="git-history-more">
              <button
                type="button"
                className="button small ghost"
                disabled={busy || loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void store.loadMoreCommits().finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? t("加载中…") : t("加载更多")}
              </button>
            </div>
          )}
        </div>
      )}

      {state.busy && (
        <div className="git-busy" role="status" aria-live="polite">
          {t("{0}…", t(state.busy))}
        </div>
      )}

      {syncDialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            // 执行中不允许关窗：命令已经在跑，关掉只会让人误以为取消了。
            if (event.target === event.currentTarget && syncPhase !== "running") {
              closeSyncDialog();
            }
          }}
        >
          <div
            className="modal git-sync-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={syncPhase === "running"}
            aria-label={syncTitle}
          >
            <header className="git-sync-head">
              <h2>{syncTitle}</h2>
            </header>
            {syncPhase === "confirm" ? (
              <>
                <div className="git-sync-body">
                  <div className="git-sync-box">
                    <div className="git-sync-meta">
                      <div className="git-sync-meta-row">
                        <span className="git-sync-meta-icon" aria-hidden="true">
                          <Icon name="branch" size={14} />
                        </span>
                        <span className="git-sync-meta-label">{t("本地分支")}</span>
                        <SyncValue text={snapshot?.branch ?? t("未知")} />
                      </div>
                      <div className="git-sync-meta-row">
                        <span className="git-sync-meta-icon" aria-hidden="true">
                          <Icon
                            name={syncDialog === "pull" ? "cloud-download" : "cloud-upload"}
                            size={14}
                          />
                        </span>
                        <span className="git-sync-meta-label">{t("远端分支")}</span>
                        <SyncValue text={syncTargetRef} />
                      </div>
                    </div>

                    <div
                      className={
                        syncWarn ? "git-sync-banner git-sync-banner-warn" : "git-sync-banner"
                      }
                      role={syncWarn ? "alert" : undefined}
                    >
                      <Icon
                        name={
                          syncWarn
                            ? "alert-triangle"
                            : syncDialog === "pull"
                              ? "cloud-download"
                              : "cloud-upload"
                        }
                        size={15}
                      />
                      <span>
                        {syncWarn
                          ? t("强制推送会改写远端历史，其他协作者的提交可能丢失。")
                          : syncDialog === "pull"
                            ? (snapshot?.behind ?? 0) > 0
                              ? syncRebase
                                ? t("将以变基方式拉取远端 {0} 个提交。", snapshot?.behind ?? 0)
                                : t("将从远端拉取 {0} 个提交到当前分支。", snapshot?.behind ?? 0)
                              : syncRebase
                                ? t("将先获取远端最新提交，若有新提交则以变基方式应用到当前分支。")
                                : t("将先获取远端最新提交，若有新提交再按 Git 配置更新当前分支。")
                            : snapshot.upstream
                              ? t("将向远端推送 {0} 个提交。", snapshot.ahead)
                              : // 无上游时没有 remote-tracking ref 可比较，ahead 恒为 0，
                                // 不能拿它报数量，只说推送目标。
                                t("将推送当前分支到远端 {0}。", syncTargetRef)}
                      </span>
                    </div>
                  </div>

                  {/* 首次推送必然同时设置上游，提前说明，避免用户不知道远端会多一个分支。 */}
                  {syncDialog === "push" && !snapshot?.upstream && (
                    <p className="git-sync-note">
                      {t("该分支尚无上游，推送时将同时设置上游。")}
                    </p>
                  )}
                  {syncDialog === "pull" && dirtyCount > 0 && (
                    <p className="git-sync-note">
                      {t("仓库内有 {0} 个未保存文档，拉取只使用磁盘内容。", dirtyCount)}
                    </p>
                  )}

                  {syncDialog === "push" ? (
                    <label className="git-sync-option">
                      <input
                        type="checkbox"
                        checked={syncForce}
                        onChange={(event) => setSyncForce(event.target.checked)}
                      />
                      <span>{t("强制（git push --force）")}</span>
                    </label>
                  ) : (
                    <div className="git-sync-option git-sync-option-select">
                      <span>{t("拉取方式")}</span>
                      <select
                        className="git-sync-select"
                        aria-label={t("拉取方式")}
                        value={syncStrategy}
                        onChange={(event) =>
                          setStrategyOverride(event.target.value as GitPullStrategy)
                        }
                      >
                        <option value="config">{t("遵循 Git 配置")}</option>
                        <option value="rebase">{t("变基")}</option>
                      </select>
                    </div>
                  )}
                </div>
                <footer className="modal-footer">
                  <button
                    type="button"
                    className="button ghost"
                    onClick={closeSyncDialog}
                  >
                    {t("取消")}
                  </button>
                  <button
                    type="button"
                    className={syncWarn ? "button danger" : "button primary"}
                    onClick={confirmSync}
                  >
                    {t("确认")}
                  </button>
                </footer>
              </>
            ) : (
              <>
                <div
                  className={
                    syncResult && !syncResult.ok
                      ? "git-sync-body git-sync-status is-error"
                      : "git-sync-body git-sync-status"
                  }
                >
                  <span className="git-sync-status-icon" aria-hidden="true">
                    {syncPhase === "running" ? (
                      <span className="git-sync-spinner" />
                    ) : (
                      <Icon name={syncResult?.ok ? "check" : "alert-triangle"} size={18} />
                    )}
                  </span>
                  <p
                    className="git-sync-status-text"
                    role={syncResult && !syncResult.ok ? "alert" : "status"}
                  >
                    {syncPhase === "running" ? syncRunningText : syncResult?.message}
                  </p>
                </div>
                <footer className="modal-footer">
                  {syncPhase === "running" ? (
                    <button type="button" className="button primary" disabled>
                      {t("处理中…")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button primary"
                      autoFocus
                      onClick={closeSyncDialog}
                    >
                      {t("完成")}
                    </button>
                  )}
                </footer>
              </>
            )}
          </div>
        </div>
      )}

      {remoteDialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            // 保存中不关窗：命令已经发出，关掉只会让人以为没写进去。
            if (event.target === event.currentTarget && !remoteSaving) setRemoteDialog(false);
          }}
        >
          <form
            className="modal git-remote-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("设置远程地址")}
            aria-busy={remoteSaving}
            onSubmit={submitRemote}
          >
            <header className="git-sync-head">
              <h2>{t("设置远程地址")}</h2>
            </header>
            <div className="git-remote-body">
              <label className="git-remote-field">
                <span>{t("远程名")}</span>
                {/* 已有远程时只能从列表里选：改的是它的地址，不是再造一个同义远程。 */}
                {hasRemote ? (
                  <select
                    className="git-remote-input"
                    value={remoteName}
                    disabled={remoteSaving}
                    onChange={(event) => {
                      touchRemote();
                      const name = event.target.value;
                      setRemoteName(name);
                      setRemoteUrl(remotes.find((remote) => remote.name === name)?.url ?? "");
                    }}
                  >
                    {remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>
                        {remote.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="git-remote-input"
                    value={remoteName}
                    maxLength={64}
                    disabled={remoteSaving}
                    onChange={(event) => {
                      touchRemote();
                      setRemoteName(event.target.value);
                    }}
                  />
                )}
              </label>
              <label className="git-remote-field">
                <span>{t("仓库地址")}</span>
                {/* 地址是必填项；名字可能已经有值，焦点放在更容易改错的地方。 */}
                <input
                  className="git-remote-input"
                  autoFocus
                  value={remoteUrl}
                  maxLength={2048}
                  disabled={remoteSaving}
                  placeholder="https://example.com/repo.git"
                  onChange={(event) => {
                    touchRemote();
                    setRemoteUrl(event.target.value);
                  }}
                />
              </label>
              {remoteError && (
                <p className="git-remote-error" role="alert">
                  {remoteError}
                </p>
              )}
              <p className="git-remote-hint">
                {hasRemote
                  ? t("只修改远程地址，不会自动推送。")
                  : t("只写入远程地址，不会自动推送；首次推送时会同时设置上游分支。")}
              </p>
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="button ghost"
                disabled={remoteSaving}
                onClick={() => setRemoteDialog(false)}
              >
                {t("取消")}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={remoteSaving || busy || !remoteName.trim() || !remoteUrl.trim()}
              >
                {remoteSaving ? t("保存中…") : t("保存")}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
