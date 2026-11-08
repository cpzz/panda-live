import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 同目录临时文件 + rename 的原子写入；父目录不存在时自动创建。见 doc/design.md §12.2。 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${randomUUID().slice(0, 12)}`);
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
