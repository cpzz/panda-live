import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { APP_OPEN_PATH_CHANNEL, FS_CHANGED_CHANNEL } from "../src/shared/events";
import { isMenuCommand, MENU_COMMAND_CHANNEL } from "../src/shared/menu";
import type { FsChangedEvent, IpcEnvelope, PandaApi } from "../src/shared/ipc";
import { t } from "../src/i18n";

async function invoke<T>(channel: string, request: unknown): Promise<T> {
  const response = (await ipcRenderer.invoke(channel, request)) as IpcEnvelope<T>;
  if (!response || typeof response !== "object") {
    throw new Error(`E_INTERNAL: ${t("IPC 响应格式无效")}`);
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
    confirmClose: (request) => invoke("dialog:confirmClose", request),
    confirmCloseAll: (request) => invoke("dialog:confirmCloseAll", request),
  },
  fs: {
    readText: (request) => invoke("fs:readText", request),
    writeText: (request) => invoke("fs:writeText", request),
    readBase64: (request) => invoke("fs:readBase64", request),
    saveImage: (request) => invoke("fs:saveImage", request),
    readDir: (request) => invoke("fs:readDir", request),
    stat: (request) => invoke("fs:stat", request),
    inspectDrop: (request) => invoke("fs:inspectDrop", request),
    create: (request) => invoke("fs:create", request),
    rename: (request) => invoke("fs:rename", request),
    remove: (request) => invoke("fs:delete", request),
    trash: (request) => invoke("fs:trash", request),
    watch: (request) => invoke("fs:watch", request),
    unwatch: (request) => invoke("fs:unwatch", request),
  },
  workspace: {
    open: (request) => invoke("workspace:open", request),
  },
  git: {
    diff: (request) => invoke("git:diff", request),
    snapshot: (request) => invoke("git:snapshot", request),
    stage: (request) => invoke("git:stage", request),
    unstage: (request) => invoke("git:unstage", request),
    discard: (request) => invoke("git:discard", request),
    commit: (request) => invoke("git:commit", request),
    branches: (request) => invoke("git:branches", request),
    checkout: (request) => invoke("git:checkout", request),
    deleteBranch: (request) => invoke("git:deleteBranch", request),
    pull: (request) => invoke("git:pull", request),
    push: (request) => invoke("git:push", request),
    addRemote: (request) => invoke("git:addRemote", request),
    setRemoteUrl: (request) => invoke("git:setRemoteUrl", request),
    removeRemote: (request) => invoke("git:removeRemote", request),
    log: (request) => invoke("git:log", request),
    commitDetail: (request) => invoke("git:commitDetail", request),
    fileLog: (request) => invoke("git:fileLog", request),
    resolveRef: (request) => invoke("git:resolveRef", request),
    compare: (request) => invoke("git:compare", request),
    abort: (request) => invoke("git:abort", request),
    continue: (request) => invoke("git:continue", request),
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
    remove: (request) => invoke("recent:remove", request),
    clear: () => invoke("recent:clear", undefined),
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
    pendingOpenPaths: () => invoke("app:pendingOpenPaths", undefined),
    setTitleBarColor: (request) => invoke("app:setTitleBarColor", request),
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
  onOpenPath: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const filePath = (payload as { path?: unknown } | null | undefined)?.path;
      if (typeof filePath === "string" && filePath.length > 0) listener(filePath);
    };
    ipcRenderer.on(APP_OPEN_PATH_CHANNEL, handler);
    return () => {
      ipcRenderer.off(APP_OPEN_PATH_CHANNEL, handler);
    };
  },
  /** 从系统拖入的文件/目录获取真实路径（Electron 32+ 已移除 File.path）。 */
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("panda", api);
