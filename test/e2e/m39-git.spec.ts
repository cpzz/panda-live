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
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const branchButton = page.locator(".git-branch-button");
    await expect(branchButton).toContainText("main", { timeout: 20_000 });
    const changeRow = page.locator(".git-change-row").filter({ hasText: "note.md" });
    await expect(changeRow).toHaveCount(1);
    await expect(changeRow.locator(".git-change-status")).toHaveText("M");

    // 点击变更项打开文档并进入 Git 差异视图。
    await changeRow.locator(".git-change-path").click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });

    // 改动计数可展开位置列表，点击条目直接跳转。
    const countButton = page.locator(".git-diff-count-button");
    await expect(countButton).toBeVisible();
    await countButton.click();
    const changeList = page.locator(".git-diff-list");
    await expect(changeList).toBeVisible();
    await expect(changeList.locator(".diff-list-item")).toHaveCount(1);
    await changeList.locator(".diff-list-item").first().click();
    await expect(changeList).toHaveCount(0);
    await countButton.click();
    await expect(changeList.locator(".diff-list-header")).toContainText("第 1 处 / 共 1 处");
    await page.keyboard.press("Escape");
    await expect(changeList).toHaveCount(0);

    // 右侧改动概览（Minimap）常显：色块 + 视口，点击色块直接定位。
    const minimap = page.locator(".git-minimap");
    const minimapMarkers = minimap.locator(".git-minimap-marker");
    await expect(minimap).toBeVisible();
    await expect(minimapMarkers).toHaveCount(1);

    // 对比视图（源码分栏）与预览对比视图都保留概览条。
    await page.getByRole("button", { name: "对比", exact: true }).click();
    await expect(minimap).toBeVisible();
    await expect(minimap.locator(".git-minimap-viewport")).toHaveCount(1);
    await minimapMarkers.first().click();
    await expect(minimap.locator(".git-minimap-marker.active")).toHaveCount(1);

    await page.getByRole("button", { name: "预览对比", exact: true }).click();
    await expect(minimap).toBeVisible();
    await expect(minimapMarkers).toHaveCount(1);
    await minimapMarkers.first().click();
    await expect(minimap.locator(".git-minimap-marker.active")).toHaveCount(1);

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
    await expect(page.locator(".git-commit-expand")).toContainText("note.md", { timeout: 20_000 });

    // 点击提交展开区的文件行：进入「该提交 ⇄ 父提交」差异视图。
    await page.locator(".git-detail-file").first().click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".git-diff-chip")).toContainText("^ ⇄", { timeout: 20_000 });
    await expect(page.locator(".git-diff-body")).toContainText("修改后的正文", { timeout: 20_000 });

    // 文件已打开时再选更早的提交：对比内容必须随基线刷新，不能残留上一次结果。
    await page.locator(".git-commit-row").nth(1).click();
    await expect(page.locator(".git-commit-expand")).toContainText("note.md", { timeout: 20_000 });
    await page.locator(".git-detail-file").first().click();
    await expect(page.locator(".git-diff-body")).not.toContainText("修改后的正文", {
      timeout: 20_000,
    });
    await expect(page.locator(".git-diff-body")).toContainText("初始");

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
    await page.getByRole("tab", { name: "Git", exact: true }).click();
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

