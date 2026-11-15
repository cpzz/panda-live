import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PandaError } from "../../src/shared/errors";
import type { FileFilter } from "../../src/shared/ipc";
import { t } from "../../src/i18n";
import type { FileService } from "../services/file-service";
import { handle } from "./router";

const CODE_EXTENSIONS = [
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hh",
  "hpp",
  "hxx",
  "ino",
  "java",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "less",
  "py",
  "sql",
  "php",
  "rs",
  "xml",
  "svg",
  "cs",
  "csx",
  "go",
  "rb",
  "rake",
  "gemspec",
  "kt",
  "kts",
  "swift",
  "r",
  "scala",
  "sc",
  "sh",
  "bash",
  "zsh",
  "ksh",
  "dart",
  "lua",
  "pl",
  "pm",
  "m",
  "mm",
  "ini",
  "cfg",
  "properties",
  "toml",
];

const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "qmd", "rmd", "mdx"];

/** 允许转存的图片类型；SVG 不在此列，避免把可执行脚本带入文档目录。 */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** `YYYYMMDD-HHmmss` 时间戳，用于图片文件名。 */
function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function markdownFilters(): FileFilter[] {
  return [
    { name: t("所有支持的文件"), extensions: [...MARKDOWN_EXTENSIONS, ...CODE_EXTENSIONS, "tex", "latex", "pdf"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: t("代码文件"), extensions: CODE_EXTENSIONS },
    { name: "Markdown", extensions: MARKDOWN_EXTENSIONS },
    { name: t("文本文件"), extensions: ["txt", "log", "puml", "mmd"] },
    { name: t("所有文件"), extensions: ["*"] },
  ];
}

export interface FileHandlerOptions {
  files: FileService;
  getWindow: () => BrowserWindow | null;
}

/** 注册文件与对话框通道。见 doc/design.md §13.1。 */
export function registerFileHandlers({ files, getWindow }: FileHandlerOptions): void {
  handle("dialog:openFiles", async (request) => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: request?.filters ?? markdownFilters(),
    };
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map((filePath) => files.registerPath(filePath)));
  });

  handle("dialog:saveAs", async (request) => {
    const options: SaveDialogOptions = {
      defaultPath: request.suggestedName,
      filters: request.filters ?? markdownFilters(),
    };
    const window = getWindow();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return files.registerPath(result.filePath);
  });

  // 关闭未保存文档的三选一确认：保存 / 不保存 / 取消。
  handle("dialog:confirmClose", async (request) => {
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: [t("保存"), t("不保存"), t("取消")],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: t("是否保存对“{0}”的修改？", request.name),
      detail: t("选择“不保存”将丢弃本次修改。"),
    };
    const window = getWindow();
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) return "save" as const;
    if (result.response === 1) return "discard" as const;
    return "cancel" as const;
  });

  handle("fs:readText", async (request) => files.readText(request.path));

  handle("fs:writeText", async (request) => files.writeText(request));

  handle("fs:readBase64", async (request) => files.readBase64(request.path));

  // 粘贴/拖入图片：校验类型与大小后写入文档同目录 assets/，返回相对路径。见 design.md §8.6。
  handle("fs:saveImage", async (request) => {
    const extension = IMAGE_MIME_EXTENSIONS[request.mime.toLowerCase()];
    if (!extension) {
      throw new PandaError("E_PAYLOAD_INVALID", t("不支持的图片格式：{0}", request.mime));
    }
    if (request.data.byteLength > MAX_IMAGE_BYTES) {
      throw new PandaError("E_FILE_TOO_LARGE", t("图片超过 20 MB，未写入：{0}", request.fileName ?? ""));
    }
    const documentDir = path.dirname(path.resolve(request.documentPath));
    const assetsDir = path.join(documentDir, "assets");
    // 文档目录已在打开时登记为允许根；assets 为其子目录，写入前再确认一次。
    await files.assertAllowed(documentDir);
    await fs.mkdir(assetsDir, { recursive: true });
    const bytes = Buffer.from(request.data);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const name = `${timestamp(new Date())}-${hash}.${extension}`;
    await fs.writeFile(path.join(assetsDir, name), bytes);
    return { path: `assets/${name}` };
  });

  handle("fs:stat", async (request) => files.stat(request.path));

  handle("fs:inspectDrop", async (request) => files.inspectDrop(request.path));
}
