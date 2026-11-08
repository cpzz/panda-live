import { describe, expect, it } from "vitest";
import {
  buildSearchRegex,
  findIndexFrom,
  findMatches,
  replaceAllInText,
  type SearchOptions,
} from "../../src/services/search";

const BASE: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };

describe("查找匹配", () => {
  it("字面量匹配默认不区分大小写", () => {
    const matches = findMatches("Foo foo FOO", "foo", BASE);
    expect(matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("区分大小写只匹配同形", () => {
    expect(findMatches("Foo foo", "foo", { ...BASE, caseSensitive: true })).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it("正则模式支持分组", () => {
    const matches = findMatches("id=42, id=7", "id=\\d+", { ...BASE, regex: true });
    expect(matches).toEqual([
      { start: 0, end: 5 },
      { start: 7, end: 11 },
    ]);
  });

  it("全词模式不跨越中文或下划线", () => {
    const options: SearchOptions = { ...BASE, wholeWord: true };
    expect(findMatches("cat concat cat_ cat", "cat", options)).toEqual([
      { start: 0, end: 3 },
      { start: 16, end: 19 },
    ]);
  });

  it("非法正则返回 null 与空匹配", () => {
    expect(buildSearchRegex("([", { ...BASE, regex: true })).toBeNull();
    expect(findMatches("text", "([", { ...BASE, regex: true })).toEqual([]);
  });

  it("循环查找：向后到末尾回到首个", () => {
    const matches = [
      { start: 0, end: 3 },
      { start: 10, end: 13 },
    ];
    expect(findIndexFrom(matches, 11, 1)).toBe(0);
    expect(findIndexFrom(matches, 11, 1, false)).toBe(-1);
  });

  it("循环查找：向前到开头回到末个", () => {
    const matches = [
      { start: 0, end: 3 },
      { start: 10, end: 13 },
    ];
    expect(findIndexFrom(matches, 1, -1)).toBe(1);
    expect(findIndexFrom(matches, 1, -1, false)).toBe(-1);
  });
});

describe("替换", () => {
  it("字面量替换不解释捕获组语法", () => {
    const result = replaceAllInText("a.b a.b", "a.b", BASE, "$1");
    expect(result.count).toBe(2);
    expect(result.text).toBe("$1 $1");
  });

  it("正则替换保留捕获组引用", () => {
    const result = replaceAllInText("id=42 id=7", "id=(\\d+)", { ...BASE, regex: true }, "no=$1");
    expect(result.count).toBe(2);
    expect(result.text).toBe("no=42 no=7");
  });
});
