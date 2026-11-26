import { z } from "zod";
import type { GitDiffRequest, GitDiffResult } from "./diff";
import { REMOTE_NAME_PATTERN } from "./git";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCompareResult,
  GitSnapshot,
} from "./git";
import type { PandaErrorPayload } from "./errors";
import type { MenuCommand } from "./menu";
import type { GitPullStrategy, Settings } from "./settings";
import type {
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

/** 关闭全部且有未保存文档时用户的四种选择。 */
export type CloseAllDocumentsChoice = "saveAll" | "discardAll" | "askOneByOne" | "cancel";

export interface ConfirmCloseRequest {
  name: string;
}

export interface ConfirmCloseAllRequest {
  total: number;
  dirty: number;
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

/** 粘贴/拖入图片：写入文档目录 `assets/`，返回 Markdown 中使用的相对路径。 */
export interface SaveImageRequest {
  /** 当前文档的绝对路径（用于确定 assets 目录）。 */
  documentPath: string;
  /** 图片字节。 */
  data: Uint8Array;
  /** 图片 MIME，如 `image/png`。 */
  mime: string;
  /** 原始文件名，仅用于日志与提示。 */
  fileName?: string;
}

export interface SaveImageResult {
  /** 相对当前文档的路径（POSIX 分隔符），如 `assets/20261114-101500-abcd1234.png`。 */
  path: string;
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
  /** 折叠起始行号列表（源码编辑器折叠状态）。见 doc/design.md §21.6。 */
  folds?: number[];
  /** 标签是否固定；固定标签不参与关闭全部且始终排在最左侧。 */
  pinned?: boolean;
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
  chromiumVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
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

/** 渲染进程先弹另存为确认路径，主进程只负责打印与写盘。 */
export interface PdfExportRequest {
  html: string;
  path: string;
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
      folds: z.array(z.number().int().min(1)).optional(),
      pinned: z.boolean().optional(),
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
  "dialog:confirmCloseAll": z.object({ total: z.number().int().min(0), dirty: z.number().int().min(0) }),
  "fs:readText": z.object({ path: z.string().min(1) }),
  "fs:writeText": z.object({
    path: z.string().min(1),
    content: z.string(),
    baseHash: z.string(),
    eol: z.enum(["lf", "crlf"]).optional(),
  }),
  "fs:readBase64": z.object({ path: z.string().min(1) }),
  "fs:saveImage": z.object({
    documentPath: z.string().min(1),
    data: z.instanceof(Uint8Array),
    mime: z.string().min(1).max(120),
    fileName: z.string().max(260).optional(),
  }),
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
  "git:snapshot": z.object({ path: z.string().min(1) }),
  "git:stage": z.object({
    root: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(2000),
  }),
  "git:unstage": z.object({
    root: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(2000),
  }),
  "git:discard": z.object({
    root: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1).max(2000),
  }),
  "git:commit": z.object({
    root: z.string().min(1),
    message: z.string().trim().min(1).max(10000),
    amend: z.boolean(),
  }),
  "git:branches": z.object({ root: z.string().min(1) }),
  "git:checkout": z.object({
    root: z.string().min(1),
    branch: z.string().min(1).max(255),
    create: z.boolean(),
  }),
  "git:deleteBranch": z.object({ root: z.string().min(1), branch: z.string().min(1).max(255) }),
  "git:pull": z.object({
    root: z.string().min(1),
    /** 本次拉取是否改用变基：省略或 config 表示普通 git pull，rebase 表示 git pull --rebase。 */
    strategy: z.enum(["config", "rebase"]).optional(),
  }),
  "git:push": z.object({
    root: z.string().min(1),
    setUpstream: z.boolean(),
    /** 强制推送（--force）：用本地分支覆盖远端分支。 */
    force: z.boolean().optional(),
  }),
  "git:addRemote": z.object({
    root: z.string().min(1),
    /** 远程名：Git 允许的字符集，且不能以连字符开头（避免被当成选项）。 */
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(REMOTE_NAME_PATTERN, "远程名只能包含字母、数字、点、下划线与连字符"),
    url: z.string().trim().min(1).max(2048),
  }),
  "git:setRemoteUrl": z.object({
    root: z.string().min(1),
    /** 已存在的远程名，界面上只能从列表里选，不重新校验字符集。 */
    name: z.string().trim().min(1).max(64),
    url: z.string().trim().min(1).max(2048),
  }),
  "git:removeRemote": z.object({
    root: z.string().min(1),
    /** 已存在的远程名；不重新校验字符集，名字不存在时由主进程归一化为「远程不存在」。 */
    name: z.string().trim().min(1).max(64),
  }),
  "git:log": z.object({
    root: z.string().min(1),
    limit: z.number().int().min(1).max(200),
    skip: z.number().int().min(0).optional(),
  }),
  "git:commitDetail": z.object({
    root: z.string().min(1),
    hash: z.string().min(1).max(64),
  }),
  "git:fileLog": z.object({
    path: z.string().min(1),
    limit: z.number().int().min(1).max(200),
    skip: z.number().int().min(0).optional(),
  }),
  "git:resolveRef": z.object({
    path: z.string().min(1),
    ref: z.string().min(1).max(255),
  }),
  "git:compare": z.object({
    root: z.string().min(1),
    base: z.string().min(1).max(255),
    target: z.string().max(255).optional(),
  }),
  "git:abort": z.object({ root: z.string().min(1) }),
  "git:continue": z.object({ root: z.string().min(1) }),
  "fs:trash": z.object({ path: z.string().min(1) }),
  "export:pdf": z.object({ html: z.string(), path: z.string().min(1) }),
  "latex:detect": z.undefined(),
  "latex:compile": z.object({ jobId: z.string().min(1), rootPath: z.string().min(1) }),
  "app:pendingOpenPaths": z.undefined(),
  "app:getInfo": z.undefined(),
  "app:setTitleBarColor": z.object({
    /** CSS 计算出的工具栏背景色，如 #252526；主进程据此设置系统标题栏。 */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
} as const;

export type IpcChannel = keyof typeof ipcRequestSchemas;

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcRequestSchemas)[C]>;

export interface IpcResponseMap {
  "dialog:openFiles": FileRef[];
  "dialog:openDirectory": FileRef | null;
  "dialog:saveAs": FileRef | null;
  "dialog:confirmClose": CloseDocumentChoice;
  "dialog:confirmCloseAll": CloseAllDocumentsChoice;
  "fs:readText": ReadTextResult;
  "fs:writeText": WriteTextResult;
  "fs:readBase64": ReadBase64Result;
  "fs:saveImage": SaveImageResult;
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
  "git:snapshot": GitSnapshot;
  "git:stage": GitSnapshot;
  "git:unstage": GitSnapshot;
  "git:discard": GitSnapshot;
  "git:commit": GitSnapshot;
  "git:branches": GitBranch[];
  "git:checkout": GitSnapshot;
  "git:deleteBranch": GitSnapshot;
  "git:pull": GitSnapshot;
  "git:push": GitSnapshot;
  "git:addRemote": GitSnapshot;
  "git:setRemoteUrl": GitSnapshot;
  "git:removeRemote": GitSnapshot;
  "git:log": GitCommit[];
  "git:commitDetail": GitCommitDetail;
  "git:fileLog": GitCommit[];
  "git:resolveRef": string | null;
  "git:compare": GitCompareResult;
  "git:abort": GitSnapshot;
  "git:continue": GitSnapshot;
  "fs:trash": void;
  "export:pdf": PdfExportResult;
  "latex:detect": EngineStatus;
  "latex:compile": CompileResult;
  "app:pendingOpenPaths": string[];
  "app:getInfo": AppInfo;
  "app:setTitleBarColor": void;
}

/** `window.panda`：渲染进程可访问的全部平台能力。 */
export interface PandaApi {
  dialog: {
    openFiles(request?: OpenFilesRequest): Promise<FileRef[]>;
    openDirectory(): Promise<FileRef | null>;
    saveAs(request: SaveAsRequest): Promise<FileRef | null>;
    /** 关闭未保存文档时的三选一确认。 */
    confirmClose(request: ConfirmCloseRequest): Promise<CloseDocumentChoice>;
    /** 关闭全部且有未保存文档时的四选一确认。 */
    confirmCloseAll(request: ConfirmCloseAllRequest): Promise<CloseAllDocumentsChoice>;
  };
  fs: {
    readText(request: ReadTextRequest): Promise<ReadTextResult>;
    writeText(request: WriteTextRequest): Promise<WriteTextResult>;
    readBase64(request: ReadBase64Request): Promise<ReadBase64Result>;
    /** 把粘贴/拖入的图片写入文档目录 assets/，返回相对路径。 */
    saveImage(request: SaveImageRequest): Promise<SaveImageResult>;
    readDir(request: ReadDirRequest): Promise<ReadDirResult>;
    stat(request: StatRequest): Promise<StatResult>;
    /** 登记系统拖入的路径并返回是否文件。 */
    inspectDrop(request: StatRequest): Promise<{ ref: FileRef; isFile: boolean }>;
    create(request: CreateRequest): Promise<FileRef>;
    rename(request: RenameRequest): Promise<FileRef>;
    remove(request: DeleteRequest): Promise<void>;
    /** 将文件移入系统回收站。 */
    trash(request: { path: string }): Promise<void>;
    watch(request: WatchRequest): Promise<WatchResult>;
    unwatch(request: { watchId: string }): Promise<void>;
  };
  workspace: {
    open(request: WorkspaceOpenRequest): Promise<WorkspaceOpenResult>;
  };
  git: {
    /** 读取渲染进程指定基线的旧文本；当前文本由渲染进程提供。 */
    diff(request: GitDiffRequest): Promise<GitDiffResult>;
    snapshot(request: { path: string }): Promise<GitSnapshot>;
    stage(request: { root: string; paths: string[] }): Promise<GitSnapshot>;
    unstage(request: { root: string; paths: string[] }): Promise<GitSnapshot>;
    discard(request: { root: string; paths: string[] }): Promise<GitSnapshot>;
    commit(request: { root: string; message: string; amend: boolean }): Promise<GitSnapshot>;
    branches(request: { root: string }): Promise<GitBranch[]>;
    checkout(request: { root: string; branch: string; create: boolean }): Promise<GitSnapshot>;
    deleteBranch(request: { root: string; branch: string }): Promise<GitSnapshot>;
    pull(request: { root: string; strategy?: GitPullStrategy }): Promise<GitSnapshot>;
    push(request: { root: string; setUpstream: boolean; force?: boolean }): Promise<GitSnapshot>;
    addRemote(request: { root: string; name: string; url: string }): Promise<GitSnapshot>;
    setRemoteUrl(request: { root: string; name: string; url: string }): Promise<GitSnapshot>;
    removeRemote(request: { root: string; name: string }): Promise<GitSnapshot>;
    log(request: { root: string; limit: number; skip?: number }): Promise<GitCommit[]>;
    commitDetail(request: { root: string; hash: string }): Promise<GitCommitDetail>;
    fileLog(request: { path: string; limit: number; skip?: number }): Promise<GitCommit[]>;
    resolveRef(request: { path: string; ref: string }): Promise<string | null>;
    compare(request: { root: string; base: string; target?: string }): Promise<GitCompareResult>;
    abort(request: { root: string }): Promise<GitSnapshot>;
    continue(request: { root: string }): Promise<GitSnapshot>;
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
    /** 把 CSS 中的工具栏颜色同步给系统标题栏，消除深浅主题下的色差。 */
    setTitleBarColor(request: { color: string }): Promise<void>;
  };
  export: {
    pdf(request: PdfExportRequest): Promise<PdfExportResult>;
  };
  latex: {
    detect(): Promise<EngineStatus>;
    compile(request: CompileRequest): Promise<CompileResult>;
  };
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onFsChanged(listener: (event: FsChangedEvent) => void): () => void;
  /** 第二实例或文件关联传入的待打开文件。 */
  onOpenPath(listener: (path: string) => void): () => void;
  /** 系统拖入文件的真实路径；无路径时返回空字符串。 */
  getPathForFile(file: File): string;
}
