import type { GitDiffResult } from "../../src/shared/diff";
import type { FileService } from "../services/file-service";
import type { GitService } from "../services/git-service";
import type { SettingsService } from "../services/settings-service";
import { handle } from "./router";

/** Git 基线通道：校验路径后只读仓库对象。见 doc/design.md §21.3。 */
export function registerGitHandlers({
  files,
  git,
  settings,
}: {
  files: FileService;
  git: GitService;
  settings: SettingsService;
}): void {
  handle("git:diff", async (request): Promise<GitDiffResult> => {
    const target = await files.assertAllowed(request.path);
    return git.readBaseline(
      target,
      request.base,
      request.ref,
      settings.get().git.command,
    );
  });
}
