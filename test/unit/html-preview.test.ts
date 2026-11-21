import { describe, expect, it } from "vitest";
import { CODE_FORMATS, PREVIEW_FORMATS, detectFormat } from "../../src/formats/registry";
import { formatHasPreview, getFormatEntry } from "../../src/extensions/registry";

describe("HTML 预览能力", () => {
  it("html 扩展名识别为 HTML 格式", () => {
    expect(detectFormat("page.html")).toBe("html");
    expect(detectFormat("page.htm")).toBe("html");
    expect(detectFormat("page.xhtml")).toBe("html");
  });

  it("HTML 进入预览白名单且不再是纯代码格式", () => {
    expect(PREVIEW_FORMATS.has("html")).toBe(true);
    expect(CODE_FORMATS.has("html")).toBe(false);
    expect(formatHasPreview("html")).toBe(true);
  });

  it("HTML 能力位：源码可编辑、内联预览、保留大纲、不支持 WYSIWYG", () => {
    const entry = getFormatEntry("html");
    expect(entry).not.toBeNull();
    expect(entry?.capabilities).toEqual({
      source: true,
      wysiwyg: false,
      preview: "inline",
      outline: true,
      exportHtml: false,
    });
  });

  it("未改变纯代码格式（如 css）的无预览能力", () => {
    const entry = getFormatEntry("css");
    expect(entry?.capabilities.preview).toBe("none");
    expect(formatHasPreview("css")).toBe(false);
  });
});
