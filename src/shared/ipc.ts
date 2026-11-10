import { z } from "zod";
import type { GitDiffRequest, GitDiffResult } from "./diff";
import type { PandaErrorPayload } from "./errors";
import type { MenuCommand } from "./menu";
import type { Settings } from "./settings";
import type {
  ExtensionCommandInfo,
  ExtensionFormatInfo,
  ExtensionInfo,
  ExtensionParseResult,
  ExtensionPreviewResult,
} from "./extensions";

export type { MenuCommand } from "./menu";

export { FS_CHANGED_CHANNEL } from "./events";

/** 文件对话框过滤器，与 Electron `FileFilter` 结构一致。 */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * 文件引用。`rootId` 是该文件所在目录的稳定标识，仅用于构造 `panda-res://` 资源地址，
 * 不暴露目录绝对路径。见 doc/design.md §12.6、§13.5。
 */
export interface FileRef {
  path: string;
  name: string;
  rootId: string;
}

export type Eol = "lf" | "crlf";

/** 检测到的文本编码；非 UTF-8 时以只读方式打开。 */
export type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "unknown";

export type EditorMode = "wysiwyg" | "split" | "source" | "preview" | "git";

export interface OpenFilesRequest {
  filters?: FileFilter[];
}

export interface SaveAsRequest {
  suggestedName: string;
  filters?: FileFilter[];
}

/** 关闭有未保存修改的文档时用户的三种选择。 */
export type CloseDocumentChoice = "save" | "discard" | "cancel";

export interface ConfirmCloseRequest {
  name: string;
}

export interface ReadTextRequest {
  path: string;
}

export interface ReadTextResult {
  content: string;
  mtimeMs: number;
  hash: string;
  eol: Eol;
  bom: boolean;
  encoding: TextEncoding;
  size: number;
  readOnly: boolean;
}

export interface WriteTextRequest {
  path: string;
  content: string;
  baseHash: string;
  /** 覆盖保存时的换行符；省略时沿用文件已有换行。 */
  eol?: "lf" | "crlf";
}

export interface WriteTextResult {
  mtimeMs: number;
  hash: string;
}

export interface ReadBase64Request {
  path: string;
}

export interface ReadBase64Result {
  data: string;
  mime: string;
  size: number;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
}

export interface ReadDirRequest {
  path: string;
}

export interface ReadDirResult {
  entries: DirEntry[];
}

export interface CreateRequest {
  path: string;
  kind: "file" | "dir";
}

export interface RenameRequest {
  path: string;
  /** 只允许纯文件名；包含路径分隔符会被主进程拒绝。见 §13.5。 */
  newName: string;
}

export interface DeleteRequest {
  path: string;
  recursive?: boolean;
}

export interface WatchRequest {
  paths: string[];
}

export interface WatchResult {
  watchId: string;
}

export interface FileChange {
  path: string;
  type: "add" | "change" | "unlink";
}

/** 主进程 → 渲染进程：`fs:changed` 事件载荷。监听器已按 300/500 ms 合并。 */
export interface FsChangedEvent {
  watchId: string;
  changes: FileChange[];
}

export interface WorkspaceOpenRequest {
  path: string;
}

export interface WorkspaceOpenResult {
  root: FileRef;
  entries: DirEntry[];
}

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

export interface SessionDocumentState {
  path: string | null;
  mode: EditorMode;
  cursor?: { line: number; column: number };
  scrollTop?: number;
}

/** 工作区状态：可同时打开多个根目录。见 doc/design.md §12.5。 */
export interface WorkspaceSessionState {
  /** 兼容单根目录的旧会话。 */
  rootPath?: string;
  expanded?: string[];
  roots?: { rootPath: string; expanded: string[] }[];
}

export interface WindowBoundsState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/** 会话文件 `userData/session.json`。见 doc/design.md §12.4。 */
export interface SessionState {
  documents: SessionDocumentState[];
  activeIndex: number;
  mode: EditorMode;
  sidebarVisible: boolean;
  recent: string[];
  workspace?: WorkspaceSessionState;
  window?: WindowBoundsState;
}

/** 崩溃恢复草稿；`key` 由主进程按 §12.4 规则计算。 */
export interface DraftPayload {
  path: string | null;
  content: string;
  cursor?: { line: number; column: number };
  scrollTop?: number;
  savedAt: number;
}

