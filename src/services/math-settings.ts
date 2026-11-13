import { parseKatexMacros } from "../render/math/katex";
import { settingsStore } from "./settings-store";

/**
 * 数学渲染设置快照：预览管线与公式 NodeView 从这里读取，
 * 统一走设置仓库（默认值兜底），避免各模块各自订阅。见 doc/design.md §15.3。
 */

/** 当前 KaTeX 宏表（设置 `math.macros`，每行一条 `\命令 = 定义`）。 */
export function katexMacros(): Record<string, string> {
  return parseKatexMacros(settingsStore.getState().math.macros);
}

/** 是否解析 `$…$` 单美元内联公式。 */
export function singleDollarEnabled(): boolean {
  return settingsStore.getState().math.singleDollar;
}

/** 数学设置签名；预览/解析管线据此重建 unified 处理器。 */
export function mathOptionsSignature(): string {
  const { macros, singleDollar } = settingsStore.getState().math;
  return `${singleDollar ? "1" : "0"}\u0000${macros}`;
}
