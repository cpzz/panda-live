import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M17：保存换行符与行号设置生效", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m17-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m17-ud-"));
  const filePath = path.join(tempDir, "crlf.md");
  await fs.writeFile(filePath, "# 标题\r\n\r\n正文\r\n", "utf8");

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
    await expect(page.locator(".tab-name")).toHaveText("crlf.md");
    await expect(page.locator(".statusbar")).toContainText("CRLF");
    // Markdown 默认以预览模式打开；换行符/缩进设置作用于源码编辑器。
    await page.getByRole("button", { name: "源码", exact: true }).click();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    // 无改动时保存禁用；修改后可用。
    const saveButton = dialog.getByRole("button", { name: "保存", exact: true });
    await expect(saveButton).toBeDisabled();
    await dialog.getByRole("button", { name: "编辑" }).click();
    await dialog.getByLabel("保存换行符").selectOption("lf");
    await expect(saveButton).toBeEnabled();
    await dialog.getByLabel("显示行号").uncheck();
    await dialog.getByLabel("Tab 宽度").fill("4");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    // 保存不关闭窗口；Esc 关闭后再操作编辑器。
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // 行号设置即时生效。
    await expect(page.locator(".cm-editor.hide-line-numbers")).toHaveCount(1);

    await page.locator(".cm-content").click();
    await page.keyboard.type("追加");
    // Tab 键输出 4 个空格（Tab 宽度已设为 4，默认「插入空格」开启）。
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("缩进");
    const withTab = await page.locator(".cm-content").innerText();
    expect(withTab).toContain("    缩进");
    await page.getByRole("button", { name: "保存文件", exact: true }).click();
    await expect(page.locator(".tab-dot")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".statusbar")).toContainText("LF");

    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).not.toContain("\r");
    expect(raw).toContain("追加");
    // Tab 输出为空格而非 \t。
    expect(raw).not.toContain("\t");
    expect(raw).toContain("缩进");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
