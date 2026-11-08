import { protocol } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isPathInside, type FileService } from "./file-service";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** 必须在 `app.whenReady()` 之前调用。见 doc/design.md §12.6。 */
export function registerPandaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "panda-res",
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
    {
      // 图表沙箱：独立来源的静态页面，只提供 dist 内的构建产物。见 §10.1、§12.6。
      scheme: "panda-sandbox",
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true },
    },
    {
      // 扩展静态资源：只读，仅允许已启用扩展目录内的相对路径。见 §7.6.5、§12.6。
      scheme: "panda-ext",
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      // TeX 编译产物：仅映射到 PDF 缓存目录内的已知键。见 §12.6。
      scheme: "panda-pdf",
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
  ]);
}

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isSafeRelativePath(relative: string): boolean {
  if (!relative) return false;
  const segments = relative.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\") && !segment.includes(":"),
  );
}

/**
 * 图表沙箱静态资源：`panda-sandbox://render/<相对路径>` → `dist/src/render-sandbox/<相对路径>`。
 * 构建产物中的 `../../assets/...` 相对引用允许解析，但必须留在 dist 目录内。
 */
function registerSandboxProtocol(distRoot: string): void {
  const sandboxRoot = path.join(distRoot, "src", "render-sandbox");

  protocol.handle("panda-sandbox", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "render") return textResponse(404, "Unknown sandbox host");

      const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!relative) return textResponse(404, "Missing path");

      // 浏览器会把 HTML 中的 `../../assets/...` 相对引用钳制到主机根的 `/assets/...`，
      // 因此除入口 HTML 外，其余资源都从 dist 根解析。
      const target =
        relative === "index.html"
          ? path.join(sandboxRoot, "index.html")
          : path.resolve(distRoot, relative);
      if (!isPathInside(distRoot, target)) return textResponse(403, "Path outside dist");

      const body = await fs.readFile(target);
      const contentType = MIME_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(body.byteLength),
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return textResponse(404, "Not found");
    }
  });
}

/**
 * 扩展静态资源：`panda-ext://<extensionId>/<相对路径>`，仅已启用扩展可访问。
 * 见 doc/design.md §7.6.5、§12.6。
 */
function registerExtensionProtocol(resolveRoot: (extensionId: string) => string | null): void {
  protocol.handle("panda-ext", async (request) => {
    try {
      const url = new URL(request.url);
      const root = resolveRoot(url.hostname);
      if (!root) return textResponse(404, "Unknown or disabled extension");

      const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!isSafeRelativePath(relative)) return textResponse(400, "Invalid path");

      const realRoot = await fs.realpath(root);
      const target = path.resolve(realRoot, relative);
      if (!isPathInside(realRoot, target)) return textResponse(403, "Path outside extension");

      const realTarget = await fs.realpath(target);
      if (!isPathInside(realRoot, realTarget)) return textResponse(403, "Symlink outside extension");

      const stats = await fs.stat(realTarget);
      if (!stats.isFile()) return textResponse(404, "Not a file");

      const body = await fs.readFile(realTarget);
      const contentType = MIME_TYPES[path.extname(realTarget).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, {
        status: 200,
        headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      });
    } catch {
      return textResponse(404, "Not found");
    }
  });
}

/**
 * TeX 编译产物：`panda-pdf://<cacheKey>`，只接受 64 位十六进制键。
 * 见 doc/design.md §12.6。
 */
function registerPdfProtocol(pdfCacheRoot: string): void {
  protocol.handle("panda-pdf", async (request) => {
    try {
      const url = new URL(request.url);
      const key = url.pathname.replace(/^\/+/, "").replace(/\.pdf$/i, "");
      if (!/^[a-f0-9]{64}$/.test(key)) return textResponse(400, "Invalid cache key");
      const target = path.join(pdfCacheRoot, `${key}.pdf`);
      if (!isPathInside(pdfCacheRoot, target)) return textResponse(403, "Path outside cache");
      const body = await fs.readFile(target);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(body.byteLength),
        },
      });
    } catch {
      return textResponse(404, "Not found");
    }
  });
}

/**
 * 资源协议处理器：只接受 `rootId + 相对路径`，拒绝绝对路径、`..` 与符号链接逃逸。
 * 见 doc/design.md §12.6、§13.5。
 */
export function handlePandaProtocols(
  files: FileService,
  distRoot?: string,
  resolveExtensionRoot?: (extensionId: string) => string | null,
  pdfCacheRoot?: string,
): void {
  if (distRoot) registerSandboxProtocol(distRoot);
  if (resolveExtensionRoot) registerExtensionProtocol(resolveExtensionRoot);
  if (pdfCacheRoot) registerPdfProtocol(pdfCacheRoot);

  protocol.handle("panda-res", async (request) => {
    try {
      const url = new URL(request.url);
      const root = files.getRoot(url.hostname);
      if (!root) return textResponse(404, "Unknown root");

      const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!isSafeRelativePath(relative)) return textResponse(400, "Invalid path");

      const realRoot = await fs.realpath(root);
      const target = path.resolve(realRoot, relative);
      if (!isPathInside(realRoot, target)) return textResponse(403, "Path outside root");

      const realTarget = await fs.realpath(target);
      if (!isPathInside(realRoot, realTarget)) return textResponse(403, "Symlink outside root");

      const stats = await fs.stat(realTarget);
      if (!stats.isFile()) return textResponse(404, "Not a file");

      const body = await fs.readFile(realTarget);
      const contentType = MIME_TYPES[path.extname(realTarget).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, {
        status: 200,
        headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      });
    } catch {
      return textResponse(404, "Not found");
    }
  });
}
