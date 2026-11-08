import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import rendererConfig from "./vite.config.ts";

export default defineConfig(({ mode }) =>
  mergeConfig(rendererConfig, {
    plugins: [
      electron({
        main: {
          entry: "electron/main.ts",
          // 不传默认的 `--no-sandbox`：保留 Chromium 沙箱。
          onstart({ startup }) {
            void startup(["."], {
              env: { ...process.env, PANDA_USER_DATA_DIR: resolve(".dev-user-data") },
            });
          },
          vite: {
            build: {
              outDir: "dist-electron",
              target: "node22",
              emptyOutDir: false,
              minify: false,
              sourcemap: mode === "development",
              rollupOptions: { external: ["electron"] },
            },
          },
        },
        preload: {
          // preload 必须为 CJS：sandbox 为 true 时 Electron 只接受 CommonJS 预加载脚本。
          input: "electron/preload.ts",
          vite: {
            build: {
              outDir: "dist-electron",
              target: "node22",
              emptyOutDir: false,
              minify: false,
              sourcemap: mode === "development",
              rollupOptions: {
                external: ["electron"],
                output: { entryFileNames: "preload.cjs" },
              },
            },
          },
        },
      }),
    ],
  }),
);
