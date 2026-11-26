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
  // 快捷键由渲染层 keydown 监听与 App 注入的 openWorkspaceFolder 处理；
  // firstWindow 返回时 React 可能尚未挂载，先等根节点出现，避免按键被丢弃。
  await page.locator(".app").waitFor();
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, dir);
  // 用快捷键打开文件夹：入口已移入工作区工具栏，而侧栏可能处于其它标签或折叠状态。
  await page.keyboard.press("Control+Shift+O");
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

    // 这个仓库没有 remote：联网按钮直接置灰，配置入口在工具栏（与同步按钮用竖线分隔）。
    await expect(page.getByRole("button", { name: "推送", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "获取", exact: true })).toBeDisabled();

    // 首次配置远程：名字默认 origin，保存后推送按钮恢复可用。
    await page.getByRole("button", { name: "设置远程地址", exact: true }).click();
    const remoteDialog = page.getByRole("dialog", { name: "设置远程地址" });
    await expect(remoteDialog).toBeVisible();
    const remoteFields = remoteDialog.locator(".git-remote-input");
    await expect(remoteFields).toHaveCount(2);
    await expect(remoteFields.first()).toHaveValue("origin");
    await remoteFields.nth(1).fill("https://example.com/repo.git");
    await remoteDialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(remoteDialog).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "推送", exact: true })).toBeEnabled();

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

    // pull 快进到远程提交：打开确认窗口，核对远端/分支后确认。
    await page.getByRole("button", { name: "拉取", exact: true }).click();
    const pullDialog = page.getByRole("dialog", { name: "拉取提交" });
    await expect(pullDialog.locator(".git-sync-meta")).toContainText("origin");
    await expect(pullDialog.locator(".git-sync-meta")).toContainText("main");
    await pullDialog.getByRole("button", { name: "确认", exact: true }).click();
    // 执行结束后窗口停在原位显示结果，点「完成」才收起。
    await expect(page.getByRole("dialog", { name: "拉取完成" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "完成", exact: true }).click();
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
    const pushDialog = page.getByRole("dialog", { name: "推送提交" });
    await expect(pushDialog.locator(".git-sync-meta")).toContainText("origin");
    await pushDialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "推送完成" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "完成", exact: true }).click();
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

/** M39：Amend 用 %B 回填保留多行提交信息；零暂存时仍可仅改写提交信息。 */
test("M39：Amend 多行信息与零暂存修订", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-amend-multi-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-amend-multi-ud-"));
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "base.md"), "# 基础\n", "utf8");
  await git(repo, ["add", "."]);
  // 多行提交信息：标题 + 正文（正文内含换行）。
  await git(repo, ["commit", "-m", "多行提交标题", "-m", "正文第一行\n正文第二行"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });

    const amendBox = page.getByRole("checkbox", { name: "修订上次提交" });
    const messageBox = page.getByRole("textbox", { name: "提交信息", exact: true });

    // 勾选 Amend 后按原始多行结构回填，而非折叠成一行。
    await amendBox.check();
    await expect(messageBox).toHaveValue("多行提交标题\n\n正文第一行\n正文第二行");

    // 无暂存改动时修改提交信息并提交，仅改写上次提交。
    const commitButton = page.getByRole("button", { name: "提交", exact: true });
    await expect(commitButton).toBeEnabled();
    await messageBox.fill("修订后的标题\n\n修订后的正文");
    await commitButton.click();
    await expect(page.locator(".git-clean")).toHaveText("工作区没有变更", { timeout: 20_000 });

    await page.getByRole("tab", { name: "历史", exact: true }).click();
    await expect(page.locator(".git-commit-row")).toHaveCount(1);
    await expect(page.locator(".git-commit-row").first()).toContainText("修订后的标题");
    expect((await git(repo, ["log", "--format=%B", "-1"])).trim()).toBe(
      "修订后的标题\n\n修订后的正文",
    );
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

