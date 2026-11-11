import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import type { FileRef } from "../shared/ipc";
import { t } from "../i18n";
import type { WorkspaceNode, WorkspaceStore } from "../services/workspace-store";
import { Icon } from "./icons";

interface WorkspacePanelProps {
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  /** 拖入的普通文件按路径打开为文档。 */
  onOpenPath(filePath: string, rootId: string | null): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  /** 当前活动的文档路径，用于在目录树中高亮。 */
  activePath: string | null;
  /** 大纲标签页的内容。 */
  outline?: ReactNode;
}

interface PromptState {
  title: string;
  initial: string;
  submit(value: string): void;
}

function NodeRow({
  node,
  depth,
  rootId,
  store,
  activePath,
  onOpenFile,
  onRenamed,
  onDeleted,
  askName,
}: {
  node: WorkspaceNode;
  depth: number;
  rootId: string;
  store: WorkspaceStore;
  activePath: string | null;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  askName(title: string, initial: string, submit: (value: string) => void): void;
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
          <Icon name={node.kind === "dir" ? "folder" : "file"} size={13} />
        </span>
        <button
          type="button"
          className="tree-name"
          title={node.path}
          onClick={() => (node.kind === "dir" ? void store.toggle(node.path) : onOpenFile(node, rootId))}
        >
          {node.name}
        </button>
        <span className="tree-actions">
          <button
            type="button"
            className="tree-action"
            title={t("重命名")}
            aria-label={t("重命名 {0}", node.name)}
            onClick={rename}
          >
            <Icon name="pencil" size={13} />
          </button>
          <button
            type="button"
            className="tree-action"
            title={t("删除")}
            aria-label={t("删除 {0}", node.name)}
            onClick={remove}
          >
            <Icon name="trash" size={13} />
          </button>
          <button
            type="button"
            className="tree-action"
            title={t("在文件管理器中显示")}
            aria-label={t("显示 {0}", node.name)}
            onClick={() => void store.reveal(node.path)}
          >
            <Icon name="reveal" size={13} />
          </button>
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
              store={store}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onRenamed={onRenamed}
              onDeleted={onDeleted}
              askName={askName}
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
  onOpenPath,
  onRenamed,
  onDeleted,
  activePath,
  outline,
}: WorkspacePanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<"files" | "outline">(() =>
    store.getState().roots.length > 0 ? "files" : "outline",
  );
  const previousRoot = useRef(state.roots[0]?.root.path ?? null);

  // 打开文件夹后自动切回文件视图；未打开工作区时默认显示大纲。
  useEffect(() => {
    const root = state.roots[0]?.root.path ?? null;
    if (root && root !== previousRoot.current) setTab("files");
    previousRoot.current = root;
  }, [state.roots]);

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

  return (
    <>
      <aside
        className={dragging ? "sidebar dragging" : "sidebar"}
        aria-label={t("工作区")}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="sidebar-drop-hint" aria-hidden="true">
            <Icon name="folder-open" size={22} />
            <span>{t("松开以打开文件或文件夹")}</span>
          </div>
        )}
        <div className="sidebar-header">
          <span className="sidebar-title" title={state.roots.map((entry) => entry.root.path).join("\n")}>
            {state.roots.length === 0
              ? t("工作区")
              : state.roots.length === 1
                ? (state.roots[0]?.root.name ?? t("工作区"))
                : t("{0} 个文件夹", state.roots.length)}
          </span>
          <button
            type="button"
            className="icon-button"
            title={t("打开文件夹")}
            aria-label={t("打开文件夹")}
            onClick={() => void store.openPicker()}
          >
            <Icon name="folder-open" />
          </button>
          {state.roots.length > 0 && (
            <button
              type="button"
              className="icon-button"
              title={t("刷新全部")}
              aria-label={t("刷新工作区")}
              onClick={() => void store.refresh()}
            >
              <Icon name="refresh" />
            </button>
          )}
        </div>

        <div className="sidebar-tabs" role="tablist" aria-label={t("侧栏视图")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={tab === "files" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setTab("files")}
          >
            <Icon name="folder-open" size={14} />
            {t("文件")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "outline"}
            className={tab === "outline" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setTab("outline")}
          >
            <Icon name="list" size={14} />
            {t("大纲")}
          </button>
        </div>

        {tab === "files" ? (
          <div className="sidebar-panel">
            {state.error && <div className="sidebar-error">{state.error}</div>}

            {state.roots.length > 0 ? (
              <div className="workspace-roots">
                {state.roots.map((entry) => {
                  const collapsed = collapsedRoots.has(entry.root.path);
                  return (
                    <section
                      className={collapsed ? "workspace-root collapsed" : "workspace-root"}
                      key={entry.root.path}
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
                            title={t("新建文件")}
                            aria-label={t("在 {0} 新建文件", entry.root.name)}
                            onClick={() => create(entry.root.path, "file")}
                          >
                            <Icon name="file-plus" size={13} />
                          </button>
                          <button
                            type="button"
                            className="tree-action"
                            title={t("新建文件夹")}
                            aria-label={t("在 {0} 新建文件夹", entry.root.name)}
                            onClick={() => create(entry.root.path, "dir")}
                          >
                            <Icon name="folder-plus" size={13} />
                          </button>
                          <button
                            type="button"
                            className="tree-action"
                            title={t("刷新")}
                            aria-label={t("刷新 {0}", entry.root.name)}
                            onClick={() => void store.refresh(entry.root.path)}
                          >
                            <Icon name="refresh" size={13} />
                          </button>
                          <button
                            type="button"
                            className="tree-action"
                            title={t("移除文件夹")}
                            aria-label={t("移除文件夹 {0}", entry.root.name)}
                            onClick={() => void store.closeRoot(entry.root.path)}
                          >
                            <Icon name="close" size={13} />
                          </button>
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
                              store={store}
                              activePath={activePath}
                              onOpenFile={onOpenFile}
                              onRenamed={onRenamed}
                              onDeleted={onDeleted}
                              askName={askName}
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
                <button type="button" className="button" onClick={() => void store.openPicker()}>
                  {t("打开文件夹")}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="sidebar-panel">{outline}</div>
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
