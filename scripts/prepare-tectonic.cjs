const { binaryPath } = require("node-tectonic");
const fs = require("node:fs");
const path = require("node:path");

/** 打包前把当前平台的 Tectonic 二进制复制到 build/tectonic，供 electron-builder 作为 extraResources 携带。 */
const source = binaryPath();
const targetDir = path.join(__dirname, "..", "build", "tectonic");
fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

const target = path.join(targetDir, path.basename(source));
fs.copyFileSync(source, target);
console.log(`已准备内置 Tectonic：${target}`);
