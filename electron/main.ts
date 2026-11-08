import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerFileHandlers } from "./ipc/files";
import { registerAppHandlers } from "./ipc/router";
import { FileService } from "./services/file-service";
import { handlePandaProtocols, registerPandaSchemes } from "./services/protocol-service";
import { MENU_COMMAND_CHANNEL, type MenuCommand } from "../src/shared/menu";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

const files = new FileService();
let mainWindow: BrowserWindow | null = null;

// 开发期把用户数据放到项目内，避免与正式实例的缓存/单实例锁互相干扰。
const devUserDataDir = process.env.PANDA_USER_DATA_DIR;
if (devUserDataDir) app.setPath("userData", devUserDataDir);

// 自定义协议必须在 app.whenReady() 之前登记。见 doc/design.md §12.6。
registerPandaSchemes();

function sendCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(MENU_COMMAND_CHANNEL, { command });
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开…",
          accelerator: "CmdOrCtrl+O",
          click: () => sendCommand("file.open"),
        },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => sendCommand("file.save"),
        },
        {
          label: "另存为…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendCommand("file.saveAs"),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Panda Live",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17181a" : "#f6f7f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error("[lifecycle] render-process-gone", details.reason, details.exitCode);
  });
  window.on("unresponsive", () => {
    console.error("[lifecycle] window-unresponsive");
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  handlePandaProtocols(files, path.join(__dirname, "../dist"));
  registerAppHandlers();
  registerFileHandlers({ files, getWindow: () => mainWindow });
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  // 单实例锁不可用时窗口不会出现，必须留下可诊断的日志。
  console.error("[lifecycle] 单实例锁获取失败：已有实例运行，或用户数据目录不可写");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error("[lifecycle] bootstrap failed", error);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
