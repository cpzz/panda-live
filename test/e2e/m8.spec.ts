import { _electron as electron, expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = path.resolve(".");

test("M8：panda-pdf 协议按缓存键返回编译产物", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-m8-pdf-"));
  const key = "a1b2c3d4e5f6".repeat(5) + "0123";
  const pdfDir = path.join(userDataDir, "cache", "pdf");
  await fs.mkdir(pdfDir, { recursive: true });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
  await fs.writeFile(path.join(pdfDir, `${key}.pdf`), pdf);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  const page = await app.firstWindow();
  try {
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      };
    }, `panda-pdf://${key}`);

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/pdf");
    expect(result.body).toContain("%PDF-1.4");

    const invalid = await page.evaluate(async () => {
      const response = await fetch("panda-pdf://not-a-key");
      return response.status;
    });
    expect(invalid).toBe(400);
  } finally {
    await app.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
