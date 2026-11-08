import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { toErrorPayload } from "../../src/shared/errors";
import {
  ipcRequestSchemas,
  type AppInfo,
  type IpcChannel,
  type IpcEnvelope,
  type IpcRequest,
  type IpcResponseMap,
} from "../../src/shared/ipc";

type Handler<C extends IpcChannel> = (
  request: IpcRequest<C>,
  event: IpcMainInvokeEvent,
) => Promise<IpcResponseMap[C]> | IpcResponseMap[C];

/**
 * 统一注册 `invoke` 通道：先做 zod schema 校验，再执行处理器。
 * 校验失败返回 `E_PAYLOAD_INVALID`。见 doc/design.md §13.1。
 */
export function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcEnvelope<IpcResponseMap[C]>> => {
    const schema = ipcRequestSchemas[channel] as ZodType<unknown>;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(payload)"}: ${issue.message}`)
        .join("; ");
      return { ok: false, error: { code: "E_PAYLOAD_INVALID", message } };
    }
    try {
      const data = await handler(parsed.data as IpcRequest<C>, event);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  });
}

export function registerAppHandlers(): void {
  handle("app:getInfo", (): AppInfo => ({
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    platform: process.platform,
    userDataPath: app.getPath("userData"),
  }));
}
