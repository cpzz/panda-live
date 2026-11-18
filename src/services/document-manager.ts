import { describeError, getErrorCode, PandaError } from "../shared/errors";
import { t } from "../i18n";
import type {
  EditorMode,
  Eol,
  FileRef,
  FsChangedEvent,
  MenuCommand,
  RecentEntry,
  SessionState,
  TextEncoding,
  WorkspaceSessionState,
} from "../shared/ipc";
import { detectFormatEntry, formatHasPreview } from "../extensions/registry";
import { parseMarkdown } from "../formats/markdown/parse";
import type { SaveEol } from "../shared/settings";
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
  /** 源码编辑器折叠起始行号列表；随会话持久化。见 doc/design.md §21.6。 */
  folds?: number[];
}

export interface Notice {
  kind: "info" | "error";
  message: string;
}

/** 通知历史条目：气泡消失后仍保留，供状态栏的通知列表查看。 */
export interface NoticeEntry {
  id: number;
  kind: Notice["kind"];
  message: string;
  /** 产生时间（毫秒时间戳）。 */
  at: number;
  level: "low" | "medium" | "high";
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
  /** 右下角气泡：最多 3 条，3 秒后自动移除。 */
  toasts: NoticeEntry[];
  /** 通知历史（倒序，最多 200 条），仅当前会话。 */
  notices: NoticeEntry[];
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

/** 判断路径是否位于指定目录内（跨 Windows/POSIX 分隔符）。 */
function isUnderRoot(filePath: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  return (
    filePath === normalizedRoot ||
    filePath.startsWith(`${normalizedRoot}\\`) ||
    filePath.startsWith(`${normalizedRoot}/`)
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 视图模式是否适用于指定格式；不适用时切换标签要回落到源码模式。 */
function modeSupported(mode: EditorMode, formatId: string): boolean {
  if (mode === "wysiwyg") return formatId === "markdown";
  // PDF/图片是二进制只读文档，固定使用专用预览面板。
  if (formatId === "pdf" || formatId === "image") return mode === "preview";
  // 分栏/预览只对具有渲染预览的格式开放；代码与纯文本只有源码模式。
  if (mode === "split" || mode === "preview") return formatHasPreview(formatId);
  return true;
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
    toasts: [],
    notices: [],
    conflict: null,
  };

  private readonly listeners = new Set<(state: AppState) => void>();
  /** 通知自增序号；用于历史列表的行标识。 */
  private noticeSeq = 0;
  /** 每条气泡独立的 3 秒关闭计时器。 */
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoSaveEnabled = true;
  private saveEol: SaveEol = "preserve";
  private modeSwitchNoticeShown = false;
  /** 每个文档最近一次使用的视图模式；切换标签时恢复，模式不适用时回落源码。 */
  private readonly modeByDocument = new Map<string, EditorMode>();

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

  /** 设置中的换行符策略：`preserve` 沿用文件已有换行。 */
  setSaveEol(eol: SaveEol): void {
    this.saveEol = eol;
  }

  private eolRequest(): { eol?: "lf" | "crlf" } {
    return this.saveEol === "preserve" ? {} : { eol: this.saveEol };
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
    this.rememberActiveMode();
    this.commit({
      documents: [...this.state.documents, document],
      activeId: id,
      mode: "wysiwyg",
    });
    this.scheduleSessionSave();
  }

  setActive(id: string): void {
    if (!this.state.documents.some((doc) => doc.id === id)) return;
    this.rememberActiveMode();
    this.commit({ activeId: id, mode: this.activationMode(id) });
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
      this.notify("error", t("该格式不支持所见即所得编辑，请使用源码模式"));
      return;
    }
    const isBinary = active?.format === "pdf" || active?.format === "image";
    if ((mode === "preview" || mode === "split") && active && !isBinary && !formatHasPreview(active.format)) {
      this.notify("error", t("该格式没有渲染预览，请使用源码模式"));
      return;
    }
    const firstSwitch = !this.modeSwitchNoticeShown;
    this.modeSwitchNoticeShown = true;
    if (this.state.activeId) this.modeByDocument.set(this.state.activeId, mode);
    this.commit({ mode });
    if (firstSwitch) {
      this.notify("info", t("撤销历史不跨模式共享，已为目标模式建立新的撤销基线"));
    }
  }

  /** 格式能力变化（另存为、扩展禁用）后校正当前模式，不支持的视图回落源码。 */
  revalidateActiveMode(): void {
    const active = this.findDocument(this.state.activeId ?? "");
    if (!active) return;
    if (modeSupported(this.state.mode, active.format)) return;
    this.modeByDocument.set(active.id, "source");
    this.commit({ mode: "source" });
  }

  /** 记住当前文档的视图模式，供切回该标签时恢复。 */
  private rememberActiveMode(): void {
    if (!this.state.activeId) return;
    this.modeByDocument.set(this.state.activeId, this.state.mode);
  }

  /** 激活指定文档时的视图模式：优先该文档上次的模式，不支持其格式时回落源码。 */
  private activationMode(id: string): EditorMode {
    const doc = this.findDocument(id);
    const preferred = this.modeByDocument.get(id) ?? this.state.mode;
    if (!doc) return preferred;
    return modeSupported(preferred, doc.format) ? preferred : "source";
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

  /** 源码模式的折叠行号列表，用于会话恢复。见 doc/design.md §21.6。 */
  updateFolds(id: string, folds: number[]): void {
    const doc = this.findDocument(id);
    if (!doc) return;
    if (folds.length === 0 && !doc.folds) return;
    if (
      doc.folds &&
      doc.folds.length === folds.length &&
      doc.folds.every((line, index) => line === folds[index])
    ) {
      return;
    }
    this.patchDocument(id, () => ({ folds: folds.length > 0 ? folds : undefined }));
  }

  /** 供导出等外部流程复用通知气泡与历史记录。 */
  showNotice(kind: Notice["kind"], message: string): void {
    this.notify(kind, message);
  }

  /** 仓库内未保存文档数量；Git 操作只读取磁盘内容。 */
  dirtyCountInRoot(root: string): number {
    return this.state.documents.filter((doc) => doc.dirty && doc.path && isUnderRoot(doc.path, root)).length;
  }

  /** 保存仓库内所有未保存文档；任一保存失败时返回 false。 */
  async saveDocumentsInRoot(root: string): Promise<boolean> {
    for (const doc of this.state.documents) {
      if (!doc.dirty || !doc.path || !isUnderRoot(doc.path, root)) continue;
      await this.saveDocument(doc.id, true);
      if (this.findDocument(doc.id)?.dirty) return false;
    }
    return true;
  }

  /** 手动关闭一条气泡（3 秒自动关闭也走这里）；历史记录保留。 */
  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    if (!this.state.toasts.some((toast) => toast.id === id)) return;
    this.commit({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  }

  /** 清空通知历史（不影响仍显示的气泡）。 */
  clearNotices(): void {
    this.commit({ notices: [] });
  }

  /** 删除单条通知历史。 */
  removeNotice(id: number): void {
    this.commit({ notices: this.state.notices.filter((entry) => entry.id !== id) });
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
      // 弹窗前取消自动保存：否则对话框停留超过 10 s 时会把修改写盘，
      // 用户选择“取消”后脏标记已经被清掉。
      const pendingAutosave = this.autosaveTimers.get(id);
      if (pendingAutosave) {
        clearTimeout(pendingAutosave);
        this.autosaveTimers.delete(id);
      }
      // 三选一：保存 / 不保存 / 取消；取消必须真正中止关闭且保留脏标记。
      const choice = await window.panda.dialog.confirmClose({ name: doc.name });
      if (choice === "cancel") return;
      if (choice === "save") {
        await this.saveDocument(id);
        const current = this.findDocument(id);
        if (current?.dirty) return;
      }
    }
    await this.releaseDocumentResources(doc);
    this.rememberActiveMode();
    this.modeByDocument.delete(id);
    const documents = this.state.documents.filter((item) => item.id !== id);
    const activeId =
      this.state.activeId === id ? (documents[documents.length - 1]?.id ?? null) : this.state.activeId;
    this.commit({
      documents,
      activeId,
      mode: activeId ? this.activationMode(activeId) : this.state.mode,
    });
    this.scheduleSessionSave();
  }

  async saveDocument(id: string, silent = false): Promise<void> {
    const doc = this.findDocument(id);
    if (!doc) return;
    if (doc.format === "pdf") {
      this.notify("info", t("PDF 文档为只读预览，无需保存"));
      return;
    }
    if (doc.format === "image") {
      this.notify("info", t("图片文档为只读预览，无需保存"));
      return;
    }
    if (!doc.path) {
      await this.saveDocumentAs(id);
      return;
    }
    if (doc.readOnly) {
      this.notify("error", t("该文档以只读方式打开，请使用“另存为”保存副本"));
      return;
    }
    if (doc.content === doc.savedContent) {
      this.patchDocument(id, () => ({ dirty: false }));
      if (!silent) this.notify("info", t("没有需要保存的修改"));
      return;
    }

    const content = doc.content;
    try {
      const result = await window.panda.fs.writeText({
        path: doc.path,
        content,
        baseHash: doc.hash,
        ...this.eolRequest(),
      });
      const current = this.findDocument(id);
      this.patchDocument(id, () => ({
        savedContent: content,
        dirty: (current?.content ?? content) !== content,
        hash: result.hash,
        mtimeMs: result.mtimeMs,
        size: byteLength(content),
        eol: this.saveEol === "preserve" ? doc.eol : this.saveEol,
      }));
      await this.dropDraft(id);
      if (!silent) this.notify("info", t("已保存"));
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
    // PDF 是二进制只读文档：content 不代表磁盘内容，另存为会写坏目标文件。
    if (doc.format === "pdf") {
      this.notify("error", t("PDF 文档为只读预览，不支持另存为"));
      return;
    }
    if (doc.format === "image") {
      this.notify("error", t("图片文档为只读预览，不支持另存为"));
      return;
    }
    try {
      const ref = await window.panda.dialog.saveAs({
        suggestedName: doc.path ? doc.name : "untitled.md",
      });
      if (!ref) return;

      const content = doc.content;
      await window.panda.fs.writeText({
        path: ref.path,
        content,
        baseHash: "",
        ...this.eolRequest(),
      });
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
      // 另存为可能改变格式（如 .md → .py）；当前模式不再适用时回落源码。
      this.revalidateActiveMode();
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
        ...this.eolRequest(),
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
    // 重命名可能改变格式（如 .md → .txt）；当前模式不适用时回落源码，避免面板全部隐藏。
    const renamed = this.findDocument(doc.id);
    if (renamed && renamed.id === this.state.activeId && !modeSupported(this.state.mode, renamed.format)) {
      this.modeByDocument.set(renamed.id, "source");
      this.commit({ mode: "source" });
    }
  }

  /** 工作区删除文件后关闭对应标签；本地仍有未保存修改时保留标签以免丢数据。 */
  async removeDocumentByPath(filePath: string): Promise<void> {
    const doc = this.state.documents.find((item) => item.path === filePath);
    if (!doc) return;
    if (doc.dirty) {
      this.notify("error", t("文件已在磁盘删除，标签保留未保存内容；请另存为"));
      this.patchDocument(doc.id, () => ({ readOnly: true }));
      return;
    }
    await this.releaseDocumentResources(doc);
    const documents = this.state.documents.filter((item) => item.id !== doc.id);
    const activeId = this.state.activeId === doc.id ? (documents[documents.length - 1]?.id ?? null) : this.state.activeId;
    this.rememberActiveMode();
    this.modeByDocument.delete(doc.id);
    this.commit({
      documents,
      activeId,
      mode: activeId ? this.activationMode(activeId) : this.state.mode,
    });
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
      await this.openRef(ref, { silentRecent: true, silentErrors: true, mode: entry.mode });
      const doc = this.state.documents.find((item) => item.path === entry.path);
      if (doc) {
        // 会话中的每文档模式作为该标签的偏好在切回时恢复。
        this.modeByDocument.set(doc.id, entry.mode);
        this.patchDocument(doc.id, () => ({
          cursor: entry.cursor,
          folds: entry.folds,
        }));
      }
    }
    const active = this.state.documents[Math.min(session.activeIndex, this.state.documents.length - 1)];
    if (active) {
      if (!this.modeByDocument.has(active.id)) this.modeByDocument.set(active.id, session.mode);
      this.commit({ activeId: active.id, mode: this.activationMode(active.id) });
    } else {
      this.commit({ mode: session.mode });
    }
    if (session.documents.length > 0 && this.state.documents.length < session.documents.length) {
      this.notify("info", t("部分标签对应的文件已不存在，已跳过恢复"));
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
      this.rememberActiveMode();
      // 草稿对应的新文档是 Markdown，直接以所见即所得打开。
      this.commit({
        documents: [...this.state.documents, created],
        activeId: id,
        mode: "wysiwyg",
      });
      return;
    }
    this.patchDocument(doc.id, (current) => ({
      content: entry.content,
      dirty: entry.content !== current.savedContent,
      revision: current.revision + 1,
      draftKey: entry.key,
      cursor: entry.cursor,
    }));
    this.rememberActiveMode();
    this.commit({ activeId: doc.id, mode: this.activationMode(doc.id) });
  }

  async discardDraft(key: string): Promise<void> {
    await window.panda.drafts.remove(key).catch(() => undefined);
  }

  /** 会话快照：供主进程写入 `session.json`。 */
  buildSession(args: {
    mode: EditorMode;
    sidebarVisible: boolean;
    recent: RecentEntry[];
    workspace?: WorkspaceSessionState;
  }): SessionState {
    return {
      documents: this.state.documents.map((doc) => ({
        path: doc.path,
        mode: this.modeByDocument.get(doc.id) ?? args.mode,
        cursor: doc.cursor,
        folds: doc.folds,
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
    options: { silentRecent?: boolean; silentErrors?: boolean; mode?: EditorMode } = {},
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
        throw new PandaError("E_FILE_TOO_LARGE", t("文件超过 50 MB，拒绝打开：{0}", ref.name));
      }
      if (
        policy.confirm &&
        !window.confirm(
          t("文件约 {0} MB，打开可能较慢，是否继续？", (stats.size / (1024 * 1024)).toFixed(1)),
        )
      ) {
        return;
      }
      // PDF/图片是二进制文档：不读文本，只读元数据并以只读预览打开。
      const formatId = detectFormatEntry(ref.name)?.id ?? "text";
      const isBinary = formatId === "pdf" || formatId === "image";
      const data = isBinary ? null : await window.panda.fs.readText({ path: ref.path });
      const watchId = await this.watchFile(ref.path);
      let forceSource = policy.preferSource;
      let blockLimit = false;
      if (data && !forceSource && detectFormatEntry(ref.name)?.id === "markdown") {
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
        format: formatId,
        content: data ? data.content : "",
        savedContent: data ? data.content : "",
        dirty: false,
        eol: data ? data.eol : "lf",
        bom: data ? data.bom : false,
        encoding: data ? data.encoding : "utf-8",
        // PDF/图片以只读预览打开，不允许编辑与写回。
        readOnly: data ? data.readOnly : true,
        hash: data ? data.hash : "",
        mtimeMs: data ? data.mtimeMs : stats.mtimeMs,
        size: data ? data.size : stats.size,
        revision: 0,
        draftKey: null,
        watchId,
      };
      this.rememberActiveMode();
      // 新打开的 Markdown 文档默认进入预览模式；大文件等强制源码的情况除外。
      // 切换标签时按 modeByDocument 恢复该标签上次使用的模式；会话恢复时用 entry.mode 覆盖。
      const desiredMode: EditorMode = isBinary
        ? "preview"
        : forceSource
          ? "source"
          : (options.mode ??
            (document.format === "markdown" ? "preview" : this.state.mode));
      const mode = isBinary || modeSupported(desiredMode, document.format) ? desiredMode : "source";
      this.modeByDocument.set(document.id, mode);
      this.commit({
        documents: [...this.state.documents, document],
        activeId: document.id,
        mode,
      });
      if (blockLimit) {
        this.notify("info", t("文档顶层块超过 8000，已默认切换到源码模式"));
      } else if (policy.preferSource) {
        this.notify("info", t("文件较大，已默认切换到源码模式"));
      }
      if (!options.silentRecent) {
        await window.panda.recent.add({ path: ref.path }).catch(() => undefined);
      }
      if (data?.readOnly) {
        this.notify("info", t("编码 {0} 暂不支持写回，已以只读方式打开", data.encoding));
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
            message: t("文件已被删除或移动，本地仍有未保存修改"),
            localMtimeMs: doc.mtimeMs,
          },
        });
      } else {
        this.notify("error", t("文件已被删除或移动，标签内容仍保留为只读"));
        this.patchDocument(doc.id, () => ({ readOnly: true }));
      }
      return;
    }
    if (!doc.path) return;
    // PDF/图片是二进制只读文档：外部修改只更新元数据并提示重新打开，不做文本重读。
    if (doc.format === "pdf" || doc.format === "image") {
      try {
        const stats = await window.panda.fs.stat({ path: doc.path });
        this.patchDocument(doc.id, () => ({ mtimeMs: stats.mtimeMs, size: stats.size }));
        this.notify("info", t(doc.format === "pdf" ? "PDF 文件已在外部更新" : "文件已在外部更新"));
      } catch {
        // 文件消失由 unlink 分支处理
      }
      return;
    }
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
        this.notify("info", t("文件已在外部修改，已重新加载"));
      } else {
        this.commit({
          conflict: {
            documentId: doc.id,
            message: t("文件已被外部修改（磁盘 {0}）", formatTime(data.mtimeMs)),
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
    const entry: NoticeEntry = {
      id: (this.noticeSeq += 1),
      kind,
      message,
      at: Date.now(),
      level: kind === "error" ? "high" : "low",
    };
    // 气泡最多 3 条（新的在上）；历史最多 200 条，均按时间倒序。
    const toasts = [entry, ...this.state.toasts].slice(0, 3);
    const notices = [entry, ...this.state.notices].slice(0, 200);
    this.state = { ...this.state, toasts, notices };
    for (const listener of this.listeners) listener(this.state);
    // 被挤出的气泡清理计时器，避免无意义回调。
    for (const [id, timer] of this.toastTimers) {
      if (!toasts.some((toast) => toast.id === id)) {
        clearTimeout(timer);
        this.toastTimers.delete(id);
      }
    }
    this.toastTimers.set(
      entry.id,
      setTimeout(() => this.dismissToast(entry.id), 3000),
    );
  }

  private reportError(error: unknown): void {
    this.notify("error", describeError(error));
  }
}
