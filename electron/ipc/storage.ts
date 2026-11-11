import type { Settings } from "../../src/shared/settings";
import type { DraftService } from "../services/draft-service";
import type { SessionService } from "../services/session-service";
import type { SettingsService } from "../services/settings-service";
import { handle } from "./router";

export interface StorageHandlerOptions {
  settings: SettingsService;
  session: SessionService;
  drafts: DraftService;
  /** 设置写入后同步主进程语言与原生菜单。 */
  onSettingsChanged?(settings: Settings): void;
}

/** 设置、会话、最近文件与草稿通道。见 doc/design.md §13.1、§12.4。 */
export function registerStorageHandlers({
  settings,
  session,
  drafts,
  onSettingsChanged,
}: StorageHandlerOptions): void {
  handle("settings:get", () => settings.get());

  handle("settings:update", async (request) => {
    const next = await settings.update(request.settings);
    onSettingsChanged?.(next);
    return next;
  });

  handle("session:load", () => session.load());

  handle("session:save", (request) => session.save(request.state));

  handle("recent:list", () => session.listRecent());

  handle("recent:add", (request) => session.addRecent(request.path));

  handle("recent:remove", (request) => session.removeRecent(request.path));

  handle("recent:clear", () => session.clearRecent());

  handle("draft:list", () => drafts.list());

  handle("draft:save", async (request) => ({ key: await drafts.save(request.draft, request.key) }));

  handle("draft:remove", (request) => drafts.remove(request.key));
}
