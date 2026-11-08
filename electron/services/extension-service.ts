import { promises as fs } from "node:fs";
import path from "node:path";
import { shell } from "electron";
import { PandaError } from "../../src/shared/errors";
import type {
  ExtensionCommandInfo,
  ExtensionFormatInfo,
  ExtensionInfo,
  ExtensionManifest,
  ExtensionParseResult,
  ExtensionPreviewResult,
} from "../../src/shared/extensions";
import { writeFileAtomic } from "./atomic-write";
import { ExtensionHost } from "../extensions/host";
import { installPackage } from "../extensions/installer";
import { publisherOf, validateManifest } from "../extensions/manifest";

interface InstalledEntry {
  id: string;
  dir: string;
  builtin: boolean;
  manifest: ExtensionManifest | null;
  error?: string;
}

interface StateFile {
  enabled: string[];
}

const MAX_CONSECUTIVE_FAILURES = 3;

export interface ExtensionServiceOptions {
  userDataDir: string;
  appRoot: string;
  appVersion: string;
  hostRunnerPath: string;
}

/**
 * 扩展注册表与生命周期：扫描、启用状态、安装、激活与 RPC 代理。
 * 见 doc/design.md §7.6.4–§7.6.6。
 */
export class ExtensionService {
  private readonly entries = new Map<string, InstalledEntry>();
  private readonly enabled = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly userRoot: string;
  private readonly builtinRoot: string;
  private readonly statePath: string;
  private readonly host: ExtensionHost;
  private readonly appVersion: string;

