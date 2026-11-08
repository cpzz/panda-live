import { describeError, getErrorCode } from "../shared/errors";
import type { Eol, FileRef, MenuCommand, TextEncoding } from "../shared/ipc";
import { detectFormat, type BuiltinDocumentFormat } from "../formats/registry";

export type EditorMode = "wysiwyg" | "split" | "source" | "preview";

export interface DocumentState {
  id: string;
  name: string;
  path: string | null;
  rootId: string | null;
  format: BuiltinDocumentFormat;
  content: string;
  savedContent: string;
  dirty: boolean;
  eol: Eol;
  bom: boolean;
  encoding: TextEncoding;
  readOnly: boolean;
  hash: string;
  mtimeMs: number;
  size: number;
  /** 内容被外部替换时递增，编辑器据此重建状态。 */
  revision: number;
}

export interface Notice {
  kind: "info" | "error";
  message: string;
}

export interface ConflictState {
  documentId: string;
  message: string;
}

export interface AppState {
  documents: DocumentState[];
  activeId: string | null;
  mode: EditorMode;
  notice: Notice | null;
  conflict: ConflictState | null;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

/**
 * 渲染进程侧的文档管理：标签、脏标记、保存与冲突处理。
 * 所有文件操作经 `window.panda` 转交主进程。见 doc/design.md §7.3、§12.2。
 */
export class DocumentManager {
  private state: AppState = {
    documents: [],
    activeId: null,
    mode: "split",
    notice: null,
    conflict: null,
  };

  private readonly listeners = new Set<(state: AppState) => void>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 撤销历史不跨模式共享，首次切换时提示一次。见 doc/design.md §8.5。 */
  private modeSwitchNoticeShown = false;

  readonly getState = (): AppState => this.state;

