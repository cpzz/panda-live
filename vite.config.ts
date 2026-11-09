import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

const BASE_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' panda-ext:",
  "img-src 'self' data: blob: panda-res: panda-ext:",
  "font-src 'self' data: panda-ext:",
  "worker-src 'self' blob:",
  "frame-src 'self' panda-pdf: panda-sandbox:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/**
 * 生产环境使用严格 CSP；开发环境需放行 Vite 注入的内联脚本与 HMR WebSocket。
 * 详见 doc/design.md §13.3。
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "panda-csp",
    transformIndexHtml(_html, ctx) {
      // 图表沙箱页面使用自身更严格的 CSP（default-src 'none'），不注入主窗口策略。
      if (ctx.filename.includes("render-sandbox")) return [];
      const dev = ctx.server !== undefined;
      const csp = [
        ...BASE_CSP,
        dev
          ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
          : "script-src 'self' 'wasm-unsafe-eval'",
        dev ? "connect-src 'self' ws: panda-res: panda-pdf: panda-cmaps:" : "connect-src 'self' panda-res: panda-pdf: panda-cmaps:",
      ].join("; ");
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: csp },
          injectTo: "head",
        },
      ];
    },
  };
}

/**
 * 扩展宿主以独立 CJS 文件运行在 Utility Process 中，构建时复制到 dist-electron。
 * 开发态由主进程回退到源码路径，因此无需额外的构建入口。
 */
function copyExtensionHost(): Plugin {
  return {
    name: "panda-copy-extension-host",
    writeBundle() {
      const source = resolve(rootDir, "electron/extensions/host-runner.cjs");
      const targetDir = resolve(rootDir, "dist-electron");
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(source, resolve(targetDir, "host-runner.cjs"));
    },
  };
}

/**
 * 以 `?inline-binary` 导入二进制资源时，转为 data URL 字符串。
 * 用于导出 HTML 时内联 KaTeX 字体，保证离线打开显示正确。
 */
function inlineBinaryAssets(): Plugin {
  const MIME: Record<string, string> = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return {
    name: "panda-inline-binary",
    enforce: "pre",
    load(id) {
      const [filePath, query] = id.split("?");
      if (!query || !query.includes("inline-binary") || !filePath) return null;
      const absolute = filePath.startsWith("/") ? resolve(rootDir, `.${filePath}`) : resolve(filePath);
      const mime = MIME[absolute.slice(absolute.lastIndexOf("."))];
      if (!mime) return null;
      const base64 = readFileSync(absolute).toString("base64");
      return `export default "data:${mime};base64,${base64}";`;
    },
  };
}

/**
 * PDF.js 渲染 CID 字体（如中文）时需要 Adobe CMap 文件，统一复制到 dist 供自定义协议读取。
 */
function copyPdfjsCMaps(): Plugin {
  return {
    name: "panda-copy-pdfjs-cmaps",
    writeBundle() {
      cpSync(resolve(rootDir, "node_modules/pdfjs-dist/cmaps"), resolve(rootDir, "dist/pdfjs/cmaps"), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), contentSecurityPolicy(), copyExtensionHost(), inlineBinaryAssets(), copyPdfjsCMaps()],
  build: {
    target: "esnext",
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        // 图表渲染沙箱作为独立入口，产物位于 dist/src/render-sandbox/index.html。
        sandbox: resolve(rootDir, "src/render-sandbox/index.html"),
      },
    },
  },
});
