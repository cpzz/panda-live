import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zoomToFitWidth } from "../../src/app/DiagramViewerDialog";

const dom = new JSDOM("");
const originalGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
  globalThis.getComputedStyle = originalGetComputedStyle;
  vi.restoreAllMocks();
});

function stubPadding(padding: number): void {
  globalThis.getComputedStyle = (() => ({
    paddingLeft: `${padding}px`,
    paddingRight: `${padding}px`,
  })) as unknown as typeof getComputedStyle;
}

function viewport(clientWidth: number): HTMLElement {
  const element = dom.window.document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: clientWidth });
  return element as unknown as HTMLElement;
}

describe("页宽显示缩放计算", () => {
  it("按视口可用宽度计算，扣减左右内边距", () => {
    stubPadding(20);
    // 1000 - 20 - 20 = 960，基准宽 800 → 120%。
    expect(zoomToFitWidth(viewport(1000), 800, 30, 1000)).toBe(120);
  });

  it("小图允许放大铺满，大图缩小，均夹取到给定范围", () => {
    stubPadding(20);
    expect(zoomToFitWidth(viewport(1000), 200, 30, 1000)).toBe(480);
    expect(zoomToFitWidth(viewport(1000), 4000, 30, 1000)).toBe(30);
    expect(zoomToFitWidth(viewport(1000), 200, 30, 300)).toBe(300);
  });

  it("无法测量或基准宽度无效时返回 null", () => {
    stubPadding(0);
    expect(zoomToFitWidth(null, 800, 30, 1000)).toBeNull();
    expect(zoomToFitWidth(viewport(1000), 0, 30, 1000)).toBeNull();
  });
});
