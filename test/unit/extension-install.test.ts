import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPackage, isSafePackagePath } from "../../electron/extensions/installer";

const MANIFEST = {
  id: "acme.notes",
  version: "1.0.0",
  engines: { panda: "^0.1.0" },
  main: "dist/extension.js",
  activationEvents: ["onFormat:notes"],
  permissions: [],
  contributes: {
    formats: [
      {
        id: "notes",
        extensions: [".note"],
        capabilities: { source: true, wysiwyg: false, preview: "inline" },
        language: "notes",
      },
    ],
    languages: [{ id: "notes", extensions: [".note"], syntax: "plain" }],
  },
};

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "panda-ext-install-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function buildZip(entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const archive = path.join(root, "package.panda");
  await fs.writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
  return archive;
}

describe("扩展安装", () => {
  it("合法包解压到扩展目录", async () => {
    const archive = await buildZip({
      "extension.json": JSON.stringify(MANIFEST),
      "dist/extension.js": "module.exports.activate = () => {};",
    });
    const extensionsRoot = path.join(root, "installed");
    const result = await installPackage(archive, extensionsRoot, "0.1.0");
    expect(result.id).toBe("acme.notes");
    const installed = await fs.readFile(path.join(result.dir, "dist/extension.js"), "utf8");
    expect(installed).toContain("activate");
  });

  it("拒绝路径穿越与绝对路径的条目", () => {
    expect(isSafePackagePath("../escape.txt")).toBe(false);
    expect(isSafePackagePath("dist/../../escape.txt")).toBe(false);
    expect(isSafePackagePath("/etc/passwd")).toBe(false);
    expect(isSafePackagePath("dist\\extension.js")).toBe(false);
    expect(isSafePackagePath("dist/extension.js")).toBe(true);
  });

  it("缺少清单时拒绝", async () => {
    const archive = await buildZip({ "dist/extension.js": "module.exports.activate = () => {};" });
    await expect(installPackage(archive, path.join(root, "installed"), "0.1.0")).rejects.toThrow(
      "extension.json",
    );
  });

  it("低版本覆盖已安装的高版本时拒绝", async () => {
    const extensionsRoot = path.join(root, "installed");
    const target = path.join(extensionsRoot, "acme.notes");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, "extension.json"),
      JSON.stringify({ ...MANIFEST, version: "2.0.0" }),
      "utf8",
    );
    const archive = await buildZip({
      "extension.json": JSON.stringify(MANIFEST),
      "dist/extension.js": "module.exports.activate = () => {};",
    });
    await expect(installPackage(archive, extensionsRoot, "0.1.0")).rejects.toThrow(
      "拒绝安装",
    );
  });

  it("缺少入口文件时拒绝", async () => {
    const archive = await buildZip({ "extension.json": JSON.stringify(MANIFEST) });
    await expect(installPackage(archive, path.join(root, "installed"), "0.1.0")).rejects.toThrow(
      "入口文件不存在",
    );
  });
});
