import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerFileHandlers } from "./ipc/files";
import { registerExportHandlers } from "./ipc/export";
import { registerExtensionHandlers } from "./ipc/extensions";
import { registerGitHandlers } from "./ipc/git";
import { registerLatexHandlers } from "./ipc/latex";
import { handle, registerAppHandlers } from "./ipc/router";
import { registerStorageHandlers } from "./ipc/storage";
import { registerWorkspaceHandlers } from "./ipc/workspace";
import { DraftService } from "./services/draft-service";
import { ExportService } from "./services/export-service";
import { ExtensionService } from "./services/extension-service";
import { FileService } from "./services/file-service";
import { GitService } from "./services/git-service";
import { handlePandaProtocols, registerPandaSchemes } from "./services/protocol-service";
import { SessionService } from "./services/session-service";
import { SettingsService } from "./services/settings-service";
import { UpdateService } from "./services/update-service";
import { WorkspaceService } from "./services/workspace-service";
import { TexCompiler } from "./tex/compiler";
import { cleanupCompileDirs } from "./tex/pdf-cache";
import { APP_OPEN_PATH_CHANNEL, FS_CHANGED_CHANNEL } from "../src/shared/events";
import { resolveLocale, setLocale, t } from "../src/i18n";
import type { SessionState } from "../src/shared/ipc";
import { MENU_COMMAND_CHANNEL, type MenuCommand } from "../src/shared/menu";
import type { Settings } from "../src/shared/settings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

const files = new FileService();
let mainWindow: BrowserWindow | null = null;
let session: SessionService;
let settings: SettingsService;
let drafts: DraftService;
let workspaces: WorkspaceService | undefined;
let extensions: ExtensionService | undefined;
let windowStateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingOpenPaths: string[] = [];

const DOCUMENT_EXTENSION = /\.(md|markdown|mdown|mkd|qmd|rmd|mdx|myst|mst|tex|latex|mathml|mml|puml|plantuml|mmd|mermaid|adoc|pdf)$/i;

/** 从命令行参数提取可打开的文档路径（文件关联 / 第二实例）。见 §12.7。 */
function extractOpenPaths(argv: readonly string[]): string[] {
  return argv
    .filter((arg) => !arg.startsWith("-") && DOCUMENT_EXTENSION.test(arg))
    .map((arg) => path.resolve(arg));
}

function deliverOpenPaths(paths: string[]): void {
  if (paths.length === 0) return;
  if (!mainWindow) {
    pendingOpenPaths.push(...paths);
    return;
  }
  for (const filePath of paths) {
    mainWindow.webContents.send(APP_OPEN_PATH_CHANNEL, { path: filePath });
  }
}

// 开发期把用户数据放到项目内，避免与正式实例的缓存/单实例锁互相干扰。
const devUserDataDir = process.env.PANDA_USER_DATA_DIR;
if (devUserDataDir) app.setPath("userData", devUserDataDir);

// 自定义协议必须在 app.whenReady() 之前登记。见 doc/design.md §12.6。
registerPandaSchemes();

function sendCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(MENU_COMMAND_CHANNEL, { command });
}

