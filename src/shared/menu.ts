export const MENU_COMMAND_CHANNEL = "menu:command";

export const MENU_COMMANDS = ["file.open", "file.save", "file.saveAs"] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && (MENU_COMMANDS as readonly string[]).includes(value);
}
