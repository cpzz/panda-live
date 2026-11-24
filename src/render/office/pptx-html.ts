/** PPTX → 每页幻灯片 HTML 字符串（@jvmr/pptx-to-html 封装）。
 * 浏览器使用全局 DOMParser；Node 单测经 domParserFactory 注入 jsdom 解析器。
 * 输出为内联样式 HTML，渲染前须经 sanitizeHtml 消毒。 */
import type { pptxToHtml } from "@jvmr/pptx-to-html";

type PptxToHtmlConfig = NonNullable<Parameters<typeof pptxToHtml>[1]>;

export interface PptxRenderOptions {
  /** 目标视口宽（px），默认 960。 */
  width?: number;
  /** 目标视口高（px），默认 540。 */
  height?: number;
  /** Node 环境注入 DOMParser 工厂。 */
  domParserFactory?: PptxToHtmlConfig extends { domParserFactory?: infer F } ? F : never;
}

/** PPTX 字节 → 幻灯片 HTML 数组（按演示顺序）。解析失败抛错，由调用方转提示。 */
export async function pptxToSlideHtml(
  buffer: ArrayBuffer,
  options: PptxRenderOptions = {},
): Promise<string[]> {
  const { pptxToHtml } = await import("@jvmr/pptx-to-html");
  return pptxToHtml(buffer, {
    width: options.width ?? 960,
    height: options.height ?? 540,
    domParserFactory: options.domParserFactory,
  });
}