/**
 * 保留不可见的应用菜单：导出等命令仍由主进程驱动，
 * 但窗口菜单栏隐藏，也不提供“查找”菜单项。快捷键由渲染进程处理。
 */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: t("文件"),
      submenu: [
        {
          id: "export-html",
          label: t("导出 HTML…"),
          click: () => sendCommand("file.exportHtml"),
        },
        {
          id: "export-pdf",
          label: t("导出 PDF…"),
          click: () => sendCommand("file.exportPdf"),
        },
        {
          id: "export-svg",
          label: t("导出图表 SVG…"),
          click: () => sendCommand("file.exportSvg"),
        },
        { type: "separator" },
        { role: "quit", label: t("退出") },
      ],
    },
    {
      label: t("编辑"),
      submenu: [
        { role: "undo", label: t("撤销") },
        { role: "redo", label: t("重做") },
        { type: "separator" },
        { role: "cut", label: t("剪切") },
        { role: "copy", label: t("复制") },
        { role: "paste", label: t("粘贴") },
        { role: "selectAll", label: t("全选") },
      ],
    },
    {
      label: t("视图"),
      submenu: [
        { role: "reload", label: t("重新加载") },
        { role: "toggleDevTools", label: t("开发者工具") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 主进程语言与设置保持同步；设置变更后重建原生菜单。 */
function applyLanguage(settingsValue: Settings): void {
  setLocale(resolveLocale(settingsValue.appearance.language, app.getLocale()));
  buildMenu();
}

/**
 * 标题栏系统按钮（titleBarOverlay）配色：跟随应用主题（显式或系统）。
 * macOS 使用 hiddenInset，无需 overlay 配色。
 */
function titlebarOverlayColors(): { color: string; symbolColor: string; height: number } {
  const theme = settings?.get().appearance.theme;
  const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
  return dark
    ? { color: "#252526", symbolColor: "#d4d4d4", height: 40 }
    : { color: "#f8f8f8", symbolColor: "#24292f", height: 40 };
}

function applyTitlebarOverlay(): void {
  if (process.platform === "darwin") return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay(titlebarOverlayColors());
  } catch {
    // 部分平台/版本不支持运行时改 overlay 配色，保持创建时的取值即可。
  }
}

function createWindow(bounds?: SessionState["window"]): void {
  const iconPath = path.join(__dirname, "../dist/icon.png");
  const window = new BrowserWindow({
    x: bounds?.x,
    y: bounds?.y,
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Panda Live",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    // 合并标题栏与工具栏：Windows/Linux 用 overlay 保留系统窗口按钮，macOS 用 hiddenInset 红绿灯。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : { titleBarStyle: "hidden" as const, titleBarOverlay: titlebarOverlayColors() }),
    autoHideMenuBar: false,
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
  window.setMenuBarVisibility(false);
  if (bounds?.maximized) window.maximize();
  window.once("ready-to-show", () => window.show());

  // 窗口尺寸/位置每 500 ms 防抖写回会话。见 doc/design.md §12.4。
  const saveBounds = (): void => {
    if (windowStateTimer) clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(() => {
      if (window.isDestroyed()) return;
      void session.saveWindow({ ...window.getNormalBounds(), maximized: window.isMaximized() });
    }, 500);
  };
  window.on("resize", saveBounds);
  window.on("move", saveBounds);

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
  const userDataDir = app.getPath("userData");
  // 清理异常退出遗留的编译临时目录；PDF 缓存在编译成功后按 LRU 上限淘汰。
  void cleanupCompileDirs(path.join(userDataDir, "compile"));
  settings = new SettingsService(userDataDir);
  session = new SessionService(userDataDir);
  drafts = new DraftService(userDataDir);
  const workspaceService = new WorkspaceService(files, (event) => {
    mainWindow?.webContents.send(FS_CHANGED_CHANNEL, event);
  });
  workspaces = workspaceService;
  await settings.load();
  applyLanguage(settings.get());

  const appRoot = path.join(__dirname, "..");
  const builtRunner = path.join(__dirname, "host-runner.cjs");
  const sourceRunner = path.join(appRoot, "electron", "extensions", "host-runner.cjs");
  const extensionService = new ExtensionService({
    userDataDir,
    appRoot,
    appVersion: app.getVersion(),
    hostRunnerPath: existsSync(builtRunner) ? builtRunner : sourceRunner,
  });
  extensions = extensionService;
  await extensionService.init();

  handlePandaProtocols(
    files,
    path.join(__dirname, "../dist"),
    (extensionId) => extensionService.resolveProtocolRoot(extensionId),
    path.join(userDataDir, "cache", "pdf"),
    [
      path.join(__dirname, "../dist/pdfjs/cmaps"),
      path.join(__dirname, "../node_modules/pdfjs-dist/cmaps"),
    ],
  );
  registerAppHandlers();
  registerFileHandlers({ files, getWindow: () => mainWindow });
  registerWorkspaceHandlers({ files, workspaces: workspaceService, getWindow: () => mainWindow });
  registerGitHandlers({ files, git: new GitService(), settings });
  registerStorageHandlers({
    settings,
    session,
    drafts,
    onSettingsChanged: (next) => {
      applyLanguage(next);
      applyTitlebarOverlay();
    },
  });
  registerExtensionHandlers({ extensions: extensionService, getWindow: () => mainWindow });
  handle("app:pendingOpenPaths", () => pendingOpenPaths.splice(0));
  handle("update:check", () =>
    new UpdateService(app.getVersion(), process.env["PANDA_UPDATE_FEED"]).check(),
  );
  registerExportHandlers({ exports: new ExportService(userDataDir) });
  registerLatexHandlers({
    compiler: new TexCompiler(files, userDataDir, () => settings.get().latex),
    engineCommand: () => settings.get().latex.engineCommand,
  });
  buildMenu();
  // 系统主题切换时同步标题栏按钮配色。
  nativeTheme.on("updated", () => {
    if (settings) applyTitlebarOverlay();
  });

  const saved = await session.load();
  // 允许根是进程内状态，重启后为空；按会话恢复登记，标签与工作区才能重新打开。
  // session.json 位于用户数据目录，由应用自身写入，登记其中的路径与上次授权一致。
  if (saved) {
    for (const doc of saved.documents) {
      if (doc.path) await files.registerPath(doc.path).catch(() => undefined);
    }
    const workspaceRoots =
      saved.workspace?.roots ??
      (saved.workspace?.rootPath
        ? [{ rootPath: saved.workspace.rootPath, expanded: saved.workspace.expanded ?? [] }]
        : []);
    for (const root of workspaceRoots) {
      await files.registerRoot(root.rootPath).catch(() => undefined);
    }
  }
  createWindow(saved?.window);
  // 启动参数（文件关联）先入队，渲染进程就绪后通过 IPC 取走。
  pendingOpenPaths.push(...extractOpenPaths(process.argv.slice(1)));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  // 单实例锁不可用时窗口不会出现，必须留下可诊断的日志。
  console.error("[lifecycle] 单实例锁获取失败：已有实例运行，或用户数据目录不可写");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    deliverOpenPaths(extractOpenPaths(argv));
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error("[lifecycle] bootstrap failed", error);
    app.quit();
  });
}

app.on("before-quit", () => {
  void workspaces?.dispose();
  extensions?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
