import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const CWD = path.resolve(".");

async function packExtension(sourceDir: string, target: string): Promise<void> {
  const zip = new JSZip();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`);
      } else {
        zip.file(`${prefix}${entry.name}`, await fs.readFile(full));
      }
    }
  };
  await walk(sourceDir, "");
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

test("M10：扩展诊断汇入问题面板并可按行跳转", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m10-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m10-ud-"));

  // 临时扩展：预览返回一条带行号的警告诊断。
  const extensionDir = path.join(tempDir, "ext");
  await fs.mkdir(path.join(extensionDir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(extensionDir, "extension.json"),
    JSON.stringify(
      {
        id: "test.problems",
        version: "1.0.0",
        engines: { panda: "^0.1.0" },
        main: "dist/extension.js",
        activationEvents: ["onFormat:problemdoc"],
        permissions: ["workspace:read"],
        contributes: {
          formats: [
            {
              id: "problemdoc",
              extensions: [".pdoc"],
              capabilities: { source: true, wysiwyg: false, preview: "inline", outline: false, exportHtml: false },
              language: "problemdoc",
            },
          ],
          languages: [{ id: "problemdoc", extensions: [".pdoc"], syntax: "plain" }],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(extensionDir, "dist", "extension.js"),
    [
      '"use strict";',
      "const provider = {",
      '  id: "problemdoc",',
      '  extensions: [".pdoc"],',
      "  async parse(source) {",
      "    return {",
      '      doc: { type: "doc", content: [{ type: "raw_markdown", attrs: { raw: String(source), reason: "extension" } }] },',
      '      diagnostics: [{ severity: "warning", message: "测试警告", line: 2 }],',
      "    };",
      "  },",
      "  async serialize(doc) {",
      "    const first = doc && doc.content && doc.content[0];",
      '    return (first && first.attrs && first.attrs.raw) || "";',
      "  },",
      "  async renderPreview(doc) {",
      "    const first = doc && doc.content && doc.content[0];",
      '    const raw = (first && first.attrs && first.attrs.raw) || "";',
      '    return `<pre>${String(raw).replace(/</g, "&lt;")}</pre>`;',
      "  },",
      "};",
      "module.exports.activate = (ctx) => {",
      "  ctx.subscriptions.push(ctx.api.formats.registerProvider(provider));",
      "};",
    ].join("\n"),
    "utf8",
  );
  const archive = path.join(tempDir, "problems.panda");
  await packExtension(extensionDir, archive);

  const docPath = path.join(tempDir, "sample.pdoc");
  await fs.writeFile(docPath, "第一行\n第二行需要检查\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  let page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, archive);
    const info = (await page.evaluate(async () => window.panda.ext.install())) as { id: string };
    await page.evaluate((id) => window.panda.ext.enable(id), info.id);

    // 重载以刷新渲染进程的格式注册表。
    await page.reload();
    page = await app.firstWindow();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, docPath);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("sample.pdoc");

    const statusButton = page.getByRole("button", { name: "问题面板" });
    await expect(statusButton).toContainText("警告 1", { timeout: 15_000 });
    await statusButton.click();

    const row = page.locator(".problem-row").first();
    await expect(row.locator(".problem-message")).toHaveText("测试警告");
    await expect(row.locator(".problem-line")).toHaveText("行 2");
    await expect(row.locator(".problem-source")).toHaveText("扩展");

    await row.click();
    await expect(page.locator(".statusbar")).toContainText("行 2，列 1", { timeout: 10_000 });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
