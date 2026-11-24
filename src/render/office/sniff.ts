/** Office 文件物理容器判定：分流 OOXML（zip）与旧版二进制（OLE2 复合文档）。
 * docx/pptx 族（含 m/t 变体）均为 zip；.doc/.ppt 为 OLE2。
 * Excel 族交给 SheetJS 自行识别（OLE2/BIFF/zip 均可读），无需容器判定。 */
export type OfficeContainer = "zip" | "ole2" | "unknown";

/** OLE2 复合文档魔数（CFB）。 */
const OLE2_MAGIC: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function sniffOfficeContainer(bytes: Uint8Array): OfficeContainer {
  if (bytes.length >= 4) {
    const [b0, b1, b2] = [bytes[0], bytes[1], bytes[2]];
    // zip：PK\x03\x04（本地文件头）/ PK\x05\x06（空归档）/ PK\x07\x08（分卷）
    if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) return "zip";
  }
  if (bytes.length >= OLE2_MAGIC.length) {
    const isOle2 = OLE2_MAGIC.every((value, index) => bytes[index] === value);
    if (isOle2) return "ole2";
  }
  return "unknown";
}

/** base64 字符串 → Uint8Array（IPC readBase64 返回的数据转二进制）。 */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
