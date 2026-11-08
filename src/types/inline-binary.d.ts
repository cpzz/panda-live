/** 以 `?inline-binary` 导入的二进制资源会展开为 data URL 字符串（见 vite.config.ts 插件）。 */
declare module "*?inline-binary" {
  const dataUrl: string;
  export default dataUrl;
}
