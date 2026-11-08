import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { FS_CHANGED_CHANNEL } from "../src/shared/events";
import { isMenuCommand, MENU_COMMAND_CHANNEL } from "../src/shared/menu";
import type { FsChangedEvent, IpcEnvelope, PandaApi } from "../src/shared/ipc";

async function invoke<T>(channel: string, request: unknown): Promise<T> {
  const response = (await ipcRenderer.invoke(channel, request)) as IpcEnvelope<T>;
  if (!response || typeof response !== "object") {
    throw new Error("E_INTERNAL: IPC 响应格式无效");
  }
  if (!response.ok) {
    // contextBridge 只保留 Error.message，把错误码编码进消息。
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  return response.data;
}

const api: PandaApi = {
  dialog: {
    openFiles: (request) => invoke("dialog:openFiles", request),
    openDirectory: () => invoke("dialog:openDirectory", undefined),
    saveAs: (request) => invoke("dialog:saveAs", request),
  },
  fs: {
    readText: (request) => invoke("fs:readText", request),
    writeText: (request) => invoke("fs:writeText", request),
    readDir: (request) => invoke("fs:readDir", request),
    stat: (request) => invoke("fs:stat", request),
    create: (request) => invoke("fs:create", request),
    rename: (request) => invoke("fs:rename", request),
    remove: (request) => invoke("fs:delete", request),
    watch: (request) => invoke("fs:watch", request),
    unwatch: (request) => invoke("fs:unwatch", request),
  },
  workspace: {
    open: (request) => invoke("workspace:open", request),
  },
  settings: {
    get: () => invoke("settings:get", undefined),
    update: (settings) => invoke("settings:update", { settings }),
  },
  session: {
    load: () => invoke("session:load", undefined),
    save: (state) => invoke("session:save", { state }),
  },
  recent: {
    list: () => invoke("recent:list", undefined),
    add: (request) => invoke("recent:add", request),
  },
  drafts: {
    list: () => invoke("draft:list", undefined),
    save: (request) => invoke("draft:save", request),
    remove: (key) => invoke("draft:remove", { key }),
  },
  shell: {
    reveal: (path) => invoke("shell:reveal", { path }),
    openExternal: (url) => invoke("shell:openExternal", { url }),
  },
  ext: {
    list: () => invoke("ext:list", undefined),
    formats: () => invoke("ext:formats", undefined),
    install: () => invoke("ext:install", undefined),
    enable: (id) => invoke("ext:enable", { id }),
    disable: (id) => invoke("ext:disable", { id }),
    uninstall: (id) => invoke("ext:uninstall", { id }),
    openFolder: (id) => invoke("ext:openFolder", id ? { id } : undefined),
    reload: (id) => invoke("ext:reload", { id }),
    preview: (request) => invoke("ext:preview", request),
    parse: (request) => invoke("ext:parse", request),
    serialize: (request) => invoke("ext:serialize", request),
    command: (id, args) => invoke("ext:command", { id, args }),
  },
  app: {
    getInfo: () => invoke("app:getInfo", undefined),
  },
  export: {
    pdf: (request) => invoke("export:pdf", request),
  },
  latex: {
    detect: () => invoke("latex:detect", undefined),
    compile: (request) => invoke("latex:compile", request),
  },
  onMenuCommand: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const command = (payload as { command?: unknown } | null | undefined)?.command;
      if (isMenuCommand(command)) listener(command);
    };
    ipcRenderer.on(MENU_COMMAND_CHANNEL, handler);
    return () => {
      ipcRenderer.off(MENU_COMMAND_CHANNEL, handler);
    };
  },
  onFsChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as Partial<FsChangedEvent>;
      if (typeof event.watchId !== "string" || !Array.isArray(event.changes)) return;
      listener({ watchId: event.watchId, changes: event.changes });
    };
    ipcRenderer.on(FS_CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.off(FS_CHANGED_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("panda", api);
