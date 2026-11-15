import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function launchWithFile(
  filePath: string,
): Promise<{ app: ElectronApplication; page: import("@playwright/test").Page; userDataDir: string }> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-ud-"));
  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".tab-name")).toHaveText(path.basename(filePath));
  // Markdown 默认以所见即所得打开；这些用例验证源码编辑器能力。
  await page.getByRole("button", { name: "源码", exact: true }).click();
  return { app, page, userDataDir };
}

test("M7：源码模式 Ctrl+G 跳转行", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-goto-"));
  const filePath = path.join(tempDir, "goto.md");
  await fs.writeFile(filePath, "第一行\n第二行\n第三行内容\n第四行\n", "utf8");

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+G");
    const input = page.getByLabel("跳转到行");
    await expect(input).toBeVisible();
    await input.fill("3:2");
    await input.press("Enter");
    await expect(page.locator(".statusbar")).toContainText("行 3，列 2", { timeout: 10_000 });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M7：未配置更新源时给出可诊断状态", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-update-"));
  const filePath = path.join(tempDir, "note.md");
  await fs.writeFile(filePath, "# note\n", "utf8");

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    const status = (await page.evaluate(() => window.panda.update.check())) as {
      status: string;
      currentVersion: string;
    };
    expect(status.status).toBe("not-configured");
    expect(status.currentVersion.length).toBeGreaterThan(0);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M7：标签支持拖拽排序与中键关闭", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-tabs-"));
  const first = path.join(tempDir, "a.md");
  const second = path.join(tempDir, "b.md");
  await fs.writeFile(first, "# A\n", "utf8");
  await fs.writeFile(second, "# B\n", "utf8");

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-ud-"));
  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, targets) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: targets });
  }, [first, second]);
  await page.getByRole("button", { name: "打开", exact: true }).click();

  const tabs = page.locator(".tab");
  try {
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0).locator(".tab-name")).toHaveText("a.md");
    await expect(tabs.nth(1).locator(".tab-name")).toHaveText("b.md");

    await page.evaluate(() => {
      const source = document.querySelectorAll<HTMLElement>(".tab")[0];
      const target = document.querySelectorAll<HTMLElement>(".tab")[1];
      if (!source || !target) throw new Error("标签数量不足");
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(tabs.nth(0).locator(".tab-name")).toHaveText("b.md");
    await expect(tabs.nth(1).locator(".tab-name")).toHaveText("a.md");

    await tabs.nth(0).click({ button: "middle" });
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0).locator(".tab-name")).toHaveText("a.md");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M7：超过 1 MB 的图片显示占位并可手动加载", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m7-img-"));
  const filePath = path.join(tempDir, "image.md");
  await fs.writeFile(filePath, "# 大图\n\n![大图](big.png)\n", "utf8");
  await fs.writeFile(path.join(tempDir, "big.png"), Buffer.alloc(1_300_000, 1));

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    // 大图占位由渲染预览提供；Markdown 默认所见即所得，这里切到预览。
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const placeholder = page.locator(".big-image-placeholder");
    await expect(placeholder).toContainText("图片较大", { timeout: 15_000 });
    await expect(placeholder.getByRole("button", { name: "加载图片" })).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
