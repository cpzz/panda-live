import { describeError, getErrorCode, PandaError } from "../shared/errors";
import type {
  EditorMode,
  Eol,
  FileRef,
  FsChangedEvent,
  MenuCommand,
  RecentEntry,
  SessionState,
  TextEncoding,
} from "../shared/ipc";
import { detectFormatEntry } from "../extensions/registry";
import { parseMarkdown } from "../formats/markdown/parse";
import { decideOpenPolicy, preferSourceByBlocks } from "./open-policy";

export type { EditorMode };

const AUTOSAVE_DELAY_MS = 10_000;
const DRAFT_DELAY_MS = 30_000;
const SESSION_INTERVAL_MS = 15_000;

export interface DocumentState {
  id: string;
  name: string;
  path: string | null;
  rootId: string | null;
  /** 格式 id：内置格式名，或扩展贡献的 provider id。 */
  format: string;
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
  /** 崩溃恢复草稿键；未命名文档首次保存草稿时由主进程生成。 */
  draftKey: string | null;
  /** 当前文件监听句柄。 */
  watchId: string | null;
  cursor?: { line: number; column: number };
}

export interface Notice {
  kind: "info" | "error";
  message: string;
}

export interface ConflictState {
  documentId: string;
  message: string;
  diskMtimeMs?: number;
  localMtimeMs?: number;
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

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 渲染进程侧的文档管理：标签、脏标记、保存、冲突、自动保存、草稿与会话。
 * 所有文件操作经 `window.panda` 转交主进程。见 doc/design.md §7.3、§12.2–§12.4。
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
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoSaveEnabled = true;
  private modeSwitchNoticeShown = false;

  readonly getState = (): AppState => this.state;

