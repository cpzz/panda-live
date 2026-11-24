import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { singleDollarEnabled } from "../services/math-settings";

/** 符号的粗分类，用于挑选图标。 */
export type OutlineKind =
  | "heading"
  | "type"
  | "function"
  | "key"
  | "tag"
  | "rule"
  | "object"
  | "diagram"
  | "other";

/** 具体语法类型；中文原文即 i18n 的 key，分组标题按此显示。 */
export type OutlineSymbol =
  | "标题"
  | "类"
  | "结构体"
  | "接口"
  | "枚举"
  | "命名空间"
  | "模块"
  | "包"
  | "特质"
  | "实现"
  | "类型别名"
  | "记录"
  | "混入"
  | "协议"
  | "扩展"
  | "注解"
  | "单例对象"
  | "函数"
  | "方法"
  | "构造函数"
  | "子程序"
  | "键"
  | "节"
  | "标签"
  | "选择器"
  | "@ 规则"
  | "表"
  | "视图"
  | "索引"
  | "存储过程"
  | "触发器"
  | "数据库"
  | "序列"
  | "图"
  | "子图"
  | "参与者"
  | "图标题";

export interface OutlineItem {
  /** 文档内标题序号（从 0 开始），用于在 WYSIWYG 与预览中按顺序定位。 */
  index: number;
  /** 层级，1 为最高层；面板按相对层级缩进。 */
  level: number;
  text: string;
  /** 源码行号，从 1 开始。 */
  line: number;
  /** 粗分类，决定图标。 */
  kind: OutlineKind;
  /** 具体语法类型，决定分组标题。 */
  symbol: OutlineSymbol;
}

interface MdastNode {
  type: string;
  value?: string | null;
  depth?: number | null;
  children?: MdastNode[];
  position?: { start?: { line?: number } | null } | null;
}

function buildMarkdownParser() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkMath, { singleDollarTextMath: singleDollarEnabled() });
}

/** 大纲解析器按「单美元开关」缓存，与 parse.ts 保持一致。 */
let cachedParser: ReturnType<typeof buildMarkdownParser> | null = null;
let cachedSingleDollar: boolean | null = null;

function getMarkdownParser(): ReturnType<typeof buildMarkdownParser> {
  const singleDollar = singleDollarEnabled();
  if (!cachedParser || cachedSingleDollar !== singleDollar) {
    cachedParser = buildMarkdownParser();
    cachedSingleDollar = singleDollar;
  }
  return cachedParser;
}

/** 提取节点的纯文本，用于大纲标题。 */
function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function markdownOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const walk = (node: MdastNode): void => {
    if (node.type === "heading") {
      items.push({
        index: items.length,
        level: Math.min(6, Math.max(1, Number(node.depth) || 1)),
        text: nodeText(node).trim(),
        line: node.position?.start?.line ?? 1,
        kind: "heading",
        symbol: "标题",
      });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(getMarkdownParser().parse(source) as unknown as MdastNode);
  return items;
}

const LATEX_HEADING =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\]\s*)?\{/u;
const LATEX_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
};

/** 从 `{` 起截取平衡花括号内的内容。 */
function braceContent(line: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < line.length; index += 1) {
    const char = line[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return line.slice(openIndex + 1, index);
    }
  }
  return line.slice(openIndex + 1);
}

