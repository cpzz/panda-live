import { describe, expect, it } from "vitest";
import { ratioMargin, ratioScrollTop } from "../../src/shared/scroll";

describe("视口比例滚动", () => {
  it("默认把元素放到容器 1/3 高度处", () => {
    // 容器高 900，元素当前距视口顶 600；滚 300 后它落在 600-300=300（即 1/3）处
    expect(ratioScrollTop(0, 600, 900)).toBe(300);
    // 已有滚动量 400、元素距顶 600 → 目标 400+600-300=700
    expect(ratioScrollTop(400, 600, 900)).toBe(700);
    // 元素正好在 1/3 处（距顶 300）时无需移动
    expect(ratioScrollTop(0, 300, 900)).toBe(0);
  });

  it("目标位置为负时钳到顶部", () => {
    expect(ratioScrollTop(0, 100, 900)).toBe(0);
    expect(ratioScrollTop(400, -50, 900)).toBe(50);
  });

  it("支持自定义比例", () => {
    // 元素距顶 600：1/2 处需滚 600-450=150；1/4 处需滚 600-225=375
    expect(ratioScrollTop(0, 600, 900, 1 / 2)).toBe(150);
    expect(ratioScrollTop(0, 600, 900, 1 / 4)).toBe(375);
  });
});

describe("CodeMirror 跳转 margin", () => {
  it("把 y:start 的 margin 设为视口高度的 1/3", () => {
    expect(ratioMargin(900)).toBe(300);
    expect(ratioMargin(900, 1 / 2)).toBe(450);
    expect(ratioMargin(900, 1 / 4)).toBe(225);
  });

  it("margin 始终小于编辑器高度（CodeMirror 约束），且不为负", () => {
    expect(ratioMargin(30)).toBe(10);
    expect(ratioMargin(1)).toBe(0); // 1 * 1/3 < 1，钳到 height-1=0
    expect(ratioMargin(0)).toBe(0); // 视口未布局时退回贴顶
  });
});
