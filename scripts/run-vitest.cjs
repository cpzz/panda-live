const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 以盘符大写化的路径启动 vitest。
 *
 * 背景：Windows 上 Node ESM 的模块缓存区分 file URL 盘符大小写。
 * Git Bash 等 shell 中 process.cwd() 为小写盘符（d:\…），而 Vite 会把盘符
 * 统一归一为大写（D:\…）。两者不一致时，vitest worker 入口链与测试文件的
 * `import "vitest"` 会各自加载一份 run 分片模块实例：worker 侧设置的
 * runner 上下文对测试文件侧不可见，所有测试文件都在 describe() 处报
 * “Cannot read properties of undefined (reading 'config')”。
 * 故先 chdir 到盘符大写的路径（与 Vite 归一结果一致），再启动 vitest。
 */
function normalizedRoot() {
  const real = fs.realpathSync(process.cwd());
  return real.replace(/^([a-zA-Z]):/, (drive) => drive.toUpperCase());
}

const root = normalizedRoot();
if (root.toLowerCase() !== process.cwd().toLowerCase()) process.chdir(root);

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitestEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
