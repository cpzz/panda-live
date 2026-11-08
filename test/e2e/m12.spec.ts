import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M12：表格焦点工具条支持增删行列、对齐与删除表格", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m12-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m12-ud-"));
  const filePath = path.join(tempDir, "table.md");
  await fs.writeFile(
    filePath,
    ["# 表格", "", "| 名称 | 数量 |", "| --- | --- |", "| 苹果 | 2 |", ""].join("\n"),
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
    await expect(page.locator(".tab-name")).toHaveText("table.md");

    await page.getByRole("button", { name: "所见即所得", exact: true }).click();
    const table = page.locator(".prose-editor table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".prose-editor tr")).toHaveCount(2);

    // 点击单元格后出现工具条。
    await page.locator(".prose-editor td").first().click();
    const toolbar = page.locator(".table-toolbar");
    await expect(toolbar).toBeVisible();

    await toolbar.getByRole("button", { name: "在下方插入行" }).click();
    await expect(page.locator(".prose-editor tr")).toHaveCount(3);

    await toolbar.getByRole("button", { name: "删除行" }).click();
    await expect(page.locator(".prose-editor tr")).toHaveCount(2);

    await toolbar.getByRole("button", { name: "右对齐" }).click();
    // 整列对齐：表头与数据单元格都应更新。
    await expect(page.locator('.prose-editor [data-align="right"]')).toHaveCount(2);

    await toolbar.getByRole("button", { name: "删除表格" }).click();
    await expect(page.locator(".prose-editor table")).toHaveCount(0);
    await expect(toolbar).toBeHidden();
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
