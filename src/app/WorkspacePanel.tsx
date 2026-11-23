import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { FileRef } from "../shared/ipc";
import { t } from "../i18n";
import type { WorkspaceNode, WorkspaceStore } from "../services/workspace-store";
import { copyText } from "../utils/clipboard";
import { relativeToRoot } from "../utils/paths";
import { Icon, fileIconForPath, type IconName } from "./icons";

interface WorkspacePanelProps {
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  /** 打开文件选择器，把文件打开为文档。 */
  onOpenFiles(): void;
  /** 拖入的普通文件按路径打开为文档。 */
  onOpenPath(filePath: string, rootId: string | null): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  /** 当前活动的文档路径，用于在目录树中高亮。 */
  activePath: string | null;
  /** 大纲标签页的内容。 */
  outline?: ReactNode;
  /** 源代码管理标签页的内容。 */
  sourceControl?: ReactNode;
  /** 源代码管理标签上的变更数量。 */
  sourceControlCount?: number;
  /** 当前激活的侧栏标签（由 App 层持有，折叠后仍可保留）。 */
  tab: SidebarTab;
  /** 请求切换侧栏标签。 */
  onTabChange(tab: SidebarTab): void;
  /** 点击 tab 栏右端的折叠按钮。 */
  onCollapse(): void;
  /** 复制路径等操作的成功/失败提示。 */
  onNotice(kind: "info" | "error", message: string): void;
}

export type SidebarTab = "files" | "outline" | "source-control";

/** 每个侧栏标签对应的图标，供展开的 tab 栏与折叠后的竖列 rail 共用。 */
export const SIDEBAR_TAB_ICON: Record<SidebarTab, IconName> = {
  files: "folder-open",
  outline: "list",
  "source-control": "git",
};

interface PromptState {
  title: string;
  initial: string;
  submit(value: string): void;
}

/** 行级扩展菜单条目；separator 渲染为分隔线。 */
type TreeMenuEntry =
  | { type: "separator" }
  | { type: "item"; label: string; icon: IconName; action(): void };

/**
 * 复制路径与相对路径菜单项（一组，位于删除项上方并以分隔线隔开）。
 * 根目录自身作为「子项」时相对路径为 "."，由 relativeToRoot 处理。
 */
function copyPathEntries(
  path: string,
  rootPath: string,
  onNotice: (kind: "info" | "error", message: string) => void,
): TreeMenuEntry[] {
  const copy = (text: string, done: string): void => {
    void copyText(text).then((ok) => {
      onNotice(ok ? "info" : "error", ok ? done : t("复制失败"));
    });
  };
  return [
    { type: "separator" },
    {
      type: "item",
      label: t("复制路径"),
      icon: "copy",
      action: () => copy(path, t("已复制路径：{0}", path)),
    },
    {
      type: "item",
      label: t("复制相对路径"),
      icon: "copy",
      action: () => {
        const relative = relativeToRoot(path, rootPath);
        copy(relative, t("已复制相对路径：{0}", relative));
      },
    },
    { type: "separator" },
  ];
}

