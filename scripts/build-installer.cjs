const { spawnSync } = require("node:child_process");

/**
 * 启动 electron-builder，并在未显式配置镜像时回退到国内镜像。
 * 已设置 ELECTRON_BUILDER_BINARIES_MIRROR 或 npm_config_electron_builder_binaries_mirror 时尊重用户配置。
 */
const MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/";
const env = { ...process.env };

if (!env.ELECTRON_BUILDER_BINARIES_MIRROR && !env.npm_config_electron_builder_binaries_mirror) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR = MIRROR;
}

const result = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js")], {
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
