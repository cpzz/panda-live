"use strict";
/**
 * AsciiDoc 示例扩展：为 .adoc / .asciidoc 提供格式提供者与导出命令。
 * 仅覆盖最小语法（标题 `= x`、空行、段落），用于演示扩展契约，见 doc/design.md §7.6。
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function classify(text) {
  if (/^=\s+/u.test(text)) return "heading";
  if (text.trim() === "") return "blank";
  return "paragraph";
}

function parse(source) {
  const blocks = String(source).split("\n").map((text) => ({ type: classify(text), text }));
  return { kind: "asciidoc", blocks };
}

function serialize(doc) {
  if (!doc || !Array.isArray(doc.blocks)) return "";
  return doc.blocks.map((block) => block.text).join("\n");
}

function renderPreview(doc) {
  if (!doc || !Array.isArray(doc.blocks)) return "";
  const parts = [];
  for (const block of doc.blocks) {
    if (block.type === "heading") {
      parts.push(`<h1>${escapeHtml(block.text.replace(/^=\s+/u, ""))}</h1>`);
    } else if (block.type === "paragraph") {
      parts.push(`<p>${escapeHtml(block.text)}</p>`);
    }
  }
  return parts.join("\n");
}

module.exports.activate = function activate(context) {
  context.api.formats.registerProvider({
    id: "asciidoc",
    extensions: [".adoc", ".asciidoc"],
    parse(source) {
      return parse(source);
    },
    serialize(doc) {
      return serialize(doc);
    },
    renderPreview(doc) {
      return renderPreview(doc);
    },
  });

  context.api.commands.register("asciidoc.exportHtml", () => {
    // 示例实现：真实导出可在此调用 context.api 提供的接口。
    return "AsciiDoc HTML 导出为示例实现";
  });
};
