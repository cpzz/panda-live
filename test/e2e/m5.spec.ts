import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const CWD = path.resolve(".");

async function prepareUserData(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "panda-m5-ud-"));
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
}

/** 把扩展目录打包为 .panda（zip）。 */
async function packExtension(sourceDir: string, target: string): Promise<string> {
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
  return target;
}

async function installAndEnable(
  app: ElectronApplication,
  page: import("@playwright/test").Page,
  archive: string,
): Promise<string> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, archive);
  const info = (await page.evaluate(async () => window.panda.ext.install())) as { id: string };
  await page.evaluate((id) => window.panda.ext.enable(id), info.id);
  return info.id;
}

test("M5：示例扩展新增 .adoc 格式，禁用后回退纯文本", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m5-sample-"));
  const userDataDir = await prepareUserData();
  const path0 = path.join(tempDir, "sample.adoc");
  await fs.writeFile(path0, "= 示例标题\n\n正文段落\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    const archive = await packExtension(
      path.resolve("extensions/examples/asciidoc"),
      path.join(tempDir, "asciidoc.panda"),
    );
    const id = await installAndEnable(app, page, archive);
    expect(id).toBe("panda.sample-asciidoc");

    const formats = (await page.evaluate(() => window.panda.ext.formats())) as Array<{ id: string }>;
    expect(formats.map((item) => item.id)).toContain("asciidoc");

    // 打开 .adoc：源码 + 扩展预览
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, path0);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("sample.adoc");
    await expect(page.locator(".extension-preview h1")).toHaveText("示例标题", { timeout: 15_000 });
    await expect(page.locator(".extension-preview p")).toHaveText("正文段落");

    // 源码编辑后保存，写回仍是 AsciiDoc 源文本
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("= 更新标题\n\n更新正文");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".tab-dot")).toHaveCount(0, { timeout: 10_000 });
    const saved = await fs.readFile(path0, "utf8");
    expect(saved).toContain("更新标题");

    // 禁用扩展并刷新注册表后，同一文件回退纯文本
    await page.evaluate((extensionId) => window.panda.ext.disable(extensionId), id);
    await page.reload();
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, path0);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("sample.adoc");
    await expect(page.locator(".preview-pane .placeholder")).toContainText("暂不支持渲染预览", {
      timeout: 15_000,
    });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M5：恶意扩展无法绕过权限直接读写文件", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m5-evil-"));
  const userDataDir = await prepareUserData();

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    const archive = await packExtension(
      path.resolve("test/fixtures/extensions/evil"),
      path.join(tempDir, "evil.panda"),
    );
    const id = await installAndEnable(app, page, archive);
    expect(id).toBe("evil.writer");

    const outcome = (await page.evaluate(async () => {
      try {
        await window.panda.ext.command("evil.write");
        return { ok: true, message: "" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    })) as { ok: boolean; message: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("E_EXTENSION_PERMISSION_DENIED");

    // 宿主禁止 fs：任何位置都不应出现 evil.txt
    expect(await pathExists(path.join(userDataDir, "extensions", "evil.writer", "evil.txt"))).toBe(false);
    expect(await pathExists(path.join(CWD, "evil.txt"))).toBe(false);

    const list = (await page.evaluate(() => window.panda.ext.list())) as Array<{
      id: string;
      error?: string;
    }>;
    const entry = list.find((item) => item.id === "evil.writer");
    expect(entry?.error ?? "").toContain("E_EXTENSION_PERMISSION_DENIED");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M5：扩展激活超时被宿主终止", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m5-slow-"));
  const userDataDir = await prepareUserData();

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    const archive = await packExtension(
      path.resolve("test/fixtures/extensions/slow"),
      path.join(tempDir, "slow.panda"),
    );
    await installAndEnable(app, page, archive);

    const started = Date.now();
    const outcome = (await page.evaluate(async () => {
      try {
        await window.panda.ext.command("slow.run");
        return { ok: true, message: "" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    })) as { ok: boolean; message: string };
    const elapsed = Date.now() - started;
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("激活超时");
    expect(elapsed).toBeLessThan(20_000);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
