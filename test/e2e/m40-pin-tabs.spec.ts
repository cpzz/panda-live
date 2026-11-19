import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

/** 打开三个文件，返回应用与页面；调用方负责关闭与清理。 */
async function launchWithDocs(tempDir: string, userDataDir: string) {
  const names = ["alpha.md", "beta.md", "gamma.md"];
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, `# ${name}\n`, "utf8");
    files.push(filePath);
  }
  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, targets) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: targets });
  }, files);
  await page.locator(".app").waitFor();
  await page.keyboard.press("Control+O");
  await expect(page.locator(".tabstrip-items .tab")).toHaveCount(3, { timeout: 30_000 });
  return { app, page };
}

/** M40：标签固定——固定标签不参与关闭全部、无法单独关闭，并随会话恢复。 */
test("M40：固定标签不被关闭全部关闭且随会话恢复", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m40-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m40-ud-"));

  const { app, page } = await launchWithDocs(tempDir, userDataDir);
  // 「关闭全部」会弹出 window.confirm 确认框，测试中自动接受。
  page.on("dialog", (dialog) => void dialog.accept());
  const tabItems = page.locator(".tabstrip-items .tab-item");
  const betaTab = tabItems.filter({ hasText: "beta.md" });
  try {
    // 右键 beta 标签打开右键菜单并固定。
    await betaTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "固定标签" }).click();

    // 固定后 beta 排到最左侧，文件图标右下角显示图钉角标，隐藏关闭按钮。
    await expect(tabItems.first()).toContainText("beta.md");
    await expect(betaTab.locator(".tab-pin-badge")).toBeVisible();
    await expect(betaTab.locator(".tab-close")).toHaveCount(0);

    // 关闭全部：固定标签保留，其余全部关闭。
    await page.locator(".tab-close-all").click();
    await expect(tabItems).toHaveCount(1);
    await expect(betaTab).toContainText("beta.md");

    // 固定标签不允许中键关闭。
    await betaTab.click({ button: "middle" });
    await expect(betaTab).toContainText("beta.md");

    // 会话按 15 s 周期落盘；等待 session.json 只剩 beta 且携带 pinned 后再退出。
    await expect
      .poll(async () => {
        const raw = await fs
          .readFile(path.join(userDataDir, "session.json"), "utf8")
          .catch(() => "");
        const parsed = JSON.parse(raw || "{}") as {
          documents?: { path?: string; pinned?: boolean }[];
        };
        if (parsed.documents?.length !== 1) return false;
        return (parsed.documents[0]?.pinned ?? false) && parsed.documents[0]?.path?.endsWith("beta.md");
      }, { timeout: 30_000, intervals: [2_000] })
      .toBe(true);
  } finally {
    await app.close();
  }

  // 重启应用后固定状态随会话恢复。
  const relaunched = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page2 = await relaunched.firstWindow();
    const restored = page2.locator(".tabstrip-items .tab-item").filter({ hasText: "beta.md" });
    await expect(restored).toHaveCount(1, { timeout: 30_000 });
    await expect(restored.locator(".tab-pin-badge")).toBeVisible();

    // 点击文件图标位置的固定插槽取消固定后，关闭按钮恢复，可单独关闭。
    await restored.locator(".tab-pin-slot").click();
    await expect(restored.locator(".tab-pin-badge")).toHaveCount(0);
    await expect(restored.locator(".tab-close")).toBeVisible();
    await restored.locator(".tab-close").click();
    await expect(page2.locator(".tabstrip-items .tab-item")).toHaveCount(0);
  } finally {
    await relaunched.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
