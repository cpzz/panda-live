export const MENU_COMMAND_CHANNEL = "menu:command";

export const MENU_COMMANDS = [
  "file.new",
  "file.open",
  "file.save",
  "file.saveAs",
  "file.close",
  "file.exportHtml",
  "file.exportPdf",
  "file.exportSvg",
  "workspace.open",
  "view.find",
  "view.replace",
  "view.settings",
  "view.performance",
  "latex.compile",
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && (MENU_COMMANDS as readonly string[]).includes(value);
}
