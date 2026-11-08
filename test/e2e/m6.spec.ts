import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

async function prepareUserData(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "panda-m6-ud-"));
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
}

async function openFile(
  app: ElectronApplication,
  page: import("@playwright/test").Page,
  filePath: string,
): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, filePath);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".tab-name")).toHaveText(path.basename(filePath));
}

async function mockSavePath(
  app: ElectronApplication,
  target: string,
): Promise<void> {
  await app.evaluate(({ dialog }, savePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath });
  }, target);
}

async function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, itemId) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById(itemId);
    if (!item?.click) throw new Error(`菜单项不存在：${itemId}`);
    item.click(item, undefined);
  }, id);
}

async function waitForFile(target: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => (await fs.stat(target).catch(() => null))?.size ?? 0, {
      timeout,
      intervals: [500],
    })
    .toBeGreaterThan(0);
}

test("M6：导出 HTML 内联数学与图表且不含脚本", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m6-html-"));
  const userDataDir = await prepareUserData();
  const mdPath = path.join(tempDir, "export.md");
  const htmlPath = path.join(tempDir, "export.html");
  // 1×1 透明 PNG，用于验证图片内联
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await fs.writeFile(path.join(tempDir, "pixel.png"), png);
  await fs.writeFile(
    mdPath,
    "# 导出标题\n\n公式 $a^2+b^2=c^2$。\n\n![像素](pixel.png)\n\n```plantuml\n@startuml\nAlice -> Bob : Hello\n@enduml\n```\n",
    "utf8",
  );

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, mdPath);
    await mockSavePath(app, htmlPath);
    await clickMenuItem(app, "export-html");
    await waitForFile(htmlPath);

    const html = await fs.readFile(htmlPath, "utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("导出标题");
    expect(html).toContain("katex");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain('class="diagram-export"');
    expect(html).toContain("<svg");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("<script");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M6：导出 PDF", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m6-pdf-"));
  const userDataDir = await prepareUserData();
  const mdPath = path.join(tempDir, "report.md");
  const pdfPath = path.join(tempDir, "report.pdf");
  await fs.writeFile(mdPath, "# PDF 报告\n\n正文内容。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, mdPath);
    await mockSavePath(app, pdfPath);
    await clickMenuItem(app, "export-pdf");
    await waitForFile(pdfPath, 40_000);

    const head = await fs.readFile(pdfPath);
    expect(head.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(head.byteLength).toBeGreaterThan(1000);
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M6：导出图表 SVG", async () => {
  test.setTimeout(180_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m6-svg-"));
  const userDataDir = await prepareUserData();
  const pumlPath = path.join(tempDir, "diagram.puml");
  const svgPath = path.join(tempDir, "diagram.svg");
  await fs.writeFile(pumlPath, "@startuml\nAlice -> Bob : Hello\n@enduml\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, pumlPath);
    await mockSavePath(app, svgPath);
    await clickMenuItem(app, "export-svg");
    await waitForFile(svgPath);

    const svg = await fs.readFile(svgPath, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<script");
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test("M6：.tex 打开后给出引擎状态", async () => {
  test.setTimeout(120_000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m6-tex-"));
  const userDataDir = await prepareUserData();
  const texPath = path.join(tempDir, "paper.tex");
  await fs.writeFile(texPath, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n", "utf8");

  const app = await launch(userDataDir);
  try {
    const page = await app.firstWindow();
    await openFile(app, page, texPath);
    const status = (await page.evaluate(() => window.panda.latex.detect())) as {
      available: boolean;
    };
    if (!status.available) {
      await expect(page.locator(".preview-pane")).toContainText("未检测到 TeX 引擎", {
        timeout: 15_000,
      });
    } else {
      await expect(page.locator(".tex-actions")).toBeVisible({ timeout: 15_000 });
    }
  } finally {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
