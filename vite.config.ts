import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync } from "node:fs";
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
        dev ? "connect-src 'self' ws: panda-res: panda-pdf:" : "connect-src 'self' panda-res: panda-pdf:",
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

export default defineConfig({
  base: "./",
  plugins: [react(), contentSecurityPolicy(), copyExtensionHost()],
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
