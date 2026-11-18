const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 打包前确保 Electron 本地二进制存在。
 * electron 的 postinstall 下载失败时会静默跳过，而 electron-builder 不像
 * `electron .` 那样有自动补齐兜底，直接报 electronDist 不存在，故在此补齐。
 */
const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const executable =
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron";
const distExecutable = path.join(electronDir, "dist", executable);

if (fs.existsSync(distExecutable)) {
  console.log("Electron 本地二进制已存在，跳过下载。");
  process.exit(0);
}

console.log("Electron 本地二进制缺失，开始下载…");
const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
  stdio: "inherit",
});
if (result.status !== 0 || !fs.existsSync(distExecutable)) {
  console.error(
    "Electron 下载失败。可设置镜像后重试：" +
      '$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"'
  );
  process.exit(1);
}
console.log("Electron 本地二进制就绪。");