  readonly subscribe = (listener: (state: AppState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 设置中的自动保存开关；关闭后仍保留草稿备份。 */
  setAutoSave(enabled: boolean): void {
    this.autoSaveEnabled = enabled;
    if (!enabled) {
      for (const timer of this.autosaveTimers.values()) clearTimeout(timer);
      this.autosaveTimers.clear();
    }
  }

  async openFiles(): Promise<void> {
    try {
      const refs = await window.panda.dialog.openFiles();
      for (const ref of refs) {
        await this.openRef(ref);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  async openPath(filePath: string, rootId: string | null = null): Promise<void> {
    await this.openRef({ path: filePath, name: basename(filePath), rootId: rootId ?? "" });
  }

  newDocument(): void {
    const id = createId();
    const document: DocumentState = {
      id,
      name: "untitled.md",
      path: null,
      rootId: null,
      format: "markdown",
      content: "",
      savedContent: "",
      dirty: false,
      eol: "lf",
      bom: false,
      encoding: "utf-8",
      readOnly: false,
      hash: "",
      mtimeMs: 0,
      size: 0,
      revision: 0,
      draftKey: null,
      watchId: null,
    };
    this.commit({
      documents: [...this.state.documents, document],
      activeId: id,
      mode: this.state.mode === "preview" ? "wysiwyg" : this.state.mode,
    });
    this.scheduleSessionSave();
  }

  setActive(id: string): void {
    if (!this.state.documents.some((doc) => doc.id === id)) return;
    this.commit({ activeId: id });
    this.scheduleSessionSave();
  }

  /** 调整标签顺序：把 fromId 移动到 toId 的位置，激活标签保持不变。 */
  moveDocument(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const documents = [...this.state.documents];
    const fromIndex = documents.findIndex((doc) => doc.id === fromId);
    const toIndex = documents.findIndex((doc) => doc.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = documents.splice(fromIndex, 1);
    if (!moved) return;
    documents.splice(toIndex, 0, moved);
    this.commit({ documents });
    this.scheduleSessionSave();
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
    this.scheduleAutosave(id);
    this.scheduleDraft(id);
  }

  /** 源码模式的光标位置，用于会话恢复。 */
  updateCursor(id: string, cursor: { line: number; column: number }): void {
    const doc = this.findDocument(id);
    if (!doc) return;
    if (doc.cursor?.line === cursor.line && doc.cursor?.column === cursor.column) return;
    this.patchDocument(id, () => ({ cursor }));
  }

  /** 供导出等外部流程复用提示条。 */
  showNotice(kind: Notice["kind"], message: string): void {
    this.notify(kind, message);
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
      case "file.new":
        this.newDocument();
        return;
      case "file.open":
        await this.openFiles();
        return;
      case "file.save":
        if (activeId) await this.saveDocument(activeId);
        return;
      case "file.saveAs":
        if (activeId) await this.saveDocumentAs(activeId);
        return;
      case "file.close":
        if (activeId) await this.closeDocument(activeId);
        return;
      case "workspace.open":
        await this.openWorkspaceFolder();
        return;
      default:
        return;
    }
  }

  /** 由 App 注入的工作区打开动作（工作区状态保存在 WorkspaceStore）。 */
  openWorkspaceFolder: () => Promise<void> = async () => undefined;

  async closeDocument(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc) return;
    if (doc.dirty) {
      const shouldSave = window.confirm(`是否保存对“${doc.name}”的修改？`);
      if (shouldSave) {
        await this.saveDocument(id);
        const current = this.findDocument(id);
        if (current?.dirty) return;
      } else if (!window.confirm("放弃未保存的修改并关闭标签？")) {
        return;
      }
    }
    await this.releaseDocumentResources(doc);
    const documents = this.state.documents.filter((item) => item.id !== id);
    const activeId =
      this.state.activeId === id ? (documents[documents.length - 1]?.id ?? null) : this.state.activeId;
    this.commit({ documents, activeId });
    this.scheduleSessionSave();
  }

  async saveDocument(id: string, silent = false): Promise<void> {
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
      if (!silent) this.notify("info", "没有需要保存的修改");
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
      await this.dropDraft(id);
      if (!silent) this.notify("info", "已保存");
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
      await this.releaseWatcher(doc);
      const watchId = await this.watchFile(ref.path);
      this.patchDocument(id, (current) => ({
        path: ref.path,
        name: ref.name,
        rootId: ref.rootId,
        format: detectFormatEntry(ref.name)?.id ?? "text",
        savedContent: content,
        dirty: current.content !== content,
        eol: data.eol,
        bom: data.bom,
        encoding: data.encoding,
        readOnly: data.readOnly,
        hash: data.hash,
        mtimeMs: data.mtimeMs,
        size: data.size,
        watchId,
      }));
      await this.dropDraft(id);
      this.commit({ conflict: null });
      this.scheduleSessionSave();
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
      await this.dropDraft(id);
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 主进程文件监听事件：静默重载或进入冲突流程。 */
  handleFsChanged(event: FsChangedEvent): void {
    for (const doc of this.state.documents) {
      if (doc.watchId !== event.watchId || !doc.path) continue;
      const change = event.changes.find((item) => item.path === doc.path);
      if (!change) continue;
      void this.handleExternalChange(doc, change.type);
    }
  }

  /** 打开工作区中的文件。 */
  async openWorkspaceFile(filePath: string, rootId: string | null): Promise<void> {
    await this.openPath(filePath, rootId);
  }

  /** 工作区重命名后同步打开的文档路径。 */
  async repathDocument(oldPath: string, ref: FileRef): Promise<void> {
    const doc = this.state.documents.find((item) => item.path === oldPath);
    if (!doc) return;
    await this.releaseWatcher(doc);
    const watchId = await this.watchFile(ref.path);
    this.patchDocument(doc.id, () => ({
      path: ref.path,
      name: ref.name,
      rootId: ref.rootId,
      format: detectFormatEntry(ref.name)?.id ?? "text",
      watchId,
    }));
  }

  /** 工作区删除文件后关闭对应标签；本地仍有未保存修改时保留标签以免丢数据。 */
  async removeDocumentByPath(filePath: string): Promise<void> {
    const doc = this.state.documents.find((item) => item.path === filePath);
    if (!doc) return;
    if (doc.dirty) {
      this.notify("error", "文件已在磁盘删除，标签保留未保存内容；请另存为");
      this.patchDocument(doc.id, () => ({ readOnly: true }));
      return;
    }
    await this.releaseDocumentResources(doc);
    const documents = this.state.documents.filter((item) => item.id !== doc.id);
    const activeId = this.state.activeId === doc.id ? (documents[documents.length - 1]?.id ?? null) : this.state.activeId;
    this.commit({ documents, activeId });
  }

  /** 启动时立即建立会话保存定时器，即使尚未打开文档也能保存侧栏/工作区状态。 */
  ensureSessionTimer(): void {
    this.scheduleSessionSave();
  }

  // ---------- 会话与草稿 ----------

  async restoreSession(session: SessionState): Promise<void> {
    for (const entry of session.documents) {
      if (!entry.path) continue;
      const ref: FileRef = { path: entry.path, name: basename(entry.path), rootId: "" };
      await this.openRef(ref, { silentRecent: true, silentErrors: true });
      const doc = this.state.documents.find((item) => item.path === entry.path);
      if (doc) {
        this.patchDocument(doc.id, () => ({
          cursor: entry.cursor,
        }));
      }
    }
    const active = this.state.documents[Math.min(session.activeIndex, this.state.documents.length - 1)];
    if (active) this.commit({ activeId: active.id });
    if (session.mode === "wysiwyg" && active?.format !== "markdown") {
      this.commit({ mode: "split" });
    } else {
      this.commit({ mode: session.mode });
    }
    if (session.documents.length > 0 && this.state.documents.length < session.documents.length) {
      this.notify("info", "部分标签对应的文件已不存在，已跳过恢复");
    }
  }

  /** 应用草稿内容；文档尚不存在时按路径重新打开。 */
  async restoreDraft(entry: { key: string; path: string | null; content: string; cursor?: { line: number; column: number } }): Promise<void> {
    let doc = this.state.documents.find((item) => (entry.path ? item.path === entry.path : false));
    if (!doc && entry.path) {
      await this.openPath(entry.path);
      doc = this.state.documents.find((item) => item.path === entry.path);
    }
    if (!doc) {
      const id = createId();
      const created: DocumentState = {
        id,
        name: "untitled.md",
        path: null,
        rootId: null,
        format: "markdown",
        content: entry.content,
        savedContent: "",
        dirty: true,
        eol: "lf",
        bom: false,
        encoding: "utf-8",
        readOnly: false,
        hash: "",
        mtimeMs: 0,
        size: byteLength(entry.content),
        revision: 0,
        draftKey: entry.key,
        watchId: null,
        cursor: entry.cursor,
      };
      this.commit({ documents: [...this.state.documents, created], activeId: id });
      return;
    }
    this.patchDocument(doc.id, (current) => ({
      content: entry.content,
      dirty: entry.content !== current.savedContent,
      revision: current.revision + 1,
      draftKey: entry.key,
      cursor: entry.cursor,
    }));
    this.commit({ activeId: doc.id });
  }

  async discardDraft(key: string): Promise<void> {
    await window.panda.drafts.remove(key).catch(() => undefined);
  }

  /** 会话快照：供主进程写入 `session.json`。 */
  buildSession(args: {
    mode: EditorMode;
    sidebarVisible: boolean;
    recent: RecentEntry[];
    workspace?: { rootPath: string; expanded: string[] };
  }): SessionState {
    return {
      documents: this.state.documents.map((doc) => ({
        path: doc.path,
        mode: args.mode,
        cursor: doc.cursor,
      })),
      activeIndex: Math.max(
        0,
        this.state.documents.findIndex((doc) => doc.id === this.state.activeId),
      ),
      mode: args.mode,
      sidebarVisible: args.sidebarVisible,
      recent: args.recent.map((entry) => entry.path),
      workspace: args.workspace,
    };
  }

  async saveSession(snapshot: SessionState): Promise<void> {
    await window.panda.session.save(snapshot).catch(() => undefined);
  }

  // ---------- 内部实现 ----------

  private async openRef(
    ref: FileRef,
    options: { silentRecent?: boolean; silentErrors?: boolean } = {},
  ): Promise<void> {
    const existing = this.state.documents.find((doc) => doc.path === ref.path);
    if (existing) {
      this.setActive(existing.id);
      return;
    }
    try {
      const stats = await window.panda.fs.stat({ path: ref.path });
      const policy = decideOpenPolicy(stats.size);
      if (policy.reject) {
        throw new PandaError("E_FILE_TOO_LARGE", `文件超过 50 MB，拒绝打开：${ref.name}`);
      }
      if (
        policy.confirm &&
        !window.confirm(
          `文件约 ${(stats.size / (1024 * 1024)).toFixed(1)} MB，打开可能较慢，是否继续？`,
        )
      ) {
        return;
      }
      const data = await window.panda.fs.readText({ path: ref.path });
      const watchId = await this.watchFile(ref.path);
      let forceSource = policy.preferSource;
      let blockLimit = false;
      if (!forceSource && detectFormatEntry(ref.name)?.id === "markdown") {
        try {
          const blocks = parseMarkdown(data.content).doc.content?.length ?? 0;
          blockLimit = preferSourceByBlocks(blocks);
          forceSource = blockLimit;
        } catch {
          // 解析失败时交给编辑器侧的 raw_markdown 兜底
        }
      }
      const document: DocumentState = {
        id: createId(),
        name: ref.name,
        path: ref.path,
        rootId: ref.rootId || null,
        format: detectFormatEntry(ref.name)?.id ?? "text",
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
        draftKey: null,
        watchId,
      };
      this.commit({
        documents: [...this.state.documents, document],
        activeId: document.id,
        mode: forceSource
          ? "source"
          : document.format === "markdown" || this.state.mode !== "wysiwyg"
            ? this.state.mode
            : "source",
      });
      if (blockLimit) {
        this.notify("info", "文档顶层块超过 8000，已默认切换到源码模式");
      } else if (policy.preferSource) {
        this.notify("info", "文件较大，已默认切换到源码模式");
      }
      if (!options.silentRecent) {
        await window.panda.recent.add({ path: ref.path }).catch(() => undefined);
      }
      if (data.readOnly) {
        this.notify("info", `编码 ${data.encoding} 暂不支持写回，已以只读方式打开`);
      }
      this.scheduleSessionSave();
    } catch (error) {
      if (!options.silentErrors) this.reportError(error);
    }
  }

  private async handleExternalChange(doc: DocumentState, type: "add" | "change" | "unlink"): Promise<void> {
    if (type === "unlink") {
      if (doc.dirty) {
        this.commit({
          conflict: {
            documentId: doc.id,
            message: "文件已被删除或移动，本地仍有未保存修改",
            localMtimeMs: doc.mtimeMs,
          },
        });
      } else {
        this.notify("error", "文件已被删除或移动，标签内容仍保留为只读");
        this.patchDocument(doc.id, () => ({ readOnly: true }));
      }
      return;
    }
    if (!doc.path) return;
    try {
      const data = await window.panda.fs.readText({ path: doc.path });
      if (data.hash === doc.hash) return;
      if (!doc.dirty) {
        this.patchDocument(doc.id, (current) => ({
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
        this.notify("info", "文件已在外部修改，已重新加载");
      } else {
        this.commit({
          conflict: {
            documentId: doc.id,
            message: `文件已被外部修改（磁盘 ${formatTime(data.mtimeMs)}）`,
            diskMtimeMs: data.mtimeMs,
            localMtimeMs: doc.mtimeMs,
          },
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async watchFile(filePath: string): Promise<string | null> {
    try {
      const { watchId } = await window.panda.fs.watch({ paths: [filePath] });
      return watchId;
    } catch {
      return null;
    }
  }

  private async releaseWatcher(doc: DocumentState): Promise<void> {
    if (!doc.watchId) return;
    const watchId = doc.watchId;
    this.patchDocument(doc.id, () => ({ watchId: null }));
    await window.panda.fs.unwatch({ watchId }).catch(() => undefined);
  }

  private async releaseDocumentResources(doc: DocumentState): Promise<void> {
    for (const timers of [this.autosaveTimers, this.draftTimers]) {
      const timer = timers.get(doc.id);
      if (timer) clearTimeout(timer);
      timers.delete(doc.id);
    }
    await this.releaseWatcher(doc);
    // 正常关闭时删除草稿，避免下次启动误报恢复。见 §12.4。
    await this.dropDraft(doc.id);
  }

  private scheduleAutosave(id: string): void {
    const doc = this.findDocument(id);
    if (!doc || !doc.path || doc.readOnly || !this.autoSaveEnabled) return;
    const existing = this.autosaveTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.autosaveTimers.delete(id);
      const current = this.findDocument(id);
      if (current?.dirty) void this.saveDocument(id, true);
    }, AUTOSAVE_DELAY_MS);
    this.autosaveTimers.set(id, timer);
  }

  private scheduleDraft(id: string): void {
    const doc = this.findDocument(id);
    if (!doc) return;
    const existing = this.draftTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.draftTimers.delete(id);
      void this.persistDraft(id);
    }, DRAFT_DELAY_MS);
    this.draftTimers.set(id, timer);
  }

  private async persistDraft(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc || !doc.dirty) return;
    try {
      const result = await window.panda.drafts.save({
        key: doc.draftKey ?? undefined,
        draft: {
          path: doc.path,
          content: doc.content,
          cursor: doc.cursor,
          savedAt: Date.now(),
        },
      });
      this.patchDocument(id, () => ({ draftKey: result.key }));
    } catch {
      // 草稿是尽力而为的备份，失败不打扰用户。
    }
  }

  private async dropDraft(id: string): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc?.draftKey) return;
    const timer = this.draftTimers.get(id);
    if (timer) clearTimeout(timer);
    this.draftTimers.delete(id);
    const key = doc.draftKey;
    this.patchDocument(id, () => ({ draftKey: null }));
    await window.panda.drafts.remove(key).catch(() => undefined);
  }

  private scheduleSessionSave(): void {
    if (this.sessionTimer) return;
    this.sessionTimer = setInterval(() => {
      void this.onSessionTick?.();
    }, SESSION_INTERVAL_MS);
  }

  /** 由 App 注入，用于拼装当前模式、侧栏与最近文件。 */
  onSessionTick: (() => Promise<void>) | null = null;

  private findDocument(id: string): DocumentState | undefined {
    return this.state.documents.find((doc) => doc.id === id);
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
