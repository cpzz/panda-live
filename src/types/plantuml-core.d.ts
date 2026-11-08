/// <reference types="vite/client" />

declare module "@plantuml/core" {
  export interface PlantUmlRenderOptions {
    dark?: boolean;
    maxSvgSize?: number;
  }
  export function render(lines: string[], targetId: string, options?: PlantUmlRenderOptions): void;
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: PlantUmlRenderOptions,
  ): void;
}
