import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { isMenuCommand, MENU_COMMAND_CHANNEL } from "../src/shared/menu";
import type { IpcEnvelope, PandaApi } from "../src/shared/ipc";

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
    saveAs: (request) => invoke("dialog:saveAs", request),
  },
  fs: {
    readText: (request) => invoke("fs:readText", request),
    writeText: (request) => invoke("fs:writeText", request),
  },
  app: {
    getInfo: () => invoke("app:getInfo", undefined),
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
};

contextBridge.exposeInMainWorld("panda", api);
