import type { StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

interface IniState {
  /** 已读到 `=`/`:`，接下来是值。 */
  inValue: boolean;
}

/** 行内注释：`;` 且位于空白之后；`#` 只在行首作为注释，避免把十六进制颜色当成注释。 */
function inlineCommentIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ";") continue;
    if (index === 0 || /\s/.test(text[index - 1] ?? "")) return index;
  }
  return -1;
}

function valueToken(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(["']).*\1$/.test(value)) return "string";
  if (/^(true|false|yes|no|on|off)$/i.test(value)) return "bool";
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return "number";
  if (/^[+-]?(0x[0-9a-f]+|\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(value)) return "number";
  return "string";
}

/**
 * INI/Properties 高亮：区分 section、键、值类型（字符串/数值/布尔）与注释。
 * 比 legacy `properties` 模式多出类型与 section 的配色。
 */
export const iniStreamParser: StreamParser<IniState> = {
  startState: () => ({ inValue: false }),

  token(stream, state) {
    if (stream.sol()) state.inValue = false;
    if (stream.eatSpace()) return null;

    const char = stream.peek() ?? "";

    if (!state.inValue) {
      if (char === ";" || char === "#") {
        stream.skipToEnd();
        return "comment";
      }
      if (char === "[") {
        stream.next();
        while (!stream.eol() && stream.peek() !== "]") stream.next();
        if (stream.peek() === "]") stream.next();
        return "section";
      }
      while (!stream.eol() && stream.peek() !== "=" && stream.peek() !== ":") stream.next();
      if (stream.eol()) return "key";
      state.inValue = true;
      return "key";
    }

    if (char === "=" || char === ":") {
      stream.next();
      return "operator";
    }

    const rest = stream.string.slice(stream.pos);
    const comment = inlineCommentIndex(rest);
    if (comment === 0) {
      stream.skipToEnd();
      return "comment";
    }
    const raw = comment > 0 ? rest.slice(0, comment) : rest;
    stream.pos += raw.length;
    return valueToken(raw);
  },

  languageData: {
    commentTokens: { line: ";" },
  },

  tokenTable: {
    // 用带 definition 修饰的 tagName 与普通标签区分，节名单独配色。
    section: tags.definition(tags.tagName),
    key: tags.propertyName,
    operator: tags.operator,
    string: tags.string,
    number: tags.number,
    bool: tags.bool,
    comment: tags.comment,
  },
};
