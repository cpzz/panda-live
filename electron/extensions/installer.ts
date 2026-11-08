import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import semver from "semver";
import { PandaError } from "../../src/shared/errors";
import { validateManifest, type ManifestValidation } from "./manifest";

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

export interface InstallResult {
  id: string;
  dir: string;
  validation: ManifestValidation;
}

/** 安装包内路径必须为相对路径，且不含 `..`/反斜杠/绝对路径。 */
export function isSafePackagePath(name: string): boolean {
  if (name.includes("\\") || name.startsWith("/") || name.includes("..")) return false;
  return true;
}

/**
 * 安装 `.panda`（zip）：校验清单、路径穿越、解压后总大小、入口文件位置与版本。
 * 见 doc/design.md §7.6.5。
 */
export async function installPackage(
  archivePath: string,
  extensionsRoot: string,
  appVersion: string,
): Promise<InstallResult> {
  const buffer = await fs.readFile(archivePath);
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.values(zip.files).filter((entry) => !entry.dir);

  let total = 0;
  for (const file of files) {
    if (!isSafePackagePath(file.name)) {
      throw new PandaError("E_EXTENSION_INVALID", `安装包包含非法路径：${file.name}`);
    }
    const content = await file.async("uint8array");
    total += content.byteLength;
    if (total > MAX_PACKAGE_BYTES) {
      throw new PandaError("E_EXTENSION_INVALID", "解压后总大小超过 50 MB");
    }
  }

  // 清单允许位于根目录，或唯一的顶层目录内。
  const manifestEntry =
    files.find((file) => file.name === "extension.json") ??
    files.find((file) => {
      const parts = file.name.split("/");
      return parts.length === 2 && parts[0] !== "" && parts[1] === "extension.json";
    });
  if (!manifestEntry) {
    throw new PandaError("E_EXTENSION_INVALID", "安装包缺少 extension.json");
  }
  const manifestRaw = JSON.parse(await manifestEntry.async("string")) as unknown;
  const validation = validateManifest(manifestRaw, appVersion);
  if (!validation.manifest) {
    throw new PandaError("E_EXTENSION_INVALID", validation.errors.join("; "));
  }
  const manifest = validation.manifest;
  if (!manifest.main) {
    throw new PandaError("E_EXTENSION_INVALID", "扩展缺少 main 入口");
  }
  const prefix = manifestEntry.name.slice(0, manifestEntry.name.length - "extension.json".length);
  const mainEntry = files.find((file) => file.name === `${prefix}${manifest.main}`);
  if (!mainEntry) {
    throw new PandaError("E_EXTENSION_INVALID", `入口文件不存在：${manifest.main}`);
  }

  const targetDir = path.join(extensionsRoot, manifest.id);
  const existing = await readInstalledVersion(targetDir);
  if (existing) {
    if (!semver.valid(existing) || !semver.gt(manifest.version, existing)) {
      throw new PandaError(
        "E_EXTENSION_INCOMPATIBLE",
        `已安装版本 ${existing} 不低于 ${manifest.version}，拒绝安装`,
      );
    }
  }

  const tempDir = path.join(extensionsRoot, `.tmp-${randomUUID().slice(0, 12)}`);
  await fs.mkdir(tempDir, { recursive: true });
  try {
    for (const file of files) {
      const relative = file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name;
      if (!relative) continue;
      const destination = path.join(tempDir, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, await file.async("uint8array"));
    }
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(tempDir, targetDir);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { id: manifest.id, dir: targetDir, validation };
}

async function readInstalledVersion(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, "extension.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}
