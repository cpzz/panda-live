import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PandaError } from "../../src/shared/errors";
import type { FileRef, ReadTextResult, WriteTextRequest, WriteTextResult } from "../../src/shared/ipc";
import { decodeText, encodeText, sha256Hex } from "./text-codec";

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mapIoError(error: unknown, target: string): PandaError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new PandaError("E_FILE_NOT_FOUND", `文件不存在：${target}`);
    case "EACCES":
    case "EPERM":
      return new PandaError("E_PERMISSION_DENIED", `无访问权限：${target}`);
    default:
      return new PandaError(
        "E_INTERNAL",
        `文件操作失败：${(error as Error | undefined)?.message ?? String(error)}`,
      );
  }
}

/**
 * 文件服务：维护允许根目录、执行路径校验、处理文本读写。
 * 所有路径先 `realpath` 再做根目录前缀校验，见 doc/design.md §13.5。
 */
export class FileService {
  private readonly roots = new Map<string, string>();

  /** 登记用户通过原生对话框选中的路径，并返回带 `rootId` 的引用。 */
  async registerPath(filePath: string): Promise<FileRef> {
    const absolute = path.resolve(filePath);
    let realDir: string;
    try {
      realDir = await fs.realpath(path.dirname(absolute));
    } catch (error) {
      throw mapIoError(error, absolute);
    }
    const rootId = createHash("sha256").update(realDir).digest("hex").slice(0, 16);
    this.roots.set(rootId, realDir);
    return { path: absolute, name: path.basename(absolute), rootId };
  }

  getRoot(rootId: string): string | undefined {
    return this.roots.get(rootId);
  }

  async readText(filePath: string): Promise<ReadTextResult> {
    const target = await this.resolveAllowed(filePath);
    let bytes: Buffer;
    let mtimeMs: number;
    try {
      const stats = await fs.stat(target);
      if (!stats.isFile()) {
        throw new PandaError("E_FILE_NOT_FOUND", `不是文件：${target}`);
      }
      bytes = await fs.readFile(target);
      mtimeMs = stats.mtimeMs;
    } catch (error) {
      throw mapIoError(error, target);
    }
    const decoded = decodeText(bytes);
    return {
      content: decoded.content,
      mtimeMs,
      hash: sha256Hex(bytes),
      eol: decoded.eol,
      bom: decoded.bom,
      encoding: decoded.encoding,
      size: bytes.byteLength,
      readOnly: decoded.readOnly,
    };
  }

  async writeText(request: WriteTextRequest): Promise<WriteTextResult> {
    const target = await this.resolveAllowed(request.path);

    let existing: Buffer | null = null;
    let existingStat: { mode: number } | null = null;
    try {
      const stats = await fs.stat(target);
      if (!stats.isFile()) {
        throw new PandaError("E_FILE_NOT_FOUND", `不是文件：${target}`);
      }
      existing = await fs.readFile(target);
      existingStat = stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw mapIoError(error, target);
      }
    }

    if (existing && request.baseHash && sha256Hex(existing) !== request.baseHash) {
      throw new PandaError("E_FILE_CHANGED", "文件已被外部修改");
    }
    if (!existing && request.baseHash) {
      throw new PandaError("E_FILE_CHANGED", "文件已被外部删除或移动");
    }

    const decodedExisting = existing ? decodeText(existing) : null;
    if (decodedExisting?.readOnly) {
      throw new PandaError("E_ENCODING_UNSUPPORTED", `不支持写回编码：${decodedExisting.encoding}`);
    }

    const bytes = encodeText(
      request.content,
      decodedExisting?.eol ?? "lf",
      decodedExisting?.bom ?? false,
    );

    const tempPath = path.join(path.dirname(target), `.tmp-${randomUUID().slice(0, 12)}`);
    try {
      const handle = await fs.open(tempPath, "wx", existingStat?.mode);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, target);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw mapIoError(error, target);
    }

    const stats = await fs.stat(target).catch((error: unknown) => {
      throw mapIoError(error, target);
    });
    return { mtimeMs: stats.mtimeMs, hash: sha256Hex(bytes) };
  }

  /** 解析真实路径，并确认其位于某个已登记根目录之下。 */
  private async resolveAllowed(filePath: string): Promise<string> {
    const absolute = path.resolve(filePath);
    let realDir: string;
    try {
      realDir = await fs.realpath(path.dirname(absolute));
    } catch (error) {
      throw mapIoError(error, absolute);
    }

    let target = path.join(realDir, path.basename(absolute));
    try {
      target = await fs.realpath(target);
    } catch {
      // 新建文件尚无实体；以已校验的父目录拼接结果为准。
    }

    const allowed = [...this.roots.values()].some((root) => isPathInside(root, target));
    if (!allowed) {
      throw new PandaError("E_PATH_OUTSIDE_ROOT", `路径不在允许范围内：${absolute}`);
    }
    return target;
  }
}
