import type { BrowserWindow } from "electron";
import type { ExportService } from "../services/export-service";
import { handle } from "./router";

export interface ExportHandlerOptions {
  exports: ExportService;
  getWindow: () => BrowserWindow | null;
}

/** PDF 导出通道。见 doc/design.md §12.8、§13.1。 */
export function registerExportHandlers({ exports }: ExportHandlerOptions): void {
  handle("export:pdf", (request) => exports.exportPdf(request.html, request.suggestedName));
}
