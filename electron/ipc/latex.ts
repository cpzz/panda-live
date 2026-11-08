import { detectEngines } from "../tex/engine";
import type { TexCompiler } from "../tex/compiler";
import { handle } from "./router";

export interface LatexHandlerOptions {
  compiler: TexCompiler;
}

/** TeX 引擎探测与编译通道。见 doc/design.md §9.5、§13.1。 */
export function registerLatexHandlers({ compiler }: LatexHandlerOptions): void {
  handle("latex:detect", () => {
    const engines = detectEngines();
    return { available: engines.length > 0, engines };
  });

  handle("latex:compile", (request) => compiler.compile(request));
}