/** 目录/文件行的「扩展」下拉菜单（图标按钮 + 菜单项列表）。 */
function TreeMenu({
  open,
  label,
  onToggle,
  onClose,
  entries,
}: {
  open: boolean;
  label: string;
  onToggle(): void;
  onClose(): void;
  entries: TreeMenuEntry[];
}) {
  return (
    <div className="tree-menu-wrap">
      <button
        type="button"
        className={open ? "tree-action active" : "tree-action"}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name="more-vertical" size={13} />
      </button>
      {open && (
        <div className="tree-menu" role="menu" aria-label={label}>
          {entries.map((entry, index) =>
            entry.type === "separator" ? (
              <div key={index} className="tree-menu-separator" role="separator" />
            ) : (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
                className="tree-menu-item"
                onClick={() => {
                  onClose();
                  entry.action();
                }}
              >
                <Icon name={entry.icon} size={13} className="tree-menu-icon" />
                <span>{entry.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({
  node,
  depth,
  rootId,
  rootPath,
  store,
  activePath,
  menuPath,
  setMenuPath,
  onOpenFile,
  onRenamed,
  onDeleted,
  askName,
  onNotice,
}: {
  node: WorkspaceNode;
  depth: number;
  rootId: string;
  /** 所属工作区根目录绝对路径，用于计算相对路径。 */
  rootPath: string;
  store: WorkspaceStore;
  activePath: string | null;
  /** 当前展开扩展菜单的行路径；同一时间只开一个菜单。 */
  menuPath: string | null;
  setMenuPath(path: string | null): void;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  askName(title: string, initial: string, submit: (value: string) => void): void;
  onNotice(kind: "info" | "error", message: string): void;
}) {
  const rename = (): void => {
    askName(t("将“{0}”重命名为", node.name), node.name, (next) => {
      if (!next || next === node.name) return;
      void store.renameNode(node.path, next).then((ref) => {
        if (ref) onRenamed(node.path, ref);
      });
    });
  };

  const remove = (): void => {
    const message =
      node.kind === "dir"
        ? t("确定删除文件夹“{0}”及其全部内容吗？", node.name)
        : t("确定删除文件“{0}”吗？", node.name);
    if (!window.confirm(message)) return;
    void store.deleteNode(node.path, node.kind === "dir").then((ok) => {
      if (ok) onDeleted(node.path, node.kind === "dir");
    });
  };

  /** 在该目录下新建；完成后确保目录展开以展示新条目。 */
  const createIn = (kind: "file" | "dir"): void => {
    askName(kind === "dir" ? t("新文件夹名称") : t("新文件名"), "", (name) => {
      if (!name) return;
      void store.createNode(node.path, kind, name).then(() => void store.expand(node.path));
    });
  };

  const menuOpen = menuPath === node.path;
  const menuEntries: TreeMenuEntry[] =
    node.kind === "dir"
      ? [
          { type: "item", label: t("新建文件"), icon: "file-plus", action: () => createIn("file") },
          { type: "item", label: t("新建目录"), icon: "folder-plus", action: () => createIn("dir") },
          { type: "separator" },
          { type: "item", label: t("重命名"), icon: "pencil", action: rename },
          {
            type: "item",
            label: t("在文件管理器中显示"),
            icon: "reveal",
            action: () => void store.reveal(node.path),
          },
          ...copyPathEntries(node.path, rootPath, onNotice),
          { type: "item", label: t("删除"), icon: "trash", action: remove },
        ]
      : [
          { type: "item", label: t("重命名"), icon: "pencil", action: rename },
          {
            type: "item",
            label: t("在文件管理器中显示"),
            icon: "reveal",
            action: () => void store.reveal(node.path),
          },
          ...copyPathEntries(node.path, rootPath, onNotice),
          { type: "item", label: t("删除"), icon: "trash", action: remove },
        ];

  const active = node.kind === "file" && activePath !== null && node.path === activePath;

  return (
    <>
      <div
        className={[
          "tree-row",
          node.kind === "dir" ? "dir" : "file",
          active ? "active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        role="treeitem"
        aria-expanded={node.kind === "dir" ? node.expanded : undefined}
        aria-current={active ? "page" : undefined}
      >
        {node.kind === "dir" ? (
          <button
            type="button"
            className="tree-toggle"
            aria-label={node.expanded ? t("折叠") : t("展开")}
            onClick={() => void store.toggle(node.path)}
          >
            {node.expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle placeholder" aria-hidden="true" />
        )}
        <span className="tree-icon" aria-hidden="true">
          <Icon name={node.kind === "dir" ? "folder" : fileIconForPath(node.path)} size={13} />
        </span>
        <button
          type="button"
          className="tree-name"
          data-node-kind={node.kind}
          title={node.path}
          onClick={() => (node.kind === "dir" ? void store.toggle(node.path) : onOpenFile(node, rootId))}
        >
          {node.name}
        </button>
        <span className="tree-actions">
          {node.kind === "dir" && (
            <button
              type="button"
              className="tree-action"
              title={t("刷新")}
              aria-label={t("刷新 {0}", node.name)}
              onClick={() => void store.refreshNode(node.path)}
            >
              <Icon name="refresh" size={13} />
            </button>
          )}
          <TreeMenu
            open={menuOpen}
            label={t("更多操作")}
            onToggle={() => setMenuPath(menuOpen ? null : node.path)}
            onClose={() => setMenuPath(null)}
            entries={menuEntries}
          />
        </span>
      </div>
      {node.kind === "dir" && node.expanded && node.children && (
        <div role="group">
          {node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              rootId={rootId}
              rootPath={rootPath}
              store={store}
              activePath={activePath}
              menuPath={menuPath}
              setMenuPath={setMenuPath}
              onOpenFile={onOpenFile}
              onRenamed={onRenamed}
              onDeleted={onDeleted}
              askName={askName}
              onNotice={onNotice}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** 左侧工作区侧栏：文件与大纲以标签页切换。见 doc/design.md §12.5、§15.1。 */
export function WorkspacePanel({
  store,
  onOpenFile,
  onOpenFiles,
  onOpenPath,
  onRenamed,
  onDeleted,
  activePath,
  outline,
  sourceControl,
  sourceControlCount,
  tab,
  onTabChange,
  onCollapse,
  onNotice,
}: WorkspacePanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => new Set());
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const previousRoot = useRef(state.roots[0]?.root.path ?? null);
  const filesRef = useRef<HTMLDivElement>(null);
  // 从文件树点开的路径：这类切换不发生滚动，避免点击时列表跳动。
  const treeOpenRef = useRef<string | null>(null);

  // 扩展菜单打开时，点击菜单外、按 Esc 或焦点移到菜单外（如显示页面）时关闭。
  useEffect(() => {
    if (!menuPath) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (event.target instanceof HTMLElement && event.target.closest(".tree-menu-wrap")) return;
      setMenuPath(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuPath(null);
    };
    // 焦点进入其它可聚焦区域（编辑器、预览等显示页面）时关闭菜单。
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && event.target.closest(".tree-menu-wrap")) return;
      setMenuPath(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [menuPath]);

  // 打开文件夹后自动切回文件视图；未打开工作区时默认显示大纲。
  useEffect(() => {
    const root = state.roots[0]?.root.path ?? null;
    if (root && root !== previousRoot.current) onTabChange("files");
    previousRoot.current = root;
  }, [state.roots, onTabChange]);

  // 把活动文件行滚动到文件栏视口中部。仅在切换文档/切换标签的路径上调用，
  // 用户手动展开/折叠不应改变视口。
  const scrollToActive = useCallback((): boolean => {
    const scroller = filesRef.current?.querySelector<HTMLElement>(".workspace-roots");
    const row = scroller?.querySelector<HTMLElement>(".tree-row.active");
    if (!scroller || !row) return false;
    const rowTop =
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const centered = rowTop - (scroller.clientHeight - row.offsetHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, centered) });
    return true;
  }, []);

  /** 文件夹下拉列表：展开并滚动到指定工作区根目录。 */
  const locateRoot = (rootPath: string): void => {
    setCollapsedRoots((current) => {
      if (!current.has(rootPath)) return current;
      const next = new Set(current);
      next.delete(rootPath);
      return next;
    });
    requestAnimationFrame(() => {
      const scroller = filesRef.current?.querySelector<HTMLElement>(".workspace-roots");
      if (!scroller) return;
      const section = [...scroller.querySelectorAll<HTMLElement>(".workspace-root")].find(
        (element) => element.dataset.rootPath === rootPath,
      );
      if (!section) return;
      const top =
        section.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, top) });
    });
  };

  // 当前标签切换后自动展开文件树的父目录，并展开被折叠的工作区根；
  // 展开完成后滚动定位（定位可能尚未展开父目录，行此时还未渲染）。
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    void (async () => {
      await store.revealPath(activePath);
      const key = (value: string): string => {
        const normalized = value.replace(/\\/g, "/").replace(/\/+$/u, "");
        return /^[a-zA-Z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
      };
      const target = key(activePath);
      const owner = store.getState().roots.find((entry) =>
        target.startsWith(`${key(entry.root.path)}/`),
      );
      if (owner) {
        setCollapsedRoots((current) => {
          if (!current.has(owner.root.path)) return current;
          const next = new Set(current);
          next.delete(owner.root.path);
          return next;
        });
      }
      if (cancelled || tab !== "files") return;
      if (treeOpenRef.current === activePath) {
        treeOpenRef.current = null;
        return;
      }
      requestAnimationFrame(() => {
        if (!cancelled) scrollToActive();
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, store, tab, scrollToActive]);

  const askName = (title: string, initial: string, submit: (value: string) => void): void => {
    setPromptValue(initial);
    setPrompt({ title, initial, submit });
  };

  const create = (rootPath: string, kind: "file" | "dir"): void => {
    askName(kind === "dir" ? t("新文件夹名称") : t("新文件名"), "", (name) => {
      if (!name) return;
      void store.createNode(rootPath, kind, name);
    });
  };

  /**
   * 侧栏键盘导航：在文件树/大纲内按上下方向键直接切换，无需回车。
   * 焦点在标签、标题栏按钮或列表项上都能生效；从列表外按键时从第一项开始。
   */
  const handleSidebarKeys = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.tagName === "INPUT") return;
    const selector = tab === "files" ? ".tree-name" : tab === "outline" ? ".outline-item" : "";
    if (!selector) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)];
    if (items.length === 0) return;
    const current =
      target instanceof HTMLElement
        ? items.indexOf(target.closest(selector) as HTMLButtonElement)
        : -1;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const index = current < 0 ? (step === 1 ? 0 : items.length - 1) : current + step;
    const next = items[Math.min(Math.max(index, 0), items.length - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (tab === "outline") {
      next.click();
    } else if (next.dataset.nodeKind === "file") {
      // 文件直接切换文档；目录只移动焦点，避免经过时误展开/折叠。
      next.click();
    }
    requestAnimationFrame(() => next.focus());
  };

  const toggleRoot = (rootPath: string): void => {
    setCollapsedRoots((current) => {
      const next = new Set(current);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  };

  const hasFiles = (event: ReactDragEvent<HTMLElement>): boolean =>
    Array.from(event.dataTransfer.types).includes("Files");

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  /** 拖入文件直接打开文档；拖入目录则追加为工作区根目录。 */
  const handleDrop = (event: ReactDragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.panda.getPathForFile(file))
      .filter((filePath) => filePath.length > 0);
    for (const filePath of paths) {
      void window.panda.fs
        .inspectDrop({ path: filePath })
        .then((info) => {
          if (info.isFile) {
            onOpenPath(info.ref.path, info.ref.rootId);
          } else {
            void store.openPath(info.ref.path, []);
          }
        })
        .catch(() => undefined);
    }
  };

  const openFromTree = (node: WorkspaceNode, rootId: string): void => {
    if (node.path !== activePath) treeOpenRef.current = node.path;
    onOpenFile(node, rootId);
  };

  return (
    <>
      <aside
        className={dragging ? "sidebar dragging" : "sidebar"}
        aria-label={t("工作区")}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={handleSidebarKeys}
      >
        {dragging && (
          <div className="sidebar-drop-hint" aria-hidden="true">
            <Icon name="folder-open" size={22} />
            <span>{t("松开以打开文件或文件夹")}</span>
          </div>
        )}
        <div className="sidebar-tabs" role="tablist" aria-label={t("侧栏视图")}>
          <div className="sidebar-tabs-scroll">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "files"}
              className={tab === "files" ? "sidebar-tab active" : "sidebar-tab"}
              onClick={() => onTabChange("files")}
            >
              <Icon name={SIDEBAR_TAB_ICON.files} size={14} />
              {t("工作区")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "outline"}
              className={tab === "outline" ? "sidebar-tab active" : "sidebar-tab"}
              onClick={() => onTabChange("outline")}
            >
              <Icon name={SIDEBAR_TAB_ICON.outline} size={14} />
              {t("大纲")}
            </button>
            {sourceControl && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "source-control"}
                className={tab === "source-control" ? "sidebar-tab active" : "sidebar-tab"}
                onClick={() => onTabChange("source-control")}
              >
                <Icon name={SIDEBAR_TAB_ICON["source-control"]} size={14} />
                {t("Git")}
                {(sourceControlCount ?? 0) > 0 && (
                  <span className="sidebar-tab-badge">{sourceControlCount}</span>
                )}
              </button>
            )}
          </div>
          <button
            type="button"
            className="icon-button sidebar-collapse-button"
            aria-label={t("折叠工作区")}
            data-tip={t("折叠工作区")}
            onClick={onCollapse}
          >
            <Icon name="sidebar-close" size={14} />
          </button>
        </div>

        {tab === "files" ? (
          <div className="sidebar-panel" ref={filesRef}>
            <div className="files-toolbar">
              <select
                className="files-folder-select"
                aria-label={t("定位文件夹")}
                title={
                  state.roots.length === 0
                    ? t("未打开文件夹")
                    : state.roots.map((entry) => entry.root.path).join("\n")
                }
                defaultValue=""
                disabled={state.roots.length === 0}
                onChange={(event) => {
                  const rootPath = event.target.value;
                  // 复位为占位项，便于重复选择同一个文件夹。
                  event.currentTarget.value = "";
                  if (rootPath) locateRoot(rootPath);
                }}
              >
                <option value="">{`${t("文件夹")} (${state.roots.length})`}</option>
                {state.roots.map((entry) => (
                  <option key={entry.root.path} value={entry.root.path}>
                    {entry.root.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                title={t("打开文件（Ctrl+O）")}
                aria-label={t("打开文件")}
                onClick={onOpenFiles}
              >
                <Icon name="file" />
              </button>
              <button
                type="button"
                className="icon-button"
                title={t("打开文件夹")}
                aria-label={t("打开文件夹")}
                onClick={() => void store.openPicker()}
              >
                <Icon name="folder-open" />
              </button>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                type="button"
                className="icon-button"
                title={t("刷新全部")}
                aria-label={t("刷新全部")}
                disabled={state.roots.length === 0}
                onClick={() => void store.refresh()}
              >
                <Icon name="refresh" />
              </button>
            </div>
            {state.error && <div className="sidebar-error">{state.error}</div>}

            {state.roots.length > 0 ? (
              <div className="workspace-roots">
                {state.roots.map((entry) => {
                  const collapsed = collapsedRoots.has(entry.root.path);
                  return (
                    <section
                      className={collapsed ? "workspace-root collapsed" : "workspace-root"}
                      key={entry.root.path}
                      data-root-path={entry.root.path}
                    >
                      <div className="workspace-root-header">
                        <button
                          type="button"
                          className="tree-toggle workspace-root-toggle"
                          aria-label={t("{0} {1}", collapsed ? t("展开") : t("折叠"), entry.root.name)}
                          aria-expanded={!collapsed}
                          title={collapsed ? t("展开文件夹") : t("折叠文件夹")}
                          onClick={() => toggleRoot(entry.root.path)}
                        >
                          <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={13} />
                        </button>
                        <span className="workspace-root-name" title={entry.root.path}>
                          {entry.root.name}
                        </span>
                        <span className="workspace-root-actions">
                          <button
                            type="button"
                            className="tree-action"
                            title={t("刷新")}
                            aria-label={t("刷新 {0}", entry.root.name)}
                            onClick={() => void store.refresh(entry.root.path)}
                          >
                            <Icon name="refresh" size={13} />
                          </button>
                          <TreeMenu
                            open={menuPath === entry.root.path}
                            label={t("更多操作")}
                            onToggle={() => setMenuPath(menuPath === entry.root.path ? null : entry.root.path)}
                            onClose={() => setMenuPath(null)}
                            entries={[
                              {
                                type: "item",
                                label: t("新建文件"),
                                icon: "file-plus",
                                action: () => create(entry.root.path, "file"),
                              },
                              {
                                type: "item",
                                label: t("新建目录"),
                                icon: "folder-plus",
                                action: () => create(entry.root.path, "dir"),
                              },
                              { type: "separator" },
                              {
                                type: "item",
                                label: t("在文件管理器中显示"),
                                icon: "reveal",
                                action: () => void store.reveal(entry.root.path),
                              },
                              ...copyPathEntries(entry.root.path, entry.root.path, onNotice),
                              {
                                type: "item",
                                label: t("从工作区移除"),
                                icon: "close",
                                action: () => void store.closeRoot(entry.root.path),
                              },
                            ]}
                          />
                        </span>
                      </div>
                      {!collapsed && (
                        <div className="tree" role="tree" aria-label={t("目录树：{0}", entry.root.name)}>
                          {entry.nodes.map((node) => (
                            <NodeRow
                              key={node.path}
                              node={node}
                              depth={0}
                              rootId={entry.root.rootId}
                              rootPath={entry.root.path}
                              store={store}
                              activePath={activePath}
                              menuPath={menuPath}
                              setMenuPath={setMenuPath}
                              onOpenFile={openFromTree}
                              onRenamed={onRenamed}
                              onDeleted={onDeleted}
                              askName={askName}
                              onNotice={onNotice}
                            />
                          ))}
                          {entry.nodes.length === 0 && <p className="sidebar-empty">{t("目录为空")}</p>}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="sidebar-empty">
                <p>{t("未打开文件夹")}</p>
              </div>
            )}
          </div>
        ) : tab === "outline" ? (
          <div className="sidebar-panel">{outline}</div>
        ) : (
          <div className="sidebar-panel git-sidebar-panel">{sourceControl}</div>
        )}
      </aside>

      {prompt && (
        <div className="modal-backdrop" role="presentation" onClick={() => setPrompt(null)}>
          <form
            className="modal prompt-modal"
            role="dialog"
            aria-modal="true"
            aria-label={prompt.title}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              const value = promptValue.trim();
              const submit = prompt.submit;
              setPrompt(null);
              submit(value);
            }}
          >
            <header className="modal-header">
              <h2>{prompt.title}</h2>
              <button type="button" className="icon-button" aria-label={t("关闭")} onClick={() => setPrompt(null)}>
                <Icon name="close" />
              </button>
            </header>
            <div className="modal-body">
              <input
                className="prompt-input"
                autoFocus
                value={promptValue}
                onChange={(event) => setPromptValue(event.target.value)}
              />
            </div>
            <footer className="modal-footer">
              <button type="button" className="button ghost" onClick={() => setPrompt(null)}>
                {t("取消")}
              </button>
              <button type="submit" className="button primary">
                {t("确定")}
              </button>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

/** 侧栏折叠时显示的竖列图标栏：顶部按钮展开侧栏，其余图标展开并切换到对应标签。 */
export function SidebarRail({
  activeTab,
  showSourceControl,
  sourceControlCount = 0,
  onExpand,
  onSelect,
}: {
  activeTab: SidebarTab;
  showSourceControl: boolean;
  sourceControlCount?: number;
  onExpand(): void;
  onSelect(tab: SidebarTab): void;
}) {
  const tabs: { key: SidebarTab; label: string }[] = [
    { key: "files", label: t("工作区") },
    { key: "outline", label: t("大纲") },
  ];
  if (showSourceControl) tabs.push({ key: "source-control", label: t("Git") });

  return (
    <nav className="sidebar-rail" aria-label={t("侧栏视图")}>
      <button
        type="button"
        className="sidebar-rail-button sidebar-rail-expand"
        aria-label={t("展开工作区")}
        data-tip={t("展开工作区")}
        onClick={onExpand}
      >
        <Icon name="sidebar-open" size={15} />
      </button>
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={activeTab === key ? "sidebar-rail-button active" : "sidebar-rail-button"}
          aria-label={label}
          aria-pressed={activeTab === key}
          data-tip={label}
          onClick={() => onSelect(key)}
        >
          <Icon name={SIDEBAR_TAB_ICON[key]} size={15} />
          {key === "source-control" && sourceControlCount > 0 && (
            <span className="sidebar-rail-badge">{sourceControlCount}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
