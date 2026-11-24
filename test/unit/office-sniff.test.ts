import { describe, expect, it } from "vitest";
import { base64ToBytes, sniffOfficeContainer } from "../../src/render/office/sniff";

describe("sniffOfficeContainer", () => {
  it("识别 zip 本地文件头（PK\\x03\\x04）", () => {
    expect(sniffOfficeContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe("zip");
  });

  it("识别空 zip 归档（PK\\x05\\x06）与分卷头（PK\\x07\\x08）", () => {
    expect(sniffOfficeContainer(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00]))).toBe("zip");
    expect(sniffOfficeContainer(new Uint8Array([0x50, 0x4b, 0x07, 0x08, 0x00, 0x00]))).toBe("zip");
  });

  it("识别 OLE2 复合文档魔数（.doc/.ppt/.xls/.xlsb）", () => {
    expect(sniffOfficeContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      "ole2",
    );
  });

  it("未知魔数返回 unknown", () => {
    expect(sniffOfficeContainer(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe("unknown");
    // PK 但第三字节不是归档类型
    expect(sniffOfficeContainer(new Uint8Array([0x50, 0x4b, 0x09, 0x00]))).toBe("unknown");
    // OLE2 前 4 字节对但后续不符
    expect(sniffOfficeContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x00]))).toBe(
      "unknown",
    );
  });

  it("过短字节数组返回 unknown", () => {
    expect(sniffOfficeContainer(new Uint8Array([0x50, 0x4b]))).toBe("unknown");
    expect(sniffOfficeContainer(new Uint8Array([]))).toBe("unknown");
  });
});

describe("base64ToBytes", () => {
  it("base64 转字节序列", () => {
    // "Hello"
    expect(Array.from(base64ToBytes("SGVsbG8="))).toEqual([72, 101, 108, 108, 111]);
  });

  it("空字符串返回空数组", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });
});
