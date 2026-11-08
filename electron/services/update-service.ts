import { net } from "electron";
import semver from "semver";
import type { UpdateStatus } from "../../src/shared/ipc";

/**
 * 更新检查：从 HTTPS generic feed 读取版本信息。
 * 未配置更新源时返回可诊断状态，不发起网络请求。见 doc/design.md §17.3。
 */
export class UpdateService {
  constructor(
    private readonly currentVersion: string,
    private readonly feedUrl: string | undefined,
  ) {}

  async check(): Promise<UpdateStatus> {
    if (!this.feedUrl) {
      return {
        status: "not-configured",
        currentVersion: this.currentVersion,
        message: "未配置更新源（可通过环境变量 PANDA_UPDATE_FEED 指定版本清单地址）",
      };
    }
    try {
      const response = await net.fetch(this.feedUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      const latest = typeof (data as { version?: unknown }).version === "string"
        ? (data as { version: string }).version
        : "";
      if (!semver.valid(latest)) throw new Error("更新源缺少合法 version 字段");
      if (semver.gt(latest, this.currentVersion)) {
        return { status: "available", currentVersion: this.currentVersion, latestVersion: latest };
      }
      return { status: "latest", currentVersion: this.currentVersion, latestVersion: latest };
    } catch (error) {
      return {
        status: "error",
        currentVersion: this.currentVersion,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