  readonly subscribe = (listener: (state: AppState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async openFiles(): Promise<void> {
    try {
      const refs = await window.panda.dialog.openFiles();
      for (const ref of refs) {
        await this.openFile(ref);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  setActive(id: string): void {
    if (!this.state.documents.some((doc) => doc.id === id)) return;
    this.commit({ activeId: id });
  }

  setMode(mode: EditorMode): void {
    if (mode === this.state.mode) return;
    const active = this.findDocument(this.state.activeId ?? "");
    if (mode === "wysiwyg" && active && active.format !== "markdown") {
      this.notify("error", "该格式不支持所见即所得编辑，请使用源码模式");
      return;
    }
    const firstSwitch = !this.modeSwitchNoticeShown;
    this.modeSwitchNoticeShown = true;
    this.commit({ mode });
    if (firstSwitch) {
      this.notify("info", "撤销历史不跨模式共享，已为目标模式建立新的撤销基线");
    }
  }

  updateContent(id: string, content: string): void {
    this.patchDocument(id, (doc) => ({
      content,
      dirty: doc.dirty || content !== doc.savedContent,
    }));
  }

  dismissNotice(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.commit({ notice: null });
  }

  dismissConflict(): void {
    this.commit({ conflict: null });
  }

  async runMenuCommand(command: MenuCommand): Promise<void> {
    const activeId = this.state.activeId;
    switch (command) {
      case "file.open":
        await this.openFiles();
        return;
      case "file.save":
        if (activeId) await this.saveDocument(activeId);
        return;
      case "file.saveAs":
        if (activeId) await this.saveDocumentAs(activeId);
        return;
    }
  }

  async saveDocument(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc) return;
    if (!doc.path) {
      await this.saveDocumentAs(id);
      return;
    }
    if (doc.readOnly) {
      this.notify("error", "该文档以只读方式打开，请使用“另存为”保存副本");
      return;
    }
    if (doc.content === doc.savedContent) {
      this.patchDocument(id, () => ({ dirty: false }));
      this.notify("info", "没有需要保存的修改");
      return;
    }

    const content = doc.content;
    try {
      const result = await window.panda.fs.writeText({
        path: doc.path,
        content,
        baseHash: doc.hash,
      });
      const current = this.findDocument(id);
      this.patchDocument(id, () => ({
        savedContent: content,
        dirty: (current?.content ?? content) !== content,
        hash: result.hash,
        mtimeMs: result.mtimeMs,
        size: byteLength(content),
      }));
    } catch (error) {
      if (getErrorCode(error) === "E_FILE_CHANGED") {
        this.commit({ conflict: { documentId: id, message: describeError(error) } });
        return;
      }
      this.reportError(error);
    }
  }

  async saveDocumentAs(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc) return;
    try {
      const ref = await window.panda.dialog.saveAs({
        suggestedName: doc.path ? doc.name : "untitled.md",
      });
      if (!ref) return;

      const content = doc.content;
      await window.panda.fs.writeText({ path: ref.path, content, baseHash: "" });
      // 回读以同步目标文件真实的编码、换行与哈希（另存为可能重建了元数据）。
      const data = await window.panda.fs.readText({ path: ref.path });
      this.patchDocument(id, (current) => ({
        path: ref.path,
        name: ref.name,
        rootId: ref.rootId,
        format: detectFormat(ref.name),
        savedContent: content,
        dirty: current.content !== content,
        eol: data.eol,
        bom: data.bom,
        encoding: data.encoding,
        readOnly: data.readOnly,
        hash: data.hash,
        mtimeMs: data.mtimeMs,
        size: data.size,
      }));
      this.commit({ conflict: null });
    } catch (error) {
      this.reportError(error);
    }
  }

  async reloadFromDisk(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc?.path) return;
    try {
      const data = await window.panda.fs.readText({ path: doc.path });
      this.patchDocument(id, (current) => ({
        content: data.content,
        savedContent: data.content,
        dirty: false,
        eol: data.eol,
        bom: data.bom,
        encoding: data.encoding,
        readOnly: data.readOnly,
        hash: data.hash,
        mtimeMs: data.mtimeMs,
        size: data.size,
        revision: current.revision + 1,
      }));
      this.commit({ conflict: null });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 冲突场景下以本地内容覆盖磁盘：先读取当前哈希，再写入。 */
  async overwriteFromDisk(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc?.path) return;
    try {
      const data = await window.panda.fs.readText({ path: doc.path });
      const content = doc.content;
      const result = await window.panda.fs.writeText({
        path: doc.path,
        content,
        baseHash: data.hash,
      });
      this.patchDocument(id, (current) => ({
        savedContent: content,
        dirty: current.content !== content,
        hash: result.hash,
        mtimeMs: result.mtimeMs,
        size: byteLength(content),
      }));
      this.commit({ conflict: null });
    } catch (error) {
      this.reportError(error);
    }
  }

  private findDocument(id: string): DocumentState | undefined {
    return this.state.documents.find((doc) => doc.id === id);
  }

  private async openFile(ref: FileRef): Promise<void> {
    const existing = this.state.documents.find((doc) => doc.path === ref.path);
    if (existing) {
      this.setActive(existing.id);
      return;
    }
    try {
      const data = await window.panda.fs.readText({ path: ref.path });
      const document: DocumentState = {
        id: createId(),
        name: ref.name,
        path: ref.path,
        rootId: ref.rootId,
        format: detectFormat(ref.name),
        content: data.content,
        savedContent: data.content,
        dirty: false,
        eol: data.eol,
        bom: data.bom,
        encoding: data.encoding,
        readOnly: data.readOnly,
        hash: data.hash,
        mtimeMs: data.mtimeMs,
        size: data.size,
        revision: 0,
      };
      this.commit({
        documents: [...this.state.documents, document],
        activeId: document.id,
        mode:
          document.format === "markdown" || this.state.mode !== "wysiwyg"
            ? this.state.mode
            : "source",
      });
      if (data.readOnly) {
        this.notify("info", `编码 ${data.encoding} 暂不支持写回，已以只读方式打开`);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private patchDocument(id: string, patch: (doc: DocumentState) => Partial<DocumentState>): void {
    const documents = this.state.documents.map((doc) =>
      doc.id === id ? { ...doc, ...patch(doc) } : doc,
    );
    this.commit({ documents });
  }

  private commit(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private notify(kind: Notice["kind"], message: string): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.state = { ...this.state, notice: { kind, message } };
    for (const listener of this.listeners) listener(this.state);
    if (kind === "info") {
      this.noticeTimer = setTimeout(() => this.dismissNotice(), 4000);
    }
  }

  private reportError(error: unknown): void {
    this.notify("error", describeError(error));
  }
}
