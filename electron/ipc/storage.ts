import type { DraftService } from "../services/draft-service";
import type { SessionService } from "../services/session-service";
import type { SettingsService } from "../services/settings-service";
import { handle } from "./router";

export interface StorageHandlerOptions {
  settings: SettingsService;
  session: SessionService;
  drafts: DraftService;
}

/** 设置、会话、最近文件与草稿通道。见 doc/design.md §13.1、§12.4。 */
export function registerStorageHandlers({ settings, session, drafts }: StorageHandlerOptions): void {
  handle("settings:get", () => settings.get());

  handle("settings:update", (request) => settings.update(request.settings));

  handle("session:load", () => session.load());

  handle("session:save", (request) => session.save(request.state));

  handle("recent:list", () => session.listRecent());

  handle("recent:add", (request) => session.addRecent(request.path));

  handle("draft:list", () => drafts.list());

  handle("draft:save", async (request) => ({ key: await drafts.save(request.draft, request.key) }));

  handle("draft:remove", (request) => drafts.remove(request.key));
}