function cleanLatexTitle(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/gu, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function latexOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = source.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    const match = LATEX_HEADING.exec(line);
    if (!match) continue;
    const command = match[1] ?? "section";
    const openIndex = match.index + match[0].length - 1;
    items.push({
      index: items.length,
      level: LATEX_LEVELS[command] ?? 3,
      text: cleanLatexTitle(braceContent(line, openIndex)),
      line: lineIndex + 1,
      kind: "heading",
      symbol: "标题",
    });
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/*                              通用行规则引擎                                */
/* -------------------------------------------------------------------------- */

type LevelResolver = number | ((match: RegExpMatchArray, indent: number) => number);
type SymbolResolver = OutlineSymbol | ((match: RegExpMatchArray, indent: number) => OutlineSymbol);

interface LineRule {
  pattern: RegExp;
  level: LevelResolver;
  /** 具体语法类型，或按匹配内容与缩进决定。 */
  symbol: SymbolResolver;
  /** 自定义标题文本；默认取第一个捕获组，其次取整行。 */
  name?: (match: RegExpMatchArray) => string;
}

interface CodeSpec {
  rules: LineRule[];
  lineComment?: string[];
  blockComment?: readonly [string, string];
}

/** 控制流语句即使长得像函数调用也不进入大纲。 */
const CONTROL_KEYWORDS =
  /^(?:if|else|for|while|switch|case|catch|try|finally|do|return|throw|yield|break|continue|await|print|println|echo|assert|sizeof|new|delete|when|then|elif|fi|esac|end)\b/;

const indentOf = (raw: string): number => raw.length - raw.trimStart().length;

/** 语法关键字 → 分组名；未列出的回退到「类」。 */
function symbolByKeyword(keyword: string | undefined, fallback: OutlineSymbol): OutlineSymbol {
  const map: Record<string, OutlineSymbol> = {
    class: "类",
    struct: "结构体",
    union: "结构体",
    interface: "接口",
    enum: "枚举",
    "enum class": "枚举",
    namespace: "命名空间",
    module: "模块",
    package: "包",
    trait: "特质",
    impl: "实现",
    implementation: "实现",
    type: "类型别名",
    typedef: "类型别名",
    typealias: "类型别名",
    record: "记录",
    mixin: "混入",
    protocol: "协议",
    extension: "扩展",
    annotation: "注解",
    "@interface": "注解",
    object: "单例对象",
    "@implementation": "实现",
    "@protocol": "协议",
  };
  return (keyword && map[keyword]) || fallback;
}

/** 逐行正则提取：跳过注释，按规则优先级匹配声明行，行号取循环下标 + 1。 */
function codeOutline(source: string, spec: CodeSpec): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inBlock = false;
  const lines = source.split(/\r?\n/);
  for (const [lineIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (spec.blockComment) {
      const [open, close] = spec.blockComment;
      if (inBlock) {
        if (line.includes(close)) inBlock = false;
        continue;
      }
      if (line.startsWith(open)) {
        if (!line.includes(close)) inBlock = true;
        continue;
      }
    }
    if (spec.lineComment?.some((prefix) => line.startsWith(prefix))) continue;
    if (CONTROL_KEYWORDS.test(line)) continue;
    for (const rule of spec.rules) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      const indent = indentOf(raw.replace(/\t/g, "    "));
      const level = typeof rule.level === "function" ? rule.level(match, indent) : rule.level;
      const symbol =
        typeof rule.symbol === "function" ? rule.symbol(match, indent) : rule.symbol;
      const text = (rule.name ? rule.name(match) : (match[1] ?? match[0])).trim();
      if (text) {
        items.push({
          index: items.length,
          level,
          text,
          line: lineIndex + 1,
          kind: kindForSymbol(symbol),
          symbol,
        });
      }
      break;
    }
  }
  return items;
}

/** 由具体语法类型推断图标用的粗分类。 */
function kindForSymbol(symbol: OutlineSymbol): OutlineKind {
  if (symbol === "标题" || symbol === "图标题") return "heading";
  if (
    symbol === "类" ||
    symbol === "结构体" ||
    symbol === "接口" ||
    symbol === "枚举" ||
    symbol === "命名空间" ||
    symbol === "模块" ||
    symbol === "包" ||
    symbol === "特质" ||
    symbol === "实现" ||
    symbol === "类型别名" ||
    symbol === "记录" ||
    symbol === "混入" ||
    symbol === "协议" ||
    symbol === "扩展" ||
    symbol === "注解" ||
    symbol === "单例对象"
  ) {
    return "type";
  }
  if (
    symbol === "函数" ||
    symbol === "方法" ||
    symbol === "构造函数" ||
    symbol === "子程序"
  ) {
    return "function";
  }
  if (symbol === "键" || symbol === "节") return "key";
  if (symbol === "标签") return "tag";
  if (symbol === "选择器" || symbol === "@ 规则") return "rule";
  if (
    symbol === "表" ||
    symbol === "视图" ||
    symbol === "索引" ||
    symbol === "存储过程" ||
    symbol === "触发器" ||
    symbol === "数据库" ||
    symbol === "序列"
  ) {
    return "object";
  }
  if (symbol === "图" || symbol === "子图" || symbol === "参与者") return "diagram";
  return "other";
}