export interface DraftEntry extends DraftPayload {
  key: string;
}

export interface SaveDraftResult {
  key: string;
}

export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
}

export interface StatRequest {
  path: string;
}

export interface StatResult {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface PdfExportRequest {
  html: string;
  suggestedName: string;
}

export interface PdfExportResult {
  path: string;
}

export type EngineId = "tectonic" | "latexmk" | "xelatex";

export interface EngineInfo {
  id: EngineId;
  path: string;
  version: string;
}

export interface EngineStatus {
  available: boolean;
  engines: EngineInfo[];
}

export interface TexDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface CompileRequest {
  jobId: string;
  /** 编译根文件，必须位于允许根目录内且已保存。 */
  rootPath: string;
}

export interface CompileResult {
  ok: boolean;
  pdfKey?: string;
  diagnostics: TexDiagnostic[];
}

export interface UpdateStatus {
  status: "not-configured" | "latest" | "available" | "error";
  currentVersion: string;
  latestVersion?: string;
  message?: string;
}

export type IpcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: PandaErrorPayload };

const FileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(z.string().min(1)),
});

const EditorModeSchema = z.enum(["wysiwyg", "split", "source", "preview", "git"]);
const CursorSchema = z.object({ line: z.number().int().min(1), column: z.number().int().min(1) });

const SessionSchema = z.object({
  documents: z.array(
    z.object({
      path: z.string().nullable(),
      mode: EditorModeSchema,
      cursor: CursorSchema.optional(),
      scrollTop: z.number().optional(),
    }),
  ),
  activeIndex: z.number().int().min(0),
  mode: EditorModeSchema,
  sidebarVisible: z.boolean(),
  recent: z.array(z.string()),
  workspace: z
    .object({
      rootPath: z.string().min(1).optional(),
      expanded: z.array(z.string()).optional(),
      roots: z
        .array(
          z.object({
            rootPath: z.string().min(1),
            expanded: z.array(z.string()),
          }),
        )
        .optional(),
    })
    .optional(),
  window: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(200),
      height: z.number().min(200),
      maximized: z.boolean().optional(),
    })
    .optional(),
});

const DraftSchema = z.object({
  path: z.string().nullable(),
  content: z.string(),
  cursor: CursorSchema.optional(),
  scrollTop: z.number().optional(),
  savedAt: z.number(),
});

/** 供主进程复用：会话与草稿落盘前做同一套结构校验。 */
export const sessionStateSchema = SessionSchema;
export const draftPayloadSchema = DraftSchema;

