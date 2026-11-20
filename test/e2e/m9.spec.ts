import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function launchWithFile(
  filePath: string,
): Promise<{ app: import("@playwright/test").ElectronApplication; page: import("@playwright/test").Page; userDataDir: string }> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m9-ud-"));
  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);
  await page.locator(".app").waitFor();
  await page.keyboard.press("Control+O");
  await expect(page.locator(".tab-name")).toHaveText(path.basename(filePath));
  return { app, page, userDataDir };
}

test("M9：Markdown 大纲显示标题层级并可跳转到源码行", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m9-md-"));
  const filePath = path.join(tempDir, "outline.md");
  await fs.writeFile(filePath, "# 一级标题\n\n正文\n\n## 二级标题\n\n更多\n", "utf8");

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    // Markdown 默认预览模式；大纲跳转的目标是源码行。
    await page.getByRole("button", { name: "源码", exact: true }).click();
    const items = page.locator(".outline-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText("一级标题");
    await expect(items.nth(1)).toHaveText("二级标题");

    await items.nth(1).click();
    await expect(page.locator(".statusbar")).toContainText("行 5，列 1", { timeout: 10_000 });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M9：LaTeX 大纲提取章节命令", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m9-tex-"));
  const filePath = path.join(tempDir, "paper.tex");
  await fs.writeFile(
    filePath,
    "\\documentclass{article}\n\\begin{document}\n\\section{绪论}\n\\subsection{背景}\n\\end{document}\n",
    "utf8",
  );

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    const items = page.locator(".outline-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveText("绪论");
    await expect(items.nth(1)).toHaveText("背景");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M9：预览模式点大纲项切回源码并定位到目标行", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m9-svg-"));
  // SVG 默认以预览模式打开；大纲项没有标题 DOM，需切回源码按行定位。
  const filePath = path.join(tempDir, "shapes.svg");
  await fs.writeFile(
    filePath,
    '<svg xmlns="http://www.w3.org/2000/svg">\n  <g id="layer-1">\n    <title>图形一</title>\n  </g>\n</svg>\n',
    "utf8",
  );

  const { app, page, userDataDir } = await launchWithFile(filePath);
  try {
    const items = page.locator(".outline-item");
    await expect(items).toHaveCount(2);
    await items.nth(0).click();
    // 点击后应切回源码模式并定位到目标行（<g id="layer-1"> 在第 2 行）；
    // 该跳转不能被 preview→source 模式切换触发的编辑器 state 重建清掉。
    await expect(page.locator(".source-pane")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".statusbar")).toContainText("行 2，列 1", { timeout: 10_000 });
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