/* --------------------------- 类 C 语言通用规则 --------------------------- */

/**
 * 类 C 语言的方法/函数声明；支持以下常见写法：
 * - 普通声明 `void f();`、空体 `void f() {}`、单行带内容体 `void f() { return; }`
 * - 函数体在下一行 `int main() {`（`}` 可缺省，逐行匹配）
 * - C++ 限定符 `const` / `noexcept(...)` / `override` / `final`
 * - C++ 构造函数初始化列表 `: name_(std::move(name))`
 * - `= default` / `= delete` / `= 0`（纯虚）
 * - Java `throws`、注解 `@Override`；C# 表达式体 `=> expr;`
 * 控制流关键字与注释/字符串仍由 codeOutline 统一过滤。
 */
const C_METHOD =
  /^(?:[\w:<>,*&@[\]\s]+?\s+)?([~A-Za-z_]\w*)\s*\([^;{}]*\)(?:\s*const)?(?:\s*noexcept(?:\([^)]*\))?)?(?:\s*override)?(?:\s*final)?(?:\s*throws\s+[\w.,<>[\]]+)?(?:\s*:\s*[^;{}]+)?(?:\s*=>\s*[^;{}]+)?(?:\s*\{[^}]*\}?)?(?:\s*=\s*(?:default|delete|0))?\s*;?\s*$/;
const JAVA_TYPE =
  /^(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp|default)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/;
const CSHARP_TYPE =
  /^(?:(?:public|private|protected|internal|abstract|sealed|static|partial|readonly|unsafe|ref)\s+)*(class|struct|interface|enum|record)\s+(\w+)/;

/** 按缩进决定「函数」还是「方法」。 */
const functionOrMethod: SymbolResolver = (_match, indent) => (indent > 0 ? "方法" : "函数");