/** 主进程入口校验用 schema；与通道响应的 TypeScript 类型成对维护。见 §13.1。 */
export const ipcRequestSchemas = {
  "dialog:openFiles": z.object({ filters: z.array(FileFilterSchema).optional() }).optional(),
  "dialog:openDirectory": z.undefined(),
  "dialog:saveAs": z.object({
    suggestedName: z.string().min(1),
    filters: z.array(FileFilterSchema).optional(),
  }),
  "dialog:confirmClose": z.object({ name: z.string().min(1) }),
  "fs:readText": z.object({ path: z.string().min(1) }),
  "fs:writeText": z.object({
    path: z.string().min(1),
    content: z.string(),
    baseHash: z.string(),
    eol: z.enum(["lf", "crlf"]).optional(),
  }),
  "fs:readBase64": z.object({ path: z.string().min(1) }),
  "fs:readDir": z.object({ path: z.string().min(1) }),
  "fs:create": z.object({ path: z.string().min(1), kind: z.enum(["file", "dir"]) }),
  "fs:rename": z.object({ path: z.string().min(1), newName: z.string().min(1) }),
  "fs:delete": z.object({ path: z.string().min(1), recursive: z.boolean().optional() }),
  "fs:watch": z.object({ paths: z.array(z.string().min(1)).min(1) }),
  "fs:unwatch": z.object({ watchId: z.string().min(1) }),
  "workspace:open": z.object({ path: z.string().min(1) }),
  "settings:get": z.undefined(),
  "settings:update": z.object({ settings: z.record(z.string(), z.unknown()) }),
  "session:load": z.undefined(),
  "session:save": z.object({ state: SessionSchema }),
  "recent:list": z.undefined(),
  "recent:add": z.object({ path: z.string().min(1) }),
  "recent:remove": z.object({ path: z.string().min(1) }),
  "recent:clear": z.undefined(),
  "draft:list": z.undefined(),
  "draft:save": z.object({ key: z.string().min(1).optional(), draft: DraftSchema }),
  "draft:remove": z.object({ key: z.string().min(1) }),
  "shell:reveal": z.object({ path: z.string().min(1) }),
  "shell:openExternal": z.object({ url: z.string().min(1) }),
  "ext:list": z.undefined(),
  "ext:formats": z.undefined(),
  "ext:commands": z.undefined(),
  "ext:install": z.undefined(),
  "ext:enable": z.object({ id: z.string().min(1) }),
  "ext:disable": z.object({ id: z.string().min(1) }),
  "ext:uninstall": z.object({ id: z.string().min(1) }),
  "ext:openFolder": z.object({ id: z.string().min(1).optional() }).optional(),
  "ext:reload": z.object({ id: z.string().min(1) }),
  "ext:preview": z.object({
    extensionId: z.string().min(1),
    providerId: z.string().min(1),
    doc: z.unknown(),
    path: z.string().nullable().optional(),
  }),
  "ext:parse": z.object({
    extensionId: z.string().min(1),
    providerId: z.string().min(1),
    source: z.string(),
    path: z.string().nullable().optional(),
  }),
  "ext:serialize": z.object({
    extensionId: z.string().min(1),
    providerId: z.string().min(1),
    doc: z.unknown(),
  }),
  "ext:command": z.object({ id: z.string().min(1), args: z.unknown().optional() }),
  "fs:stat": z.object({ path: z.string().min(1) }),
  "fs:inspectDrop": z.object({ path: z.string().min(1) }),
  "git:diff": z
    .object({
      path: z.string().min(1),
      base: z.enum(["head", "index", "commit"]),
      ref: z.string().trim().min(1).max(120).optional(),
      newText: z.string(),
    })
    .refine((value) => value.base !== "commit" || (value.ref?.length ?? 0) > 0, {
      message: "指定提交基线需要提供 ref",
    }),
  "export:pdf": z.object({ html: z.string(), suggestedName: z.string().min(1) }),
  "latex:detect": z.undefined(),
  "latex:compile": z.object({ jobId: z.string().min(1), rootPath: z.string().min(1) }),
  "app:pendingOpenPaths": z.undefined(),
  "update:check": z.undefined(),
  "app:getInfo": z.undefined(),
} as const;

export type IpcChannel = keyof typeof ipcRequestSchemas;

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcRequestSchemas)[C]>;

export interface IpcResponseMap {
  "dialog:openFiles": FileRef[];
  "dialog:openDirectory": FileRef | null;
  "dialog:saveAs": FileRef | null;
  "dialog:confirmClose": CloseDocumentChoice;
  "fs:readText": ReadTextResult;
  "fs:writeText": WriteTextResult;
  "fs:readBase64": ReadBase64Result;
  "fs:readDir": ReadDirResult;
  "fs:create": FileRef;
  "fs:rename": FileRef;
  "fs:delete": void;
  "fs:watch": WatchResult;
  "fs:unwatch": void;
  "workspace:open": WorkspaceOpenResult;
  "settings:get": Settings;
  "settings:update": Settings;
  "session:load": SessionState | null;
  "session:save": void;
  "recent:list": RecentEntry[];
  "recent:add": RecentEntry[];
  "recent:remove": RecentEntry[];
  "recent:clear": RecentEntry[];
  "draft:list": DraftEntry[];
  "draft:save": SaveDraftResult;
  "draft:remove": void;
  "shell:reveal": void;
  "shell:openExternal": void;
  "ext:list": ExtensionInfo[];
  "ext:formats": ExtensionFormatInfo[];
  "ext:commands": ExtensionCommandInfo[];
  "ext:install": ExtensionInfo;
  "ext:enable": void;
  "ext:disable": void;
  "ext:uninstall": void;
  "ext:openFolder": void;
  "ext:reload": void;
  "ext:preview": ExtensionPreviewResult;
  "ext:parse": ExtensionParseResult;
  "ext:serialize": { source: string };
  "ext:command": unknown;
  "fs:stat": StatResult;
  "fs:inspectDrop": { ref: FileRef; isFile: boolean };
  "git:diff": GitDiffResult;
  "export:pdf": PdfExportResult;
  "latex:detect": EngineStatus;
  "latex:compile": CompileResult;
  "app:pendingOpenPaths": string[];
  "update:check": UpdateStatus;
  "app:getInfo": AppInfo;
}

