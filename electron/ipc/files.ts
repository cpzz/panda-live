import { dialog, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from "electron";
import type { FileFilter } from "../../src/shared/ipc";
import type { FileService } from "../services/file-service";
import { handle } from "./router";

const MARKDOWN_FILTERS: FileFilter[] = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "qmd", "rmd", "mdx"] },
  { name: "文本文件", extensions: ["txt", "log", "json", "yaml", "yml"] },
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

  handle("fs:readText", async (request) => files.readText(request.path));

  handle("fs:writeText", async (request) => files.writeText(request));

  handle("fs:stat", async (request) => files.stat(request.path));
}