const CODE_SPECS: Record<string, CodeSpec> = {
  cpp: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      { pattern: /^(?:template\s*<[^>]*>\s*)?namespace\s+([\w:]+)/, level: 1, symbol: "命名空间" },
      {
        pattern: /^(?:class|struct|union)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[0].trim().split(/\s+/)[0], "类"),
      },
      { pattern: /^enum(?:\s+class)?\s+(\w+)/, level: 1, symbol: "枚举" },
      { pattern: /^using\s+(\w+)\s*=/, level: 1, symbol: "类型别名" },
      { pattern: C_METHOD, level: 2, symbol: functionOrMethod },
    ],
  },
  java: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      { pattern: JAVA_TYPE, level: 1, symbol: (m) => symbolByKeyword(m[1], "类"), name: (m) => m[2] ?? "" },
      { pattern: C_METHOD, level: 2, symbol: functionOrMethod },
    ],
  },
  csharp: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      { pattern: /^namespace\s+([\w.]+)/, level: 1, symbol: "命名空间" },
      { pattern: CSHARP_TYPE, level: 1, symbol: (m) => symbolByKeyword(m[1], "类"), name: (m) => m[2] ?? "" },
      { pattern: C_METHOD, level: 2, symbol: functionOrMethod },
    ],
  },
  javascript: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
        level: 1,
        symbol: "类",
      },
      {
        pattern: /^(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类型别名"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
        level: 2,
        symbol: "函数",
      },
      {
        pattern: /^(?:export\s+)?(?:(?:const|let|var)\s+)?([\w$]+)\s*(?::\s*[\w<>[\]|&,\s]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[\w<>[\]|&,\s]+)?\s*=>/,
        level: 2,
        symbol: "函数",
      },
      {
        pattern:
          /^(?:(?:public|private|protected|static|readonly|async|get|set|declare|override|abstract)\s+|\*\s*)*([\w$]+)\s*\??\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&,\s]+)?\s*\{/,
        level: (_m, indent) => (indent > 0 ? 2 : 1),
        symbol: (_m, indent) => (indent > 0 ? "方法" : "函数"),
      },
    ],
  },
  go: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern: /^type\s+(\w+)\s+(struct|interface)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[2], "类"),
      },
      { pattern: /^func\s+\(\s*\w+\s+\*?\w+\s*\)\s*(\w+)\s*\(/, level: 2, symbol: "方法" },
      { pattern: /^func\s+(\w+)\s*\(/, level: 1, symbol: "函数" },
      { pattern: /^type\s+(\w+)\s+\S/, level: 1, symbol: "类型别名" },
    ],
  },
  rust: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      { pattern: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, level: 1, symbol: "模块" },
      {
        pattern: /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union|type)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      { pattern: /^impl(?:<[^>]*>)?\s+(?:[\w:]+\s+for\s+)?([\w:]+)/, level: 1, symbol: "实现" },
      {
        pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)/,
        level: (_m, indent) => (indent > 0 ? 2 : 1),
        symbol: functionOrMethod,
      },
    ],
  },
  php: {
    lineComment: ["//", "#"],
    blockComment: ["/*", "*/"],
    rules: [
      { pattern: /^namespace\s+([\w\\]+)/, level: 1, symbol: "命名空间" },
      {
        pattern: /^(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern:
          /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s*&?\s*(\w+)\s*\(/,
        level: 2,
        symbol: functionOrMethod,
      },
    ],
  },
  ruby: {
    lineComment: ["#"],
    rules: [
      {
        pattern: /^(class|module)\s+([\w:]+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      { pattern: /^def\s+(?:self\.)?([\w.?!]+)/, level: 2, symbol: functionOrMethod },
    ],
  },
  kotlin: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern:
          /^(?:(?:data|sealed|abstract|open|inner|value)\s+)*(class|interface|object|enum\s+class|annotation\s+class)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern:
          /^(?:(?:override|private|protected|internal|public|open|abstract|suspend|inline|operator|infix|external|tailrec)\s+)*fun\s+(?:[\w<>,\s?]+\.)?(\w+)\s*\(/,
        level: 2,
        symbol: functionOrMethod,
      },
    ],
  },
  swift: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern:
          /^(?:(?:public|private|internal|open|final|abstract)\s+)*(class|struct|enum|protocol|extension|typealias)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern:
          /^(?:(?:public|private|internal|open|final|static|override|mutating|nonmutating)\s+)*func\s+(\w+)\s*\(/,
        level: 2,
        symbol: functionOrMethod,
      },
    ],
  },
  scala: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern: /^(?:(?:case|abstract|sealed|final|implicit)\s+)*(class|trait|object|enum)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern: /^(?:(?:override|private|protected|implicit|final|inline)\s+)*def\s+(\w+)\s*\(/,
        level: 2,
        symbol: functionOrMethod,
      },
    ],
  },
  dart: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern: /^(?:abstract\s+)?(class|mixin|enum|extension|typedef)\s+(\w+)/,
        level: 1,
        symbol: (m) => symbolByKeyword(m[1], "类"),
        name: (m) => m[2] ?? "",
      },
      {
        pattern: /^(?:static\s+)?(?:final\s+)?(?:[\w<>,\s?]+?\s+)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?(?:\{|=>)/,
        level: 2,
        symbol: "方法",
      },
    ],
  },
  lua: {
    lineComment: ["--"],
    blockComment: ["--[[", "]]"],
    rules: [
      { pattern: /^(?:local\s+)?function\s+([\w.:]+)\s*\(/, level: 1, symbol: "函数" },
      { pattern: /^(?:local\s+)?([\w]+)\s*=\s*function\s*\(/, level: 1, symbol: "函数" },
    ],
  },
  perl: {
    lineComment: ["#"],
    rules: [
      { pattern: /^package\s+([\w:]+)/, level: 1, symbol: "包" },
      { pattern: /^sub\s+(\w+)/, level: 1, symbol: "子程序" },
    ],
  },
  objectivec: {
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern: /^@(interface|implementation|protocol)\s+([\w]+)/,
        level: 1,
        // Objective-C 的 @interface 是类声明，不能复用 Java 的「@interface → 注解」映射。
        symbol: (m) =>
          m[1] === "interface" ? "类" : m[1] === "implementation" ? "实现" : "协议",
        name: (m) => m[2] ?? "",
      },
      { pattern: /^[+-]\s*\([^)]*\)\s*(\w+)/, level: 2, symbol: "方法" },
    ],
  },
  shell: {
    lineComment: ["#"],
    rules: [
      { pattern: /^function\s+([\w-]+)/, level: 1, symbol: "函数" },
      { pattern: /^([\w-]+)\s*\(\)\s*\{?/, level: 1, symbol: "函数" },
    ],
  },
  r: {
    lineComment: ["#"],
    rules: [
      { pattern: /^([\w.]+)\s*<-\s*function\s*\(/, level: 1, symbol: "函数" },
      { pattern: /^([\w.]+)\s*=\s*function\s*\(/, level: 1, symbol: "函数" },
    ],
  },
  sql: {
    lineComment: ["--"],
    blockComment: ["/*", "*/"],
    rules: [
      {
        pattern:
          /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|SCHEMA|DATABASE|SEQUENCE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/i,
        level: 1,
        symbol: (m) => sqlSymbol(m[0]),
      },
      { pattern: /^ALTER\s+TABLE\s+(?:ONLY\s+)?["`[]?([\w.]+)/i, level: 1, symbol: "表" },
      {
        pattern: /^DROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?["`[]?([\w.]+)/i,
        level: 1,
        symbol: (m) => (/^DROP\s+VIEW/i.test(m[0]) ? "视图" : "表"),
      },
    ],
  },
};

/** 从 SQL 声明行判定对象类型。 */
function sqlSymbol(line: string): OutlineSymbol {
  if (/\bTABLE\b/i.test(line)) return "表";
  if (/\bVIEW\b/i.test(line)) return "视图";
  if (/\bINDEX\b/i.test(line)) return "索引";
  if (/\bPROCEDURE\b/i.test(line)) return "存储过程";
  if (/\bTRIGGER\b/i.test(line)) return "触发器";
  if (/\b(?:SCHEMA|DATABASE)\b/i.test(line)) return "数据库";
  if (/\bSEQUENCE\b/i.test(line)) return "序列";
  if (/\bTYPE\b/i.test(line)) return "类型别名";
  return "函数";
}

/* --------------------------- 缩进栈类提取器 --------------------------- */

/** 用缩进栈把行首空白映射成层级，顶层和其兄弟节点同为 1。 */
function indentOutline(
  source: string,
  pattern: RegExp,
  skip: (line: string) => boolean,
  textIndex: number,
  nameIndex: number,
  symbolOf: (match: RegExpMatchArray) => OutlineSymbol,
): OutlineItem[] {
  const items: OutlineItem[] = [];
  const stack: number[] = [];
  let inDocstring = false;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (inDocstring) {
      if (line.includes('"""') || line.includes("'''")) inDocstring = false;
      continue;
    }
    if (/^("""|''')/.test(line)) {
      const quote = line.slice(0, 3);
      if (line.slice(3).indexOf(quote) < 0) inDocstring = true;
      continue;
    }
    if (skip(line)) continue;
    const match = pattern.exec(raw);
    if (!match) continue;
    const indent = indentOf(raw.replace(/\t/g, "    "));
    while (stack.length > 0 && indent < stack[stack.length - 1]!) stack.pop();
    if (stack.length === 0 || indent > stack[stack.length - 1]!) stack.push(indent);
    const text = (match[textIndex] ?? match[nameIndex] ?? "").trim();
    if (!text) continue;
    const symbol = symbolOf(match);
    items.push({
      index: items.length,
      level: Math.min(6, stack.length),
      text,
      line: lineIndex + 1,
      kind: kindForSymbol(symbol),
      symbol,
    });
  }
  return items;
}

function pythonOutline(source: string): OutlineItem[] {
  return indentOutline(
    source,
    /^(\s*)(?:async\s+)?(class|def)\s+([\w]+)/,
    (line) => line.startsWith("#"),
    3,
    2,
    (match) => (match[2] === "class" ? "类" : "函数"),
  );
}

function keyIndentOutline(source: string, format: "json" | "yaml"): OutlineItem[] {
  return indentOutline(
    source,
    format === "json" ? /^(\s*)"([^"]+)"\s*:/ : /^(\s*)(?:-\s+)?([\w.$/-]+)\s*:/,
    (line) =>
      format === "yaml"
        ? line.startsWith("#") || line === "---" || line === "..."
        : line.startsWith("//"),
    2,
    1,
    () => "键",
  );
}

/** TOML / INI：表头为「节」，键为「键」。 */
function sectionKeyOutline(source: string, format: "toml" | "ini"): OutlineItem[] {
  const items: OutlineItem[] = [];
  const section = format === "toml" ? /^\[\[?([^\]]+)\]\]?/ : /^\[([^\]]+)\]/;
  const key = /^([\w.$-]+)\s*=/;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const matched = section.exec(line);
    if (matched) {
      items.push({
        index: items.length,
        level: 1,
        text: matched[1]!.trim(),
        line: lineIndex + 1,
        kind: "key",
        symbol: "节",
      });
      continue;
    }
    const keyMatch = key.exec(line);
    if (keyMatch) {
      items.push({
        index: items.length,
        level: 2,
        text: keyMatch[1]!,
        line: lineIndex + 1,
        kind: "key",
        symbol: "键",
      });
    }
  }
  return items;
}

/* --------------------------- 标记语言提取器 --------------------------- */

/** CSS：@规则为一级，选择器按花括号嵌套深度定级。 */
function cssOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let depth = 0;
  let inBlock = false;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("//")) continue;
    const atRule = /^@(?:media|supports|keyframes|font-face|layer|container|scope)\b[^;{]*/.exec(line);
    if (atRule) {
      items.push({
        index: items.length,
        level: 1,
        text: atRule[0].trim(),
        line: lineIndex + 1,
        kind: "rule",
        symbol: "@ 规则",
      });
    } else {
      const selector = /^([^{};@][^{};]*?)\s*\{[^{}]*\}?\s*$/.exec(line);
      if (selector) {
        const text = selector[1]!.trim().replace(/\s+/g, " ");
        if (text) {
          items.push({
            index: items.length,
            level: Math.min(6, depth + 1),
            text,
            line: lineIndex + 1,
            kind: "rule",
            symbol: "选择器",
          });
        }
      }
    }
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return items;
}

const MARKUP_WORTH =
  /^(?:html|head|body|title|h[1-6]|section|article|header|footer|nav|main|aside|table|thead|tbody|tfoot|tr|form|fieldset|details|dialog|ul|ol|svg|g|symbol|defs|figure|div)$/i;
const MARKUP_SIMPLE =
  /^(?:h[1-6]|title|section|article|header|footer|nav|main|table|form|figure|svg|g|symbol)$/i;

/** XML / HTML / SVG：标签栈维护嵌套，只收录有结构意义的标签。 */
function markupOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const stack: string[] = [];
  const tagPattern = /<\/?([\w:-]+)([^>]*?)(\/?)>/g;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    if (/^\s*(?:<!--|\/\/)/.test(raw)) continue;
    tagPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(raw)) !== null) {
      const full = match[0];
      const tag = match[1]!.toLowerCase();
      const attrs = match[2] ?? "";
      const selfClosing = Boolean(match[3]) || /\/\s*>$/.test(full);
      if (full.startsWith("</")) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index] === tag) {
            stack.length = index;
            break;
          }
        }
        continue;
      }
      const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const className = /\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (MARKUP_WORTH.test(tag) && (MARKUP_SIMPLE.test(tag) || id || className)) {
        items.push({
          index: items.length,
          level: Math.min(6, stack.length + 1),
          text: id ?? className ?? tag,
          line: lineIndex + 1,
          kind: "tag",
          symbol: "标签",
        });
      }
      if (!selfClosing) stack.push(tag);
    }
  }
  return items;
}

/** Mermaid：图类型声明与 subgraph / title 作为大纲项。 */
function mermaidOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    const diagram = /^(?:flowchart|graph|sequenceDiagram|classDiagram|erDiagram|stateDiagram\w*|journey|gantt|pie|gitGraph|mindmap|timeline|requirementDiagram|C4Context)\b/.exec(
      line,
    );
    if (diagram) {
      items.push({
        index: items.length,
        level: 1,
        text: diagram[0],
        line: lineIndex + 1,
        kind: "diagram",
        symbol: "图",
      });
      continue;
    }
    const subgraph = /^subgraph\s+(?:\d+\s+)?(.+?)(?:\s*\[[^\]]*\])?\s*$/.exec(line);
    if (subgraph) {
      items.push({
        index: items.length,
        level: 2,
        text: subgraph[1]!.trim(),
        line: lineIndex + 1,
        kind: "diagram",
        symbol: "子图",
      });
      continue;
    }
    const title = /^title\s+(.+)$/.exec(line);
    if (title) {
      items.push({
        index: items.length,
        level: 1,
        text: title[1]!.trim(),
        line: lineIndex + 1,
        kind: "heading",
        symbol: "图标题",
      });
    }
  }
  return items;
}

/** PlantUML：@startuml 内的 title 与参与者/类/包声明。 */
function plantumlOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const declaration =
    /^(class|interface|enum|annotation|actor|participant|component|database|package|namespace|node|folder|frame|rectangle|usecase|boundary|control|entity)\s+([\w.\s]+)/;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("'") || line.startsWith("*") || line.startsWith("/")) continue;
    if (/^@(?:start|end)uml\b/.test(line)) continue;
    const title = /^(?:title|caption|header|footer)\s+(.+)$/.exec(line);
    if (title) {
      items.push({
        index: items.length,
        level: 1,
        text: title[1]!.trim().replace(/^["']|["']$/g, ""),
        line: lineIndex + 1,
        kind: "heading",
        symbol: "图标题",
      });
      continue;
    }
    const matched = declaration.exec(line);
    if (matched) {
      const symbol: OutlineSymbol =
        matched[1] === "actor" || matched[1] === "participant" ? "参与者" : symbolByKeyword(matched[1], "类");
      items.push({
        index: items.length,
        level: 1,
        text: matched[2]!.trim(),
        line: lineIndex + 1,
        kind: kindForSymbol(symbol),
        symbol,
      });
    }
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/*                                  对外接口                                  */
/* -------------------------------------------------------------------------- */

/** 所有内置支持大纲的格式；不含二进制与无结构格式（pdf / image / docx / xlsx / pptx / text / mathml）。 */
export const OUTLINE_FORMATS: ReadonlySet<string> = new Set<string>([
  "markdown",
  "latex",
  "python",
  "json",
  "yaml",
  "toml",
  "ini",
  "css",
  "xml",
  "html",
  "svg",
  "mermaid",
  "plantuml",
  ...Object.keys(CODE_SPECS),
]);

export function formatSupportsOutline(format: string): boolean {
  return OUTLINE_FORMATS.has(format);
}

/** 文档大纲：按格式分派提取器。见 doc/design.md §15.1。 */
export function buildOutline(source: string, format: string): OutlineItem[] {
  if (format === "markdown") return markdownOutline(source);
  if (format === "latex") return latexOutline(source);
  if (format === "python") return pythonOutline(source);
  if (format === "json" || format === "yaml") return keyIndentOutline(source, format);
  if (format === "toml" || format === "ini") return sectionKeyOutline(source, format);
  if (format === "css") return cssOutline(source);
  if (format === "xml" || format === "html" || format === "svg") return markupOutline(source);
  if (format === "mermaid") return mermaidOutline(source);
  if (format === "plantuml") return plantumlOutline(source);
  const spec = CODE_SPECS[format];
  return spec ? codeOutline(source, spec) : [];
}
