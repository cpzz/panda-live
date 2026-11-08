import { z } from "zod";
import type { PandaErrorPayload } from "./errors";
import type { MenuCommand } from "./menu";

export type { MenuCommand } from "./menu";

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

export interface OpenFilesRequest {
  filters?: FileFilter[];
}

export interface SaveAsRequest {
  suggestedName: string;
  filters?: FileFilter[];
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
}

export interface WriteTextResult {
  mtimeMs: number;
  hash: string;
}

export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
}

export type IpcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: PandaErrorPayload };

const FileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(z.string().min(1)),
});

/** 主进程入口校验用 schema；与通道响应的 TypeScript 类型成对维护。 */
export const ipcRequestSchemas = {
  "dialog:openFiles": z.object({ filters: z.array(FileFilterSchema).optional() }).optional(),
  "dialog:saveAs": z.object({
    suggestedName: z.string().min(1),
    filters: z.array(FileFilterSchema).optional(),
  }),
  "fs:readText": z.object({ path: z.string().min(1) }),
  "fs:writeText": z.object({
    path: z.string().min(1),
    content: z.string(),
    baseHash: z.string(),
  }),
  "app:getInfo": z.undefined(),
} as const;

export type IpcChannel = keyof typeof ipcRequestSchemas;

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof ipcRequestSchemas)[C]>;

export interface IpcResponseMap {
  "dialog:openFiles": FileRef[];
  "dialog:saveAs": FileRef | null;
  "fs:readText": ReadTextResult;
  "fs:writeText": WriteTextResult;
  "app:getInfo": AppInfo;
}

/** `window.panda`：渲染进程可访问的全部平台能力。 */
export interface PandaApi {
  dialog: {
    openFiles(request?: OpenFilesRequest): Promise<FileRef[]>;
    saveAs(request: SaveAsRequest): Promise<FileRef | null>;
  };
  fs: {
    readText(request: ReadTextRequest): Promise<ReadTextResult>;
    writeText(request: WriteTextRequest): Promise<WriteTextResult>;
  };
  app: {
    getInfo(): Promise<AppInfo>;
  };
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
}