/** M39：多根工作区可以在源代码管理面板切换仓库。 */
test("M39：多根工作区切换仓库", async () => {
  test.setTimeout(180_000);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "panda-multi-"));
  const alpha = path.join(base, "alpha");
  const beta = path.join(base, "beta");
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-multi-ud-"));

  await initRepo(alpha);
  await fs.writeFile(path.join(alpha, "a.md"), "# alpha\n", "utf8");
  await git(alpha, ["add", "."]);
  await git(alpha, ["commit", "-m", "alpha 提交"]);

  await initRepo(beta);
  await git(beta, ["checkout", "-b", "beta"]);
  await fs.writeFile(path.join(beta, "b.md"), "# beta\n", "utf8");
  await git(beta, ["add", "."]);
  await git(beta, ["commit", "-m", "beta 提交"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, alpha);
    await openFolder(page, app, beta);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const picker = page.locator(".git-repo-select");
    await expect(picker).toBeVisible({ timeout: 20_000 });
    await expect(picker.locator("option")).toHaveCount(2);
    const branchButton = page.locator(".git-branch-button");
    // 默认使用第一个工作区目录 alpha。
    await expect(branchButton).toContainText("main", { timeout: 20_000 });

    // 切换到 beta：分支与仓库路径随之切换。
    await picker.selectOption({ label: "beta" });
    await expect(branchButton).toContainText("beta", { timeout: 20_000 });

    // 再次切回 alpha。
    await picker.selectOption({ label: "alpha" });
    await expect(branchButton).toContainText("main", { timeout: 20_000 });
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：重命名条目在暂存、取消暂存与放弃时需要同时处理旧路径与新路径。 */
test("M39：重命名条目与已暂存差异", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-rename-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-rename-ud-"));
  const oldPath = path.join(repo, "old.md");
  const newPath = path.join(repo, "new.md");
  await initRepo(repo);
  await fs.writeFile(oldPath, "# 旧文件\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  // 已暂存的重命名：porcelain v2 记录为 type 2，新路径在前、旧路径在后。
  await git(repo, ["mv", "old.md", "new.md"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    page.on("dialog", (dialog) => void dialog.accept());
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const renameRow = page.locator(".git-change-row").filter({ hasText: "old.md → new.md" });
    await expect(renameRow).toHaveCount(1, { timeout: 20_000 });

    // 已暂存条目打开 Git 差异时默认对比暂存区（基线 chip 显示 HEAD ⇄ 暂存区）。
    await renameRow.locator(".git-change-path").click();
    await expect(page.locator(".git-diff-chip")).toContainText("暂存区", { timeout: 20_000 });
    await expect(page.locator(".git-diff-pane")).toBeVisible();

    // 取消暂存：旧路径回到未暂存删除，新路径从未跟踪开始。
    await renameRow.getByRole("button", { name: "取消暂存", exact: true }).click();
    await expect(page.locator(".git-change-row").filter({ hasText: "new.md" })).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(await git(repo, ["status", "--porcelain"])).toContain("D old.md");
    expect(await git(repo, ["status", "--porcelain"])).toContain("?? new.md");

    // 放弃：已跟踪删除恢复文件，未跟踪文件移入回收站，工作区回到干净状态。
    await page
      .locator(".git-change-row")
      .filter({ hasText: "old.md" })
      .getByRole("button", { name: "放弃修改", exact: true })
      .click();
    await expect(page.locator(".git-change-row").filter({ hasText: "old.md" })).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(await fs.readFile(oldPath, "utf8")).toContain("旧文件");

    await page
      .locator(".git-change-row")
      .filter({ hasText: "new.md" })
      .getByRole("button", { name: "放弃修改", exact: true })
      .click();
    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    await expect(fs.access(newPath)).rejects.toThrow();
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：放弃已暂存的重命名（含未暂存修改）需要同时处理旧路径与新路径。 */
test("M39：放弃重命名条目", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-rename-discard-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-rename-discard-ud-"));
  const oldPath = path.join(repo, "old.md");
  const newPath = path.join(repo, "new.md");
  await initRepo(repo);
  await fs.writeFile(oldPath, "# 旧文件\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  await git(repo, ["mv", "old.md", "new.md"]);
  // 重命名后再修改新路径：同一条目同时出现在「已暂存」与「更改」。
  await fs.writeFile(newPath, "# 旧文件\n\n重命名后的修改。\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    page.on("dialog", (dialog) => void dialog.accept());
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const unstagedRow = page
      .locator(".git-change-group")
      .filter({ hasText: "更改" })
      .locator(".git-change-row")
      .filter({ hasText: "old.md → new.md" });
    await expect(unstagedRow).toHaveCount(1, { timeout: 20_000 });
    await unstagedRow.getByRole("button", { name: "放弃修改", exact: true }).click();

    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    expect(await fs.readFile(oldPath, "utf8")).toContain("旧文件");
    await expect(fs.access(newPath)).rejects.toThrow();
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
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
    await page.getByRole("tab", { name: "Git", exact: true }).click();
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

/** M39：暂存的新增文件在 HEAD 中没有基线时，提示应明确为新增文件而不是路径异常。 */
test("M39：暂存新增文件的基线提示", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-added-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-added-ud-"));
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "base.md"), "# 基线\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  // 新增文件只进入暂存区，尚未提交，因此 HEAD 中没有该路径。
  await fs.writeFile(path.join(repo, "c.txt"), "this is a test 4\n", "utf8");
  await git(repo, ["add", "c.txt"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const row = page.locator(".git-change-row").filter({ hasText: "c.txt" });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.locator(".git-change-path").click();

    await expect(page.locator(".git-diff-chip")).toContainText("暂存区", { timeout: 20_000 });
    const notice = page.locator(".diff-notice");
    await expect(notice).toContainText("新增文件");
    await expect(notice).not.toContainText("不存在该文件的当前路径");
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：Amend 带入 HEAD 提交信息，取消勾选清空并支持中英文标签。 */
test("M39：修订上次提交", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-amend-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-amend-ud-"));
  const note = path.join(repo, "note.md");
  await initRepo(repo);
  await fs.writeFile(note, "# 初始\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  await fs.writeFile(note, "# 初始\n\n补充内容\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    const row = page.locator(".git-change-row").filter({ hasText: "note.md" });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await expect(row.locator(".git-change-status.status-modified")).toHaveCount(1);
    await row.getByRole("button", { name: "暂存", exact: true }).click();
    await expect(page.locator(".git-change-group").filter({ hasText: "已暂存" })).toHaveCount(1);

    const amendBox = page.getByRole("checkbox", { name: "修订上次提交" });
    await expect(amendBox).toBeVisible();
    await expect(amendBox).toBeEnabled();
    const messageBox = page.getByRole("textbox", { name: "提交信息", exact: true });

    // 勾选带入 HEAD 提交信息；取消勾选清空。
    await amendBox.check();
    await expect(messageBox).toHaveValue("初始提交");
    await amendBox.uncheck();
    await expect(messageBox).toHaveValue("");
    await amendBox.check();
    await expect(messageBox).toHaveValue("初始提交");

    // 修订提交：仍只有一个提交，标题更新。
    await messageBox.fill("修订初始提交");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });
    await page.getByRole("tab", { name: "历史", exact: true }).click();
    await expect(page.locator(".git-commit-row")).toHaveCount(1);
    await expect(page.locator(".git-commit-row").first()).toContainText("修订初始提交");
    expect(await git(repo, ["log", "--format=%s"])).toBe("修订初始提交");
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：合并提交按第一父提交列出文件；历史每页 50 条并可加载更多。 */
test("M39：合并提交文件列表与历史分页", async () => {
  test.setTimeout(240_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-merge-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-merge-ud-"));
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "base.md"), "# 基础\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  // 制造超过一页的历史，验证「加载更多」。
  for (let index = 0; index < 55; index += 1) {
    await git(repo, ["commit", "--allow-empty", "-m", `空提交 ${index + 1}`]);
  }
  const branch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await fs.writeFile(path.join(repo, "feature.md"), "# 功能\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "功能提交"]);
  await git(repo, ["checkout", branch]);
  await fs.writeFile(path.join(repo, "main.md"), "# 主线\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "主线提交"]);
  await git(repo, ["merge", "feature", "-m", "合并功能分支"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    await page.getByRole("tab", { name: "历史", exact: true }).click();

    const rows = page.locator(".git-commit-row");
    await expect(rows).toHaveCount(50, { timeout: 30_000 });
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    // 共 1 + 55 + 功能 + 主线 + 合并 = 59 个提交。
    await expect(rows).toHaveCount(59, { timeout: 30_000 });
    await expect(page.locator(".git-history-more")).toHaveCount(0);

    // 合并提交默认没有文件列表；应按第一父提交列出合并进来的文件。
    const mergeRow = rows.first();
    await expect(mergeRow).toContainText("合并功能分支");
    await mergeRow.click();
    const detail = page.locator(".git-commit-expand");
    await expect(detail).toContainText("feature.md", { timeout: 20_000 });
    await expect(detail.locator(".git-detail-file")).toHaveCount(1);
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
