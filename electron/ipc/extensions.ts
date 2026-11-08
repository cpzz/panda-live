import { dialog, type BrowserWindow } from "electron";
import type { ExtensionService } from "../services/extension-service";
import { handle } from "./router";

export interface ExtensionHandlerOptions {
  extensions: ExtensionService;
  getWindow: () => BrowserWindow | null;
}

/** 扩展管理通道：列表、安装、启用/禁用、预览与命令。见 doc/design.md §13.1。 */
export function registerExtensionHandlers({ extensions, getWindow }: ExtensionHandlerOptions): void {
  handle("ext:list", () => extensions.list());

  handle("ext:formats", () => extensions.formats());

  handle("ext:commands", () => extensions.commands());

  handle("ext:install", async () => {
    const window = getWindow();
    const options = {
      properties: ["openFile" as const],
      filters: [{ name: "Panda 扩展", extensions: ["panda"] }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      throw new Error("E_CANCELLED: 已取消安装");
    }
    return extensions.install(result.filePaths[0]);
  });

  handle("ext:enable", (request) => extensions.enable(request.id));

  handle("ext:disable", (request) => extensions.disable(request.id));

  handle("ext:uninstall", (request) => extensions.uninstall(request.id));

  handle("ext:openFolder", (request) => extensions.openFolder(request?.id));

  handle("ext:reload", (request) => extensions.reload(request.id));

  handle("ext:preview", (request) =>
    extensions.preview(request.extensionId, request.providerId, request.doc, request.path ?? null),
  );

  handle("ext:parse", (request) =>
    extensions.parse(request.extensionId, request.providerId, request.source, request.path ?? null),
  );

  handle("ext:serialize", async (request) => ({
    source: await extensions.serialize(request.extensionId, request.providerId, request.doc),
  }));

  handle("ext:command", (request) => extensions.command(request.id, request.args));
}
