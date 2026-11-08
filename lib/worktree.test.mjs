import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { addWorktree, listWorktrees, removeWorktree, repairWorktreeGitdirs, resolveProject } = await import("./worktree.ts");
const { samePath } = await import("./paths.ts");
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "safe.directory=*", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("discovers the main checkout and linked worktrees without retaining prunable paths", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "omp-web-worktree-test-"));
  const repo = join(root, "repo");
  const repoSubdir = join(repo, "nested", "project");
  const worktreeBase = `${repo}-worktrees`;
  try {
    git(root, ["init", repo]);
    git(repo, ["config", "user.email", "omp-web@example.invalid"]);
    git(repo, ["config", "user.name", "omp-web test"]);
    mkdirSync(repoSubdir, { recursive: true });
    writeFileSync(join(repoSubdir, "README.md"), "fixture\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixture"]);
    const main = await resolveProject(repo);
    assert.equal(samePath(main.projectRoot, repo), true);
    assert.equal(main.isWorktree, false);
    assert.equal(main.isTopLevel, true);
    assert.equal(main.branch, git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]));

    const nested = await resolveProject(repoSubdir);
    assert.equal(samePath(nested.projectRoot, repoSubdir), true);
    assert.equal(nested.branch, main.branch);
    assert.equal(nested.isWorktree, false);
    assert.equal(nested.isTopLevel, false);
    const initialWorktrees = await listWorktrees(repoSubdir);
    assert.equal(initialWorktrees.length, 1);
    assert.equal(initialWorktrees[0].isMain, true);
    assert.equal(samePath(initialWorktrees[0].path, repo), true);

    const created = await addWorktree(repo, "feature/test");
    assert.equal(created.branch, "feature/test");
    assert.equal(samePath(created.path, join(worktreeBase, "feature-test")), true);
    assert.equal(existsSync(created.path), true);

    const worktrees = await listWorktrees(repo);
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0].isMain, true);
    assert.equal(samePath(worktrees[0].path, repo), true);
    assert.ok(worktrees.some((entry) => samePath(entry.path, created.path) && entry.branch === "feature/test"));

    const linked = await resolveProject(created.path);
    assert.equal(linked.projectRoot, main.projectRoot);
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.branch, "feature/test");
    assert.equal(linked.isTopLevel, true);
    const linkedSubdir = join(created.path, "nested", "project");
    const linkedNested = await resolveProject(linkedSubdir);
    assert.equal(samePath(linkedNested.projectRoot, linkedSubdir), true);
    assert.equal(linkedNested.branch, "feature/test");
    assert.equal(linkedNested.isWorktree, false);
    assert.equal(linkedNested.isTopLevel, false);
    assert.deepEqual(await listWorktrees(repoSubdir), worktrees);
    assert.deepEqual(await listWorktrees(linkedSubdir), worktrees);
    const second = await addWorktree(linkedSubdir, "feature/linked");
    assert.equal(samePath(second.path, join(worktreeBase, "feature-linked")), true);
    const secondProject = await resolveProject(second.path);
    assert.equal(secondProject.projectRoot, main.projectRoot);
    assert.equal(secondProject.branch, "feature/linked");
    assert.equal(secondProject.isWorktree, true);
    assert.equal(secondProject.isTopLevel, true);
    await removeWorktree(linkedSubdir, second.path, true);
    assert.equal(existsSync(second.path), false);
    // Verify repairWorktreeGitdirs fixes Windows backslashes
    const worktreeGitdir = join(repo, ".git", "worktrees", "feature-test", "gitdir");
    if (existsSync(worktreeGitdir)) {
      const backslashedPath = join(created.path, ".git").replace(/\//g, "\\");
      writeFileSync(worktreeGitdir, backslashedPath + "\n", "utf8");
      repairWorktreeGitdirs(repo);
      const repairedContent = readFileSync(worktreeGitdir, "utf8").trim();
      assert.ok(!repairedContent.includes("\\"));
    }

    await removeWorktree(repoSubdir, created.path, true);
    assert.equal(existsSync(created.path), false);
    assert.deepEqual(await listWorktrees(repo), [worktrees[0]]);

    // When a directory still exists after removal (e.g. leftover .next/ on Windows),
    // resolveProject should still infer the project root back to the main repo.
    const dummyLeftover = join(worktreeBase, "dummy-branch");
    const inferred = await resolveProject(dummyLeftover);
    assert.equal(inferred.projectRoot, main.projectRoot);
    assert.equal(inferred.isWorktree, true);
    assert.equal(inferred.isTopLevel, true);
  } finally {
    rmSync(worktreeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("colliding sanitized branches create distinct checkouts without changing existing paths", async (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "omp-web-worktree-collision-"));
  const repo = join(root, "repo");
  try {
    git(root, ["init", repo]);
    git(repo, ["config", "user.email", "omp-web@example.invalid"]);
    git(repo, ["config", "user.name", "omp-web test"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "fixture"]);
    const dashed = await addWorktree(repo, "a-b");
    const slashed = await addWorktree(repo, "a/b");
    assert.equal(dashed.path, join(`${repo}-worktrees`, "a-b"));
    assert.notEqual(slashed.path, dashed.path);
    const worktrees = await listWorktrees(repo);
    assert.ok(worktrees.some(w => samePath(w.path, dashed.path) && w.branch === "a-b"));
    assert.ok(worktrees.some(w => samePath(w.path, slashed.path) && w.branch === "a/b"));
    await assert.rejects(addWorktree(repo, "a/b"));
    assert.equal(readFileSync(join(dashed.path, "README.md"), "utf8"), "fixture\n");
  } finally {
    rmSync(`${repo}-worktrees`, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
