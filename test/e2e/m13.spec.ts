import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M13：公式与图表诊断汇入问题面板", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m13-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m13-ud-"));
  const filePath = path.join(tempDir, "diagnostics.md");
  await fs.writeFile(
    filePath,
    ["# 诊断", "", "$\\frac{1}{$", "", "```plantuml", "!include /etc/passwd", "```", ""].join("\n"),
    "utf8",
  );

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await page.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".tab-name")).toHaveText("diagnostics.md");

    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    await expect(page.locator(".math-node-error")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".diagram-error")).toBeVisible({ timeout: 15_000 });

    const statusButton = page.getByRole("button", { name: "问题面板" });
    await expect(statusButton).toContainText("错误 2", { timeout: 15_000 });
    await statusButton.click();

    await expect(page.locator(".problem-row", { hasText: "公式渲染失败" })).toHaveCount(1);
    await expect(page.locator(".problem-row", { hasText: "图表渲染失败" })).toHaveCount(1);
    await expect(page.locator('.problem-row', { hasText: "公式渲染失败" }).locator(".problem-source")).toHaveText("公式");
    await expect(page.locator('.problem-row', { hasText: "图表渲染失败" }).locator(".problem-source")).toHaveText("图表");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
