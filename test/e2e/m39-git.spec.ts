import { _electron as electron, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const CWD = path.resolve(".");
const exec = promisify(execFile);

/** 在指定目录执行 git，忽略用户全局的签名与换行配置，保证测试可重复。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

/** 初始化一个可供应用操作的仓库，并把默认分支固定为 main。 */
async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init"]);
  await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(dir, ["config", "user.name", "Panda Test"]);
  await git(dir, ["config", "user.email", "panda@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
}

async function openFolder(page: import("@playwright/test").Page, app: import("@playwright/test").ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
  await page.getByRole("button", { name: "打开文件夹", exact: true }).click();
}

/** M39：源代码管理面板的变更、暂存、提交、分支与历史。 */
test("M39：源代码管理变更、提交与分支", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-git-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-git-ud-"));
  const note = path.join(repo, "note.md");
  await initRepo(repo);
  await fs.writeFile(note, "# 初始\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  // 预先制造一个未暂存的修改，打开工作区即可看到。
  await fs.writeFile(note, "# 初始\n\n修改后的正文。\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "源代码管理" }).click();

    const branchButton = page.locator(".git-branch-button");
    await expect(branchButton).toContainText("main", { timeout: 20_000 });
    const changeRow = page.locator(".git-change-row").filter({ hasText: "note.md" });
    await expect(changeRow).toHaveCount(1);
    await expect(changeRow.locator(".git-change-status")).toHaveText("M");

    // 点击变更项打开文档并进入 Git 差异视图。
    await changeRow.locator(".git-change-path").click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });

    // 单文件暂存 → 提交框可提交。
    await changeRow.getByRole("button", { name: "暂存", exact: true }).click();
    await expect(page.locator(".git-change-group").filter({ hasText: "已暂存" })).toHaveCount(1);
    const messageBox = page.getByRole("textbox", { name: "提交信息", exact: true });
    await messageBox.fill("更新说明");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });

    // 历史列表与提交详情。
    await page.getByRole("tab", { name: "历史", exact: true }).click();
    const firstCommit = page.locator(".git-commit-row").first();
    await expect(firstCommit).toContainText("更新说明");
    await firstCommit.click();
    await expect(page.locator(".git-commit-detail h3")).toHaveText("更新说明");
    await expect(page.locator(".git-commit-detail")).toContainText("note.md");

    // 创建并切换分支。
    await page.getByRole("tab", { name: "更改", exact: true }).click();
    await branchButton.click();
    await page.locator(".git-branch-input").fill("feature");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(branchButton).toContainText("feature", { timeout: 20_000 });

    await branchButton.click();
    await page.locator(".git-branch-item").filter({ hasText: "main" }).click();
    await expect(branchButton).toContainText("main", { timeout: 20_000 });
    expect(await git(repo, ["branch", "--show-current"])).toBe("main");
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：fetch / pull / push 走本地裸仓库，验证与远程同步。 */
test("M39：fetch、pull 与 push", async () => {
  test.setTimeout(180_000);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "panda-sync-"));
  const repo = path.join(base, "repo");
  const peer = path.join(base, "peer");
  const bare = path.join(base, "remote.git");
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-sync-ud-"));
  const note = path.join(repo, "note.md");

  await fs.mkdir(bare);
  await git(bare, ["init", "--bare"]);
  // 裸仓库默认 HEAD 不一定是 main，先固定，同伴克隆才会检出正确分支。
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await initRepo(repo);
  await fs.writeFile(note, "第一版\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  await git(repo, ["remote", "add", "origin", bare]);
  await git(repo, ["push", "-u", "origin", "main"]);

  // 另一个克隆向远程追加提交，供应用拉取。
  await fs.mkdir(peer);
  await git(peer, ["clone", bare, "."]);
  await git(peer, ["config", "user.name", "Panda Peer"]);
  await git(peer, ["config", "user.email", "peer@example.com"]);
  await fs.writeFile(path.join(peer, "note.md"), "第一版\n\n同伴追加。\n", "utf8");
  await git(peer, ["add", "."]);
  await git(peer, ["commit", "-m", "同伴提交"]);
  await git(peer, ["push"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "源代码管理" }).click();
    await expect(page.locator(".git-branch-button")).toContainText("main", { timeout: 20_000 });

    // fetch 后显示落后 1 个提交。
    await page.getByRole("button", { name: "获取", exact: true }).click();
    await expect(page.locator(".git-behind")).toHaveText("↓1", { timeout: 30_000 });

    // pull 快进到远程提交，磁盘内容同步更新。
    await page.getByRole("button", { name: "拉取", exact: true }).click();
    await expect(page.locator(".git-behind")).toHaveCount(0, { timeout: 30_000 });
    expect(await fs.readFile(note, "utf8")).toContain("同伴追加。");

    // 外部修改后刷新，提交并推送。
    await fs.writeFile(note, "第二版\n", "utf8");
    await page.getByRole("tab", { name: "历史", exact: true }).click();
    await page.getByTitle("刷新历史").click();
    await page.getByRole("tab", { name: "更改", exact: true }).click();
    const changeRow = page.locator(".git-change-row").filter({ hasText: "note.md" });
    await expect(changeRow).toHaveCount(1, { timeout: 20_000 });
    await changeRow.getByRole("button", { name: "暂存", exact: true }).click();
    await page.getByRole("textbox", { name: "提交信息", exact: true }).fill("应用提交");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.locator(".git-ahead")).toHaveText("↑1", { timeout: 20_000 });

    await page.getByRole("button", { name: "推送", exact: true }).click();
    await expect(page.locator(".git-ahead")).toHaveCount(0, { timeout: 30_000 });
    expect(await git(bare, ["log", "-1", "--pretty=%s"])).toBe("应用提交");
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：非 Git 仓库时给出明确空状态。 */
test("M39：非仓库降级提示", async () => {
  test.setTimeout(120_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-nogit-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-nogit-ud-"));
  await fs.writeFile(path.join(dir, "note.md"), "# 普通目录\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, dir);
    await page.getByRole("tab", { name: "源代码管理" }).click();
    await expect(page.locator(".git-empty")).toContainText("当前工作区不是 Git 仓库", {
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "重新检测", exact: true })).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
