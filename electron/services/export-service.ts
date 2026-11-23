import { BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PandaError } from "../../src/shared/errors";
import { t } from "../../src/i18n";
import type { PdfExportResult } from "../../src/shared/ipc";

/**
 * PDF 导出：隐藏 BrowserWindow 执行 printToPDF，禁用 JavaScript。
 * 另存为窗口由渲染进程先行确认（dialog:saveAs），这里只负责打印与写盘。
 * 见 doc/design.md §12.8。
 */
export class ExportService {
  constructor(private readonly userDataDir: string) {}

  async exportPdf(html: string, target: string): Promise<PdfExportResult> {
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
