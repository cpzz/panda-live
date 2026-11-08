import { createHash } from "node:crypto";
import type { Eol, TextEncoding } from "../../src/shared/ipc";

export interface DecodedText {
  /** 已去除 BOM、换行统一为 LF 的文本内容。 */
  content: string;
  eol: Eol;
  bom: boolean;
  encoding: TextEncoding;
  readOnly: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

export function detectEol(content: string): Eol {
  const index = content.indexOf("\n");
  return index > 0 && content[index - 1] === "\r" ? "crlf" : "lf";
}

export function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function decodeText(bytes: Uint8Array): DecodedText {
  let encoding: TextEncoding;
  let content: string;
  let readOnly = false;

  if (hasUtf8Bom(bytes)) {
    encoding = "utf-8-bom";
    content = new TextDecoder("utf-8").decode(bytes.subarray(3));
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    readOnly = true;
    content = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    readOnly = true;
    content = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  } else {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf-8";
    } catch {
      encoding = "unknown";
      readOnly = true;
      content = new TextDecoder("utf-8").decode(bytes);
    }
  }

  const eol = detectEol(content);
  content = normalizeEol(content);
  return { content, eol, bom: encoding === "utf-8-bom", encoding, readOnly };
}

export function encodeText(content: string, eol: Eol, bom: boolean): Uint8Array {
  const normalized = normalizeEol(content);
  const withEol = eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const text = bom ? `\uFEFF${withEol}` : withEol;
  return new TextEncoder().encode(text);
}
