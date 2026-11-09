import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import type { FileRef } from "../shared/ipc";
import type { WorkspaceNode, WorkspaceStore } from "../services/workspace-store";
import { Icon } from "./icons";

export interface SidebarDocument {
  id: string;
  name: string;
  path: string | null;
  dirty: boolean;
}

interface WorkspacePanelProps {
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  /** 拖入的普通文件按路径打开为文档。 */
  onOpenPath(filePath: string): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  /** 当前打开的全部文档，用于“打开的文件”列表。 */
  documents: readonly SidebarDocument[];
  activeId: string | null;
  onSelectDocument(id: string): void;
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
  onOpenFile,
  onRenamed,
  onDeleted,
  askName,
}: {
  node: WorkspaceNode;
  depth: number;
  rootId: string;
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode, rootId: string): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
  askName(title: string, initial: string, submit: (value: string) => void): void;
}) {
  const rename = (): void => {
    askName(`将“${node.name}”重命名为`, node.name, (next) => {
      if (!next || next === node.name) return;
      void store.renameNode(node.path, next).then((ref) => {
        if (ref) onRenamed(node.path, ref);
      });
    });
  };

  const remove = (): void => {
    const label = node.kind === "dir" ? "目录及其全部内容" : "文件";
    if (!window.confirm(`确定删除${label}“${node.name}”吗？`)) return;
    void store.deleteNode(node.path, node.kind === "dir").then((ok) => {
      if (ok) onDeleted(node.path, node.kind === "dir");
    });
  };

  return (
    <>
      <div
        className={node.kind === "dir" ? "tree-row dir" : "tree-row file"}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        role="treeitem"
        aria-expanded={node.kind === "dir" ? node.expanded : undefined}
      >
        {node.kind === "dir" ? (
          <button
            type="button"
            className="tree-toggle"
            aria-label={node.expanded ? "折叠" : "展开"}
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
            title="重命名"
            aria-label={`重命名 ${node.name}`}
            onClick={rename}
          >
            <Icon name="pencil" size={13} />
          </button>
          <button
            type="button"
            className="tree-action"
            title="删除"
            aria-label={`删除 ${node.name}`}
            onClick={remove}
          >
            <Icon name="trash" size={13} />
          </button>
          <button
            type="button"
            className="tree-action"
            title="在文件管理器中显示"
            aria-label={`显示 ${node.name}`}
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
  documents,
  activeId,
  onSelectDocument,
  outline,
}: WorkspacePanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
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
    askName(kind === "dir" ? "新文件夹名称" : "新文件名", "", (name) => {
      if (!name) return;
      void store.createNode(rootPath, kind, name);
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
        .stat({ path: filePath })
        .then((info) => {
          if (info.isFile) {
            onOpenPath(filePath);
          } else {
            void store.openPath(filePath, []);
          }
        })
        .catch(() => undefined);
    }
  };

  return (
    <>
      <aside
        className={dragging ? "sidebar dragging" : "sidebar"}
        aria-label="工作区"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="sidebar-drop-hint" aria-hidden="true">
            <Icon name="folder-open" size={22} />
            <span>松开以打开文件或文件夹</span>
          </div>
        )}
        <div className="sidebar-header">
          <span className="sidebar-title" title={state.roots.map((entry) => entry.root.path).join("\n")}>
            {state.roots.length === 0
              ? "工作区"
              : state.roots.length === 1
                ? (state.roots[0]?.root.name ?? "工作区")
                : `${state.roots.length} 个文件夹`}
          </span>
          <button
            type="button"
            className="icon-button"
            title="打开文件夹"
            aria-label="打开文件夹"
            onClick={() => void store.openPicker()}
          >
            <Icon name="folder-open" />
          </button>
          {state.roots.length > 0 && (
            <button
              type="button"
              className="icon-button"
              title="刷新全部"
              aria-label="刷新工作区"
              onClick={() => void store.refresh()}
            >
              <Icon name="refresh" />
            </button>
          )}
        </div>

        <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={tab === "files" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setTab("files")}
          >
            <Icon name="folder-open" size={14} />
            文件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "outline"}
            className={tab === "outline" ? "sidebar-tab active" : "sidebar-tab"}
            onClick={() => setTab("outline")}
          >
            <Icon name="list" size={14} />
            大纲
          </button>
        </div>

        {tab === "files" ? (
          <div className="sidebar-panel">
            {state.error && <div className="sidebar-error">{state.error}</div>}

            {documents.length > 0 && (
              <section className="open-files" aria-label="打开的文件">
                <div className="sidebar-section-title">打开的文件</div>
                <ul>
                  {documents.map((document) => (
                    <li key={document.id}>
                      <button
                        type="button"
                        className={
                          document.id === activeId ? "open-file-item active" : "open-file-item"
                        }
                        title={document.path ?? document.name}
                        onClick={() => onSelectDocument(document.id)}
                      >
                        <Icon name="file" size={13} />
                        <span className="open-file-name">{document.name}</span>
                        {document.dirty && <span className="tab-dot" aria-label="未保存" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {state.roots.length > 0 ? (
              <div className="workspace-roots">
                {state.roots.map((entry) => (
                  <section className="workspace-root" key={entry.root.path}>
                    <div className="workspace-root-header">
                      <span className="workspace-root-name" title={entry.root.path}>
                        {entry.root.name}
                      </span>
                      <span className="workspace-root-actions">
                        <button
                          type="button"
                          className="tree-action"
                          title="新建文件"
                          aria-label={`在 ${entry.root.name} 新建文件`}
                          onClick={() => create(entry.root.path, "file")}
                        >
                          <Icon name="file-plus" size={13} />
                        </button>
                        <button
                          type="button"
                          className="tree-action"
                          title="新建文件夹"
                          aria-label={`在 ${entry.root.name} 新建文件夹`}
                          onClick={() => create(entry.root.path, "dir")}
                        >
                          <Icon name="folder-plus" size={13} />
                        </button>
                        <button
                          type="button"
                          className="tree-action"
                          title="刷新"
                          aria-label={`刷新 ${entry.root.name}`}
                          onClick={() => void store.refresh(entry.root.path)}
                        >
                          <Icon name="refresh" size={13} />
                        </button>
                        <button
                          type="button"
                          className="tree-action"
                          title="移除文件夹"
                          aria-label={`移除文件夹 ${entry.root.name}`}
                          onClick={() => void store.closeRoot(entry.root.path)}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </span>
                    </div>
                    <div className="tree" role="tree" aria-label={`目录树：${entry.root.name}`}>
                      {entry.nodes.map((node) => (
                        <NodeRow
                          key={node.path}
                          node={node}
                          depth={0}
                          rootId={entry.root.rootId}
                          store={store}
                          onOpenFile={onOpenFile}
                          onRenamed={onRenamed}
                          onDeleted={onDeleted}
                          askName={askName}
                        />
                      ))}
                      {entry.nodes.length === 0 && <p className="sidebar-empty">目录为空</p>}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="sidebar-empty">
                <p>未打开文件夹</p>
                <button type="button" className="button" onClick={() => void store.openPicker()}>
                  打开文件夹
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
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setPrompt(null)}>
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
                取消
              </button>
              <button type="submit" className="button primary">
                确定
              </button>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}
