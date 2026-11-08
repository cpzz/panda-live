import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-electron/**", "release/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "electron/*"],
              message: "渲染进程不得直接依赖 Electron，请通过 window.panda 调用平台能力。",
            },
            {
              group: ["node:*", "fs", "path", "os", "child_process"],
              message: "渲染进程不得访问 Node 与文件系统。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["electron/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../src/editor/*", "../../src/formats/*"],
              message: "主进程不解析文档，请保持格式逻辑在渲染进程。",
            },
          ],
        },
      ],
    },
  },
);
