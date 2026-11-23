import type { ExportService } from "../services/export-service";
import { handle } from "./router";

export interface ExportHandlerOptions {
  exports: ExportService;
}

/** PDF 导出通道：另存为路径由渲染进程先行确认。见 doc/design.md §12.8、§13.1。 */
export function registerExportHandlers({ exports }: ExportHandlerOptions): void {
  handle("export:pdf", (request) => exports.exportPdf(request.html, request.path));
}
