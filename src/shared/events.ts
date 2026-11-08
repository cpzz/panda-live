/** 主进程 → 渲染进程的文件变更事件通道；单独存放，避免 preload 打包 zod。 */
export const FS_CHANGED_CHANNEL = "fs:changed";

/** 主进程 → 渲染进程：第二实例 / 文件关联传入的待打开路径。 */
export const APP_OPEN_PATH_CHANNEL = "app:open-path";
