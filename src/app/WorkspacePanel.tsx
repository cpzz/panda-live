import { useState, useSyncExternalStore } from "react";
import type { FileRef } from "../shared/ipc";
import type { WorkspaceNode, WorkspaceStore } from "../services/workspace-store";

interface WorkspacePanelProps {
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode): void;
  onRenamed(oldPath: string, ref: FileRef): void;
  onDeleted(filePath: string, isDir: boolean): void;
}

interface PromptState {
  title: string;
  initial: string;
  submit(value: string): void;
}

function NodeRow({
  node,
  depth,
  store,
  onOpenFile,
  onRenamed,
  onDeleted,
  askName,
}: {
  node: WorkspaceNode;
  depth: number;
  store: WorkspaceStore;
  onOpenFile(node: WorkspaceNode): void;
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
        <button
          type="button"
          className="tree-name"
          title={node.path}
          onClick={() => (node.kind === "dir" ? void store.toggle(node.path) : onOpenFile(node))}
        >
          {node.name}
        </button>
        <span className="tree-actions">
          <button type="button" className="tree-action" title="重命名" onClick={rename}>
            改名
          </button>
          <button type="button" className="tree-action" title="删除" onClick={remove}>
            删除
          </button>
          <button
            type="button"
            className="tree-action"
            title="在文件管理器中显示"
            onClick={() => void store.reveal(node.path)}
          >
            显示
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

/** 左侧工作区目录树。见 doc/design.md §12.5、§15.1。 */
export function WorkspacePanel({ store, onOpenFile, onRenamed, onDeleted }: WorkspacePanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const askName = (title: string, initial: string, submit: (value: string) => void): void => {
    setPromptValue(initial);
    setPrompt({ title, initial, submit });
  };

  const create = (kind: "file" | "dir"): void => {
    if (!state.root) return;
    askName(kind === "dir" ? "新文件夹名称" : "新文件名", "", (name) => {
      if (!name) return;
      void store.createNode(state.root?.path ?? "", kind, name);
    });
  };

  return (
    <>
      <aside className="sidebar" aria-label="工作区">
        <div className="sidebar-header">
          <span className="sidebar-title" title={state.root?.path ?? ""}>
            {state.root?.name ?? "工作区"}
          </span>
          <button
            type="button"
            className="icon-button"
            title="打开文件夹"
            aria-label="打开文件夹"
            onClick={() => void store.openPicker()}
          >
            打开
          </button>
          {state.root && (
            <button
              type="button"
              className="icon-button"
              title="刷新"
              aria-label="刷新工作区"
              onClick={() => void store.refresh()}
            >
              刷新
            </button>
          )}
        </div>

        {state.error && <div className="sidebar-error">{state.error}</div>}

        {state.root ? (
          <>
            <div className="sidebar-actions">
              <button type="button" className="icon-button" onClick={() => create("file")}>
                新建文件
              </button>
              <button type="button" className="icon-button" onClick={() => create("dir")}>
                新建文件夹
              </button>
            </div>
            <div className="tree" role="tree" aria-label="目录树">
              {state.nodes.map((node) => (
                <NodeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  store={store}
                  onOpenFile={onOpenFile}
                  onRenamed={onRenamed}
                  onDeleted={onDeleted}
                  askName={askName}
                />
              ))}
              {state.nodes.length === 0 && <p className="sidebar-empty">目录为空</p>}
            </div>
          </>
        ) : (
          <div className="sidebar-empty">
            <p>未打开文件夹</p>
            <button type="button" className="button" onClick={() => void store.openPicker()}>
              打开文件夹
            </button>
          </div>
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
