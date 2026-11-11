import { BrowserWindow, dialog } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PandaError } from "../../src/shared/errors";
import { t } from "../../src/i18n";
import type { PdfExportResult } from "../../src/shared/ipc";

/**
 * PDF 导出：隐藏 BrowserWindow 执行 printToPDF，禁用 JavaScript。
 * 见 doc/design.md §12.8。
 */
export class ExportService {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly userDataDir: string,
  ) {}

  async exportPdf(html: string, suggestedName: string): Promise<PdfExportResult> {
    const window = this.getWindow();
    const options = {
      defaultPath: suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      throw new PandaError("E_CANCELLED", t("已取消导出"));
    }
    const target = result.filePath;

    const tempDir = path.join(this.userDataDir, "cache", "export");
    await fs.mkdir(tempDir, { recursive: true });
    const tempHtml = path.join(tempDir, `${randomUUID()}.html`);
    await fs.writeFile(tempHtml, html, "utf8");

    const printer = new BrowserWindow({
      show: false,
      webPreferences: {
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    try {
      await printer.loadFile(tempHtml);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
      });
      await fs.writeFile(target, pdf);
    } catch (error) {
      throw new PandaError(
        "E_EXPORT_FAILED",
        t("PDF 导出失败：{0}", error instanceof Error ? error.message : String(error)),
      );
    } finally {
      printer.destroy();
      await fs.rm(tempHtml, { force: true }).catch(() => undefined);
    }
    return { path: target };
  }
}
