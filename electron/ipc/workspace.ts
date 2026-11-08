import { dialog, shell, type BrowserWindow } from "electron";
import type { FileService } from "../services/file-service";
import type { WorkspaceService } from "../services/workspace-service";
import { handle } from "./router";

export interface WorkspaceHandlerOptions {
  files: FileService;
  workspaces: WorkspaceService;
  getWindow: () => BrowserWindow | null;
}

/** 工作区、目录树、文件监听与系统外壳通道。见 doc/design.md §12.5、§12.6、§13.1。 */
export function registerWorkspaceHandlers({
  files,
  workspaces,
  getWindow,
}: WorkspaceHandlerOptions): void {
  handle("dialog:openDirectory", async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return files.registerRoot(result.filePaths[0] ?? "");
  });

  handle("workspace:open", (request) => workspaces.open(request.path));

  handle("fs:readDir", async (request) => ({ entries: await workspaces.list(request.path) }));

  handle("fs:create", (request) => files.createEntry(request.path, request.kind));

  handle("fs:rename", (request) => files.renameEntry(request.path, request.newName));

  handle("fs:delete", (request) => files.deleteEntry(request.path, request.recursive ?? false));

  handle("fs:watch", (request) => workspaces.watch(request.paths));

  handle("fs:unwatch", (request) => workspaces.unwatch(request.watchId));

  handle("shell:reveal", (request) => {
    shell.showItemInFolder(request.path);
  });

  handle("shell:openExternal", async (request) => {
    let protocol: string;
    try {
      protocol = new URL(request.url).protocol;
    } catch {
      throw new Error("E_PAYLOAD_INVALID: 链接格式不合法");
    }
    if (!["http:", "https:", "mailto:"].includes(protocol)) {
      throw new Error("E_PAYLOAD_INVALID: 仅允许 http/https/mailto 外链");
    }
    await shell.openExternal(request.url);
  });
}
