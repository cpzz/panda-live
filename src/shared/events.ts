/** 主进程 → 渲染进程的文件变更事件通道；单独存放，避免 preload 打包 zod。 */
export const FS_CHANGED_CHANNEL = "fs:changed";