/** M39：对比基线选择器：HEAD 状态、文件历史分页与当前提交排除。 */
test("M39：对比基线选择器与文件历史分页", async () => {
  test.setTimeout(240_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-picker-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-picker-ud-"));
  const historyFile = path.join(repo, "history.md");
  const dirtyFile = path.join(repo, "dirty.md");
  await initRepo(repo);
  await fs.writeFile(historyFile, "# v0\n", "utf8");
  await fs.writeFile(dirtyFile, "# dirty\n\n基础内容\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  // 25 个提交改动 history.md，用于验证每页 20 条与当前 HEAD 排除。
  for (let index = 1; index <= 24; index += 1) {
    await fs.writeFile(historyFile, `# v${index}\n`, "utf8");
    await git(repo, ["add", historyFile]);
    await git(repo, ["commit", "-m", `历史提交 ${index}`]);
  }
  await fs.writeFile(dirtyFile, "# dirty\n\n磁盘已修改\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);

    // 干净文件：只显示提交历史，不显示「与当前文件比较」。
    await page.locator(".tree-name", { hasText: "history.md" }).click();
    await page.getByRole("button", { name: "Git 差异", exact: true }).click();
    await expect(page.locator(".git-diff-chip")).toBeVisible({ timeout: 20_000 });
    await page.locator(".git-diff-chip").click();
    const popover = page.locator(".git-chip-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("未暂存更改");
    await expect(popover).toContainText("已暂存更改");
    // 当前基线 HEAD 从历史中排除：取 20 条显示 19 条。
    await expect(page.locator(".git-chip-history-row")).toHaveCount(19, { timeout: 20_000 });
    await popover.getByRole("button", { name: "下一页" }).click();
    await expect(page.locator(".git-chip-history-row")).toHaveCount(5, { timeout: 20_000 });
    await expect(popover).toContainText("第 2 页");
    await page.keyboard.press("Escape");

    // 有未保存修改：显示 HEAD 与上次保存。
    await page.locator(".tree-name", { hasText: "dirty.md" }).click();
    await page.getByRole("button", { name: "源码", exact: true }).click();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("# dirty\n\n编辑器未保存内容\n");
    await page.getByRole("button", { name: "Git 差异", exact: true }).click();
    await expect(page.locator(".git-diff-chip")).toBeVisible({ timeout: 20_000 });
    await page.locator(".git-diff-chip").click();
    const dirtyPopover = page.locator(".git-chip-popover");
    await expect(dirtyPopover).toContainText("未暂存更改");
    await expect(dirtyPopover).toContainText("已暂存更改");
    await expect(dirtyPopover).toContainText("此文件的提交历史");

    // 侧栏「未保存」分组列出编辑器里尚未落盘的文档，替代原来的常驻提示条。
    await page.keyboard.press("Escape");
    // dirty.md 磁盘上有改动，Git 标签带变更数角标，可达名称形如 "Git N"；
    // 依赖 getByRole 对 name 的默认子串匹配（非精确），故用 "Git" 仍能命中。
    await page.getByRole("tab", { name: "Git" }).click();
    const unsavedGroup = page.locator(".git-change-group").filter({ hasText: "未保存" });
    await expect(unsavedGroup).toContainText("dirty.md");
    await expect(unsavedGroup.getByRole("button", { name: "全部保存" })).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：边栏「比较」视图：双提交、工作区与手工输入。 */
test("M39：仓库比较视图", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-compare-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-compare-ud-"));
  const aFile = path.join(repo, "a.md");
  await initRepo(repo);
  await fs.writeFile(aFile, "# A\n\n第一版\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "第一次提交"]);
  await fs.writeFile(aFile, "# A\n\n第二版\n", "utf8");
  await fs.writeFile(path.join(repo, "b.md"), "# B\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "第二次提交"]);
  await fs.writeFile(aFile, "# A\n\n工作区版本\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    await page.getByRole("tab", { name: "比较", exact: true }).click();

    const files = page.locator(".git-compare-file");
    await expect(files).toHaveCount(2, { timeout: 20_000 });
    await expect(files.filter({ hasText: "a.md" })).toHaveCount(1);
    await expect(files.filter({ hasText: "b.md" })).toHaveCount(1);

    // 双提交：点击文件进入 HEAD~1 ⇄ HEAD 差异。
    await files.filter({ hasText: "a.md" }).click();
    await expect(page.locator(".git-diff-chip")).toContainText("HEAD~1 ⇄ HEAD", {
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "对比", exact: true }).click();
    await expect(page.locator(".git-source-new .cm-content")).toContainText("第二版", {
      timeout: 20_000,
    });

    // 目标切换为工作区：列表按磁盘内容重新计算，点击后对比工作区。
    const targetInput = page.locator('.git-compare-input[aria-label="目标"]');
    await targetInput.fill("");
    await targetInput.press("Enter");
    await expect(page.locator(".git-compare-summary")).toContainText("变更文件", {
      timeout: 20_000,
    });
    await expect(files).toHaveCount(2, { timeout: 20_000 });
    await files.filter({ hasText: "a.md" }).click();
    await expect(page.locator(".git-diff-chip")).toContainText("工作区 ⇄ HEAD~1", {
      timeout: 20_000,
    });
    await expect(page.locator(".git-source-new .cm-content")).toContainText("工作区版本", {
      timeout: 20_000,
    });

    // 手工输入非法引用显示错误。
    const baseInput = page.locator('.git-compare-input[aria-label="基准"]');
    await baseInput.fill("no-such-ref");
    await baseInput.press("Enter");
    await expect(page.locator(".git-compare .banner-warning")).toContainText("no-such-ref", {
      timeout: 20_000,
    });
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
test("M39：对比视图改动标记与滚动联动", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-scroll-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-scroll-ud-"));
  const file = path.join(repo, "long.md");
  const lines = Array.from({ length: 160 }, (_, index) => `第 ${index + 1} 行内容`);
  await initRepo(repo);
  await fs.writeFile(file, `# 标题\n\n${lines.join("\n")}\n`, "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  const next = [...lines];
  next.splice(5, 1); // 删除第 6 行
  next.splice(9, 0, "新增行 A", "新增行 B"); // 第 10 行后插入 2 行
  next.splice(13, 1, "第 13 行改写 A", "第 13 行改写 B", "第 13 行改写 C"); // 1 行改 3 行
  await fs.writeFile(file, `# 标题\n\n${next.join("\n")}\n`, "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    await page
      .locator(".git-change-row")
      .filter({ hasText: "long.md" })
      .locator(".git-change-path")
      .click();
    await page.getByRole("button", { name: "对比", exact: true }).click();
    await expect(page.locator(".git-source-old .cm-scroller")).toBeVisible({ timeout: 20_000 });

    // 删除行红底、新增行绿底、修改行左右成对；缺少内容的一侧用占位行补齐。
    await expect(page.locator(".git-source-old .cm-line.cm-diff-line-delete")).toHaveCount(1);
    await expect(page.locator(".git-source-new .cm-line.cm-diff-line-add")).toHaveCount(2);
    await expect(page.locator(".git-source-new .cm-line.cm-diff-line-change")).toHaveCount(3);
    const oldSpacers = page.locator(".git-source-old .cm-diff-spacer.add");
    // 新增 hunk 与 1 行改 3 行的 change hunk 各需要一个 +2 占位。
    await expect(oldSpacers).toHaveCount(2);
    await expect(oldSpacers.first()).toHaveText("+2 行");
    await expect(oldSpacers.nth(1)).toHaveText("+2 行");
    await expect(page.locator(".git-source-new .cm-diff-spacer.delete")).toHaveText("−1 行");

    // 两栏占位后，同一行文本在左右应处于同一水平位置。
    const delta = await page.evaluate(() => {
      const find = (selector: string, text: string): DOMRect | null => {
        for (const line of document.querySelectorAll<HTMLElement>(`${selector} .cm-line`)) {
          if (line.textContent?.trim() === text) return line.getBoundingClientRect();
        }
        return null;
      };
      const left = find(".git-source-old", "第 12 行内容");
      const right = find(".git-source-new", "第 12 行内容");
      return left && right ? Math.abs(left.top - right.top) : -1;
    });
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThan(2);

    /** 读取左右两栏的滚动比例。 */
    const ratios = (): Promise<{ old: number; next: number }> =>
      page.evaluate(() => {
        const ratio = (selector: string): number => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) return -1;
          const max = element.scrollHeight - element.clientHeight;
          return max > 0 ? element.scrollTop / max : 0;
        };
        return {
          old: ratio(".git-source-old .cm-scroller"),
          next: ratio(".git-source-new .cm-scroller"),
        };
      });

    // 左侧滚动 → 右侧跟随。
    await page.locator(".git-source-old .cm-scroller").evaluate((element: HTMLElement) => {
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = max * 0.5;
    });
    await expect
      .poll(async () => {
        const value = await ratios();
        return value.next < 0 ? 1 : Math.abs(value.next - value.old);
      })
      .toBeLessThan(0.02);
    expect((await ratios()).next).toBeGreaterThan(0.4);

    // 右侧滚动 → 左侧跟随。
    await page.locator(".git-source-new .cm-scroller").evaluate((element: HTMLElement) => {
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = max * 0.2;
    });
    await expect
      .poll(async () => {
        const value = await ratios();
        return value.next < 0 ? 1 : Math.abs(value.next - value.old);
      })
      .toBeLessThan(0.02);
    expect((await ratios()).old).toBeLessThan(0.3);

    // 滚动到文档中部后，可见的共同内容仍保持逐行对齐（长文档占位高度必须准确）。
    await page.locator(".git-source-old .cm-scroller").evaluate((element: HTMLElement) => {
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = max * 0.5;
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const tops = new Map<string, number>();
          for (const line of document.querySelectorAll<HTMLElement>(".git-source-old .cm-line")) {
            const text = line.textContent?.trim() ?? "";
            if (text) tops.set(text, line.getBoundingClientRect().top);
          }
          let delta = Number.POSITIVE_INFINITY;
          for (const line of document.querySelectorAll<HTMLElement>(".git-source-new .cm-line")) {
            const oldTop = tops.get(line.textContent?.trim() ?? "");
            if (oldTop === undefined) continue;
            delta = Math.min(delta, Math.abs(oldTop - line.getBoundingClientRect().top));
          }
          return delta;
        }),
      )
      .toBeLessThan(2);

    // 折叠未改动后占位行仍然存在（此时内容变短，不再验证滚动）。
    await page.locator(".git-diff-view").selectOption("collapse");
    await expect(oldSpacers).toHaveCount(2);
    await expect(page.locator(".git-source-new .cm-diff-spacer.delete")).toHaveCount(1);
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：打开子目录文件只会改变仓库探测路径，不应重置历史详情或对比列表。 */
test("M39：打开子目录文件不重置历史与对比栏", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-probe-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-probe-ud-"));
  await initRepo(repo);
  await fs.mkdir(path.join(repo, "docs"), { recursive: true });
  await fs.mkdir(path.join(repo, "other"), { recursive: true });
  await fs.writeFile(path.join(repo, "docs", "a.md"), "# A\n\n第一版\n", "utf8");
  await fs.writeFile(path.join(repo, "other", "b.md"), "# B\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  await fs.writeFile(path.join(repo, "docs", "a.md"), "# A\n\n第二版\n", "utf8");
  await fs.writeFile(path.join(repo, "other", "b.md"), "# B\n\n更新\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "第二次提交"]);

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();

    // 历史：展开提交后打开子目录文件，详情不应被清空。
    await page.getByRole("tab", { name: "历史", exact: true }).click();
    await expect(page.locator(".git-commit-row")).toHaveCount(2, { timeout: 20_000 });
    await page.locator(".git-commit-row").first().click();
    const detailFile = page.locator(".git-detail-file").filter({ hasText: "docs/a.md" });
    await expect(detailFile).toBeVisible({ timeout: 20_000 });
    await detailFile.click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });
    // 探测路径从仓库根变为 docs/：历史详情与提交列表必须保留。
    await expect(page.locator(".git-commit-expand")).toContainText("docs/a.md");
    await expect(page.locator(".git-commit-expand")).not.toContainText("读取提交详情");
    await expect(page.locator(".git-commit-row")).toHaveCount(2);

    // 对比：选择另一个子目录的文件，列表节点不应被“读取中”整体替换。
    await page.getByRole("tab", { name: "比较", exact: true }).click();
    const compareFiles = page.locator(".git-compare-files");
    await expect(page.locator(".git-compare-file")).toHaveCount(2, { timeout: 20_000 });
    const listHandle = await compareFiles.elementHandle();
    expect(listHandle).not.toBeNull();
    await page.locator(".git-compare-file").filter({ hasText: "other/b.md" }).click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });
    // 旧实现会先清空对比状态并渲染“读取中…”，列表 DOM 被卸载。
    expect(await listHandle?.isVisible()).toBe(true);
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

/** M39：文件先以默认视图打开，再从 Git 栏选择同一文件时应进入差异视图。 */
test("M39：从 Git 栏再次打开已打开的文件进入差异视图", async () => {
  test.setTimeout(180_000);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panda-git-reopen-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-git-reopen-ud-"));
  const note = path.join(repo, "note.md");
  await initRepo(repo);
  await fs.writeFile(note, "# 初始\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "初始提交"]);
  await fs.writeFile(note, "# 初始\n\n修改后的正文。\n", "utf8");

  const app = await electron.launch({
    args: ["."],
    cwd: CWD,
    env: { ...process.env, PANDA_USER_DATA_DIR: userDataDir },
  });
  try {
    const page = await app.firstWindow();
    // 先从文件对话框打开（非 Git 入口），Markdown 进入默认预览视图。
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, note);
    await page.locator(".app").waitFor();
    await page.keyboard.press("Control+O");
    await expect(page.locator(".tab-item.active .tab-name")).toHaveText("note.md");
    const previewButton = page
      .locator(".mode-bar .mode-bar-modes")
      .getByRole("button", { name: "预览", exact: true });
    await expect(previewButton).toHaveAttribute("aria-pressed", "true");

    // 打开仓库后从 Git 栏选择同一文件：应切换到 Git 差异视图。
    await openFolder(page, app, repo);
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    const changeRow = page.locator(".git-change-row").filter({ hasText: "note.md" });
    await expect(changeRow).toHaveCount(1, { timeout: 20_000 });
    await changeRow.locator(".git-change-path").click();
    await expect(page.locator(".git-diff-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".mode-button-git")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