  constructor(options: ExtensionServiceOptions) {
    this.userRoot = path.join(options.userDataDir, "extensions");
    this.builtinRoot = path.join(options.appRoot, "extensions", "builtin");
    this.statePath = path.join(options.userDataDir, "extensions.json");
    this.appVersion = options.appVersion;
    this.host = new ExtensionHost(options.hostRunnerPath, (message: string) => {
      console.info("[extension]", message);
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.userRoot, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath, "utf8")) as StateFile;
      for (const id of raw.enabled ?? []) this.enabled.add(id);
    } catch {
      // 无状态文件时使用默认值
    }
    await this.scan();
  }

  async list(): Promise<ExtensionInfo[]> {
    return [...this.entries.values()]
      .map((entry) => ({
        id: entry.id,
        version: entry.manifest?.version ?? "0.0.0",
        publisher: publisherOf(entry.id),
        displayName: entry.manifest?.displayName ?? entry.id,
        builtin: entry.builtin,
        enabled: this.enabled.has(entry.id) && entry.manifest !== null,
        permissions: entry.manifest?.permissions ?? [],
        ...(entry.error ? { error: entry.error } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 启用的扩展贡献的格式；禁用扩展不进入渲染进程注册表。 */
  async formats(): Promise<ExtensionFormatInfo[]> {
    const list: ExtensionFormatInfo[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.manifest || !this.enabled.has(entry.id)) continue;
      for (const format of entry.manifest.contributes.formats) {
        const language = entry.manifest.contributes.languages.find(
          (item) => item.id === format.language,
        );
        list.push({
          extensionId: entry.id,
          id: format.id,
          extensions: format.extensions,
          capabilities: format.capabilities,
          language: format.language ?? "",
          syntax: language?.syntax ?? "plain",
          enabled: true,
        });
      }
    }
    return list;
  }

  /** 已启用扩展贡献的命令，供命令面板列出。 */
  commands(): ExtensionCommandInfo[] {
    const list: ExtensionCommandInfo[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.manifest || !this.enabled.has(entry.id)) continue;
      for (const command of entry.manifest.contributes.commands) {
        list.push({ id: command.id, title: command.title, extensionId: entry.id });
      }
    }
    return list.sort((a, b) => a.title.localeCompare(b.title));
  }

  async install(archivePath: string): Promise<ExtensionInfo> {
    const result = await installPackage(archivePath, this.userRoot, this.appVersion);
    await this.scan();
    const entry = this.entries.get(result.id);
    if (!entry) throw new PandaError("E_EXTENSION_INVALID", "安装后未能读取扩展清单");
    return (await this.list()).find((item) => item.id === result.id) ??
      {
        id: entry.id,
        version: entry.manifest?.version ?? "0.0.0",
        publisher: publisherOf(entry.id),
        displayName: entry.manifest?.displayName ?? entry.id,
        builtin: false,
        enabled: false,
        permissions: entry.manifest?.permissions ?? [],
      };
  }

  async enable(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.manifest) throw new PandaError("E_EXTENSION_INVALID", `扩展不可用：${id}`);
    this.enabled.add(id);
    await this.persistState();
  }

  async disable(id: string): Promise<void> {
    this.enabled.delete(id);
    if (this.host.currentExtension === id) this.host.dispose();
    await this.persistState();
  }

  async uninstall(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new PandaError("E_EXTENSION_INVALID", `扩展不存在：${id}`);
    if (entry.builtin) throw new PandaError("E_EXTENSION_INVALID", "内置扩展不可卸载");
    this.enabled.delete(id);
    if (this.host.currentExtension === id) this.host.dispose();
    await fs.rm(entry.dir, { recursive: true, force: true });
    await this.persistState();
    await this.scan();
  }

  async openFolder(id?: string): Promise<void> {
    const target = id ? this.entries.get(id)?.dir : this.userRoot;
    if (!target) throw new PandaError("E_EXTENSION_INVALID", `扩展不存在：${id}`);
    await fs.mkdir(target, { recursive: true });
    await shell.openPath(target);
  }

  async reload(id: string): Promise<void> {
    if (this.host.currentExtension === id) this.host.dispose();
    this.failures.delete(id);
    await this.scan();
  }

  async parse(
    extensionId: string,
    providerId: string,
    source: string,
    filePath: string | null,
  ): Promise<ExtensionParseResult> {
    const entry = await this.prepare(extensionId);
    try {
      const result = (await this.host.call(
        "parse",
        { providerId, source, path: filePath },
        entry.id,
      )) as { doc?: unknown; diagnostics?: unknown };
      return { doc: result?.doc ?? null, diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics : [] } as ExtensionParseResult;
    } catch (error) {
      this.recordFailure(extensionId, error);
      throw error;
    }
  }

  async serialize(
    extensionId: string,
    providerId: string,
    doc: unknown,
  ): Promise<string> {
    const entry = await this.prepare(extensionId);
    try {
      const result = (await this.host.call("serialize", { providerId, doc }, entry.id)) as {
        source?: string;
      };
      return result?.source ?? "";
    } catch (error) {
      this.recordFailure(extensionId, error);
      throw error;
    }
  }

  async preview(
    extensionId: string,
    providerId: string,
    doc: unknown,
    filePath: string | null,
  ): Promise<ExtensionPreviewResult> {
    const entry = await this.prepare(extensionId);
    try {
      const result = (await this.host.call(
        "preview",
        { providerId, doc, path: filePath },
        entry.id,
      )) as { html?: string; diagnostics?: unknown };
      return {
        html: result?.html ?? "",
        diagnostics: Array.isArray(result?.diagnostics) ? (result.diagnostics as ExtensionPreviewResult["diagnostics"]) : [],
      };
    } catch (error) {
      this.recordFailure(extensionId, error);
      throw error;
    }
  }

  async command(id: string, args?: unknown): Promise<unknown> {
    const owner = [...this.entries.values()].find(
      (entry) =>
        entry.manifest &&
        this.enabled.has(entry.id) &&
        entry.manifest.contributes.commands.some((command) => command.id === id),
    );
    if (!owner) throw new PandaError("E_EXTENSION_INVALID", `未找到启用的命令：${id}`);
    await this.prepare(owner.id);
    return this.host.call("command", { id, args }, owner.id).catch((error: unknown) => {
      this.recordFailure(owner.id, error);
      throw error;
    });
  }

  /** `panda-ext://` 只读资源根；仅启用扩展可访问。 */
  resolveProtocolRoot(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry || !this.enabled.has(id)) return null;
    return entry.dir;
  }

  dispose(): void {
    this.host.dispose();
  }

  private async prepare(extensionId: string): Promise<InstalledEntry> {
    const entry = this.entries.get(extensionId);
    if (!entry?.manifest) {
      throw new PandaError("E_EXTENSION_INVALID", `扩展不存在或清单无效：${extensionId}`);
    }
    if (!this.enabled.has(extensionId)) {
      throw new PandaError("E_EXTENSION_INVALID", `扩展未启用：${extensionId}`);
    }
    if (!entry.manifest.main) {
      throw new PandaError("E_EXTENSION_INVALID", `扩展缺少 main 入口：${extensionId}`);
    }
    if (this.host.currentExtension === extensionId) return entry;

    try {
      await this.host.activate({
        extensionId,
        extensionPath: entry.dir,
        mainPath: entry.manifest.main,
        settings: configurationDefaults(entry.manifest),
      });
      this.failures.delete(extensionId);
      return entry;
    } catch (error) {
      this.recordFailure(extensionId, error);
      throw error;
    }
  }

  private recordFailure(extensionId: string, error: unknown): void {
    const entry = this.entries.get(extensionId);
    const message = error instanceof Error ? error.message : String(error);
    if (entry) entry.error = message;
    const count = (this.failures.get(extensionId) ?? 0) + 1;
    this.failures.set(extensionId, count);
    this.host.dispose();
    if (count >= MAX_CONSECUTIVE_FAILURES && !entry?.builtin) {
      this.enabled.delete(extensionId);
      void this.persistState();
    }
  }

  private async scan(): Promise<void> {
    this.entries.clear();
    const roots: Array<{ root: string; builtin: boolean }> = [
      { root: this.builtinRoot, builtin: true },
      { root: this.userRoot, builtin: false },
    ];
    for (const { root, builtin } of roots) {
      let names: string[] = [];
      try {
        names = await fs.readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".") || name.startsWith("_")) continue;
        const dir = path.join(root, name);
        const stats = await fs.stat(dir).catch(() => null);
        if (!stats?.isDirectory()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(await fs.readFile(path.join(dir, "extension.json"), "utf8")) as unknown;
        } catch {
          continue;
        }
        const validation = validateManifest(raw, this.appVersion);
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "string" || !id) continue;
        if (this.entries.has(id)) continue;
        this.entries.set(id, {
          id,
          dir,
          builtin,
          manifest: validation.manifest,
          ...(validation.manifest ? {} : { error: validation.errors.join("; ") }),
        });
      }
    }
  }

  private async persistState(): Promise<void> {
    await writeFileAtomic(
      this.statePath,
      `${JSON.stringify({ enabled: [...this.enabled].sort() }, null, 2)}\n`,
    );
  }
}

function configurationDefaults(manifest: ExtensionManifest): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(manifest.contributes.configuration)) {
    if (definition && typeof definition === "object" && "default" in definition) {
      settings[key] = (definition as { default?: unknown }).default;
    }
  }
  return settings;
}
