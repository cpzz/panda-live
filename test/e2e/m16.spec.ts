import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M16：公式编辑可复制 MathML 到剪贴板", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m16-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m16-ud-"));
  const filePath = path.join(tempDir, "formula.md");
  await fs.writeFile(filePath, "# 公式\n\n$\\frac{a}{b}$\n", "utf8");

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
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-name")).toHaveText("formula.md");

    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const mathNode = page.locator(".prose-editor .math-node").first();
    await expect(mathNode).toBeVisible({ timeout: 15_000 });
    await mathNode.dblclick();

    const copyButton = page.getByRole("button", { name: "复制 MathML" });
    await expect(copyButton).toBeVisible({ timeout: 20_000 });
    await copyButton.click();

    await expect
      .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toContain("mfrac");
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain("<math");
    expect(copied).toContain("a");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
