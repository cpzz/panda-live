import { describe, expect, it } from "vitest";
import { decodeText, encodeText, sha256Hex } from "../../electron/services/text-codec";

describe("text-codec", () => {
  it("检测 CRLF 与 BOM，并把内容规范化为 LF", () => {
    const bytes = new TextEncoder().encode("\uFEFF# 标题\r\n\r\n正文\r\n");
    const decoded = decodeText(bytes);
    expect(decoded.encoding).toBe("utf-8-bom");
    expect(decoded.bom).toBe(true);
    expect(decoded.eol).toBe("crlf");
    expect(decoded.content).toBe("# 标题\n\n正文\n");
    expect(decoded.readOnly).toBe(false);
  });

  it("按记录的换行与 BOM 写回", () => {
    const bytes = encodeText("a\nb\n", "crlf", true);
    expect(bytes[0]).toBe(0xef);
    expect(new TextDecoder().decode(bytes.subarray(3))).toBe("a\r\nb\r\n");
  });

  it("UTF-16 文件只读解码", () => {
    const decoded = decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
    expect(decoded.encoding).toBe("utf-16le");
    expect(decoded.readOnly).toBe(true);
    expect(decoded.content).toBe("A");
  });

  it("sha256 对同一内容稳定", () => {
    const bytes = new TextEncoder().encode("panda");
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
    expect(sha256Hex(bytes)).toHaveLength(64);
  });
});
