import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import type { FileFilter } from "../../src/shared/ipc";
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

const MARKDOWN_FILTERS: FileFilter[] = [
  { name: "所有支持的文件", extensions: [...MARKDOWN_EXTENSIONS, ...CODE_EXTENSIONS, "tex", "latex"] },
  { name: "代码文件", extensions: CODE_EXTENSIONS },
  { name: "Markdown", extensions: MARKDOWN_EXTENSIONS },
  { name: "文本文件", extensions: ["txt", "log", "puml", "mmd"] },
  { name: "所有文件", extensions: ["*"] },
];

export interface FileHandlerOptions {
  files: FileService;
  getWindow: () => BrowserWindow | null;
}

/** 注册文件与对话框通道。见 doc/design.md §13.1。 */
export function registerFileHandlers({ files, getWindow }: FileHandlerOptions): void {
  handle("dialog:openFiles", async (request) => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: request?.filters ?? MARKDOWN_FILTERS,
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
      filters: request.filters ?? MARKDOWN_FILTERS,
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
      buttons: ["保存", "不保存", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: `是否保存对“${request.name}”的修改？`,
      detail: "选择“不保存”将丢弃本次修改。",
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

  handle("fs:stat", async (request) => files.stat(request.path));

  handle("fs:inspectDrop", async (request) => files.inspectDrop(request.path));
}