/** `window.panda`：渲染进程可访问的全部平台能力。 */
export interface PandaApi {
  dialog: {
    openFiles(request?: OpenFilesRequest): Promise<FileRef[]>;
    openDirectory(): Promise<FileRef | null>;
    saveAs(request: SaveAsRequest): Promise<FileRef | null>;
    /** 关闭未保存文档时的三选一确认。 */
    confirmClose(request: ConfirmCloseRequest): Promise<CloseDocumentChoice>;
  };
  fs: {
    readText(request: ReadTextRequest): Promise<ReadTextResult>;
    writeText(request: WriteTextRequest): Promise<WriteTextResult>;
    readBase64(request: ReadBase64Request): Promise<ReadBase64Result>;
    readDir(request: ReadDirRequest): Promise<ReadDirResult>;
    stat(request: StatRequest): Promise<StatResult>;
    /** 登记系统拖入的路径并返回是否文件。 */
    inspectDrop(request: StatRequest): Promise<{ ref: FileRef; isFile: boolean }>;
    create(request: CreateRequest): Promise<FileRef>;
    rename(request: RenameRequest): Promise<FileRef>;
    remove(request: DeleteRequest): Promise<void>;
    watch(request: WatchRequest): Promise<WatchResult>;
    unwatch(request: { watchId: string }): Promise<void>;
  };
  workspace: {
    open(request: WorkspaceOpenRequest): Promise<WorkspaceOpenResult>;
  };
  git: {
    /** 读取渲染进程指定基线的旧文本；当前文本由渲染进程提供。 */
    diff(request: GitDiffRequest): Promise<GitDiffResult>;
  };
  settings: {
    get(): Promise<Settings>;
    update(settings: Settings): Promise<Settings>;
  };
  session: {
    load(): Promise<SessionState | null>;
    save(state: SessionState): Promise<void>;
  };
  recent: {
    list(): Promise<RecentEntry[]>;
    add(request: { path: string }): Promise<RecentEntry[]>;
    remove(request: { path: string }): Promise<RecentEntry[]>;
    clear(): Promise<RecentEntry[]>;
  };
  drafts: {
    list(): Promise<DraftEntry[]>;
    save(request: { key?: string; draft: DraftPayload }): Promise<SaveDraftResult>;
    remove(key: string): Promise<void>;
  };
  shell: {
    reveal(path: string): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  ext: {
    list(): Promise<ExtensionInfo[]>;
    formats(): Promise<ExtensionFormatInfo[]>;
    commands(): Promise<ExtensionCommandInfo[]>;
    install(): Promise<ExtensionInfo>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    uninstall(id: string): Promise<void>;
    openFolder(id?: string): Promise<void>;
    reload(id: string): Promise<void>;
    preview(request: {
      extensionId: string;
      providerId: string;
      doc: unknown;
      path?: string | null;
    }): Promise<ExtensionPreviewResult>;
    parse(request: {
      extensionId: string;
      providerId: string;
      source: string;
      path?: string | null;
    }): Promise<ExtensionParseResult>;
    serialize(request: {
      extensionId: string;
      providerId: string;
      doc: unknown;
    }): Promise<{ source: string }>;
    command(id: string, args?: unknown): Promise<unknown>;
  };
  app: {
    getInfo(): Promise<AppInfo>;
    /** 启动参数或文件关联带来的待打开路径；取走即清空。 */
    pendingOpenPaths(): Promise<string[]>;
  };
  export: {
    pdf(request: PdfExportRequest): Promise<PdfExportResult>;
  };
  latex: {
    detect(): Promise<EngineStatus>;
    compile(request: CompileRequest): Promise<CompileResult>;
  };
  update: {
    check(): Promise<UpdateStatus>;
  };
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onFsChanged(listener: (event: FsChangedEvent) => void): () => void;
  /** 第二实例或文件关联传入的待打开文件。 */
  onOpenPath(listener: (path: string) => void): () => void;
  /** 系统拖入文件的真实路径；无路径时返回空字符串。 */
  getPathForFile(file: File): string;
}
