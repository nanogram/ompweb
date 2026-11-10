import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const { publishRelease } = createRequire(import.meta.url)("./ui-release.cjs");
function fixture(t, repository = "nanogram/ompweb") {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ow-publish-test-"));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_COUNT: "0", GIT_CONFIG_GLOBAL: path.join(sourceRoot, "no-global"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/i.test(key)) delete env[key];
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("config", "core.hooksPath", path.join(sourceRoot, "no-hooks"));
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: "0.6.0-test", repository: { url: `git+https://github.com/${repository}.git` } }));
  git("add", "package.json");
  git("commit", "-m", "fixture");
  git("remote", "add", "origin", "https://github.com/kahme247/ompweb.git");
  return { sourceRoot, git, options: { sourceRoot, dryRun: true, logger() {} } };
}

test("publication previews use the declared fork, never an upstream origin, without changing the checkout", async (t) => {
  const f = fixture(t);
  const indexPath = path.join(f.sourceRoot, ".git/index");
  const before = fs.readFileSync(indexPath);
  const head = f.git("rev-parse", "HEAD");
  const result = await publishRelease(f.options);
  assert.equal(result.destination, "https://github.com/nanogram/ompweb.git");
  assert.equal(result.refspec, `${head}:refs/heads/main`);
  assert.equal(result.published, false);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, "build")), false);
  assert.equal(f.git("remote", "get-url", "origin"), "https://github.com/kahme247/ompweb.git");
});

test("publication rejects an explicitly chosen upstream remote and an upstream package identity", async (t) => {
  const f = fixture(t);
  await assert.rejects(publishRelease({ ...f.options, remote: "origin" }), /No matching origin remote/);
  const upstream = fixture(t, "kahme247/ompweb");
  await assert.rejects(publishRelease(upstream.options), /upstream is forbidden/);
});

test("publication previews report uncommitted work and mismatched review commits without pushing", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sourceRoot, "uncommitted.txt"), "not reviewed");
  const result = await publishRelease({ ...f.options, reviewedHead: "0".repeat(40) });
  assert.equal(result.published, false);
  assert.equal(result.blockers.length, 2);
  assert.match(result.blockers[0], /clean and committed/);
  assert.match(result.blockers[1], /Reviewed HEAD does not match/);
});
