import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNativeFile } from "./native-file-open.ts";
import { canOpenInSystemApp } from "./native-file-types.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-native-open-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent");
  mkdirSync(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const info = (filePath) => {
    const current = statSync(filePath);
    return { path: filePath, size: current.size, mtimeMs: current.mtimeMs, isDirectory: current.isDirectory() };
  };
  return { root, agent, info };
}

const refused = (code, status) => (error) => error.code === code && error.status === status;

test("system viewers accept a literal media filename above the text-preview limit", async (t) => {
  const { root, info } = fixture(t);
  const file = join(root, "generated (1) # [clip] & photo.PNG");
  writeFileSync(file, Buffer.alloc(512 * 1024, 1));
  const launched = [];
  await openNativeFile(info(file), async (filePath) => { launched.push(filePath); });
  assert.deepEqual(launched, [realpathSync(file)]);
});

test("scripts, executables, shortcuts, URLs and alternate streams never reach a system viewer", async (t) => {
  const { root } = fixture(t);
  let launches = 0;
  for (const name of ["run.exe", "run.cmd", "run.bat", "run.ps1", "run.sh", "run.js", "run.msi", "run.lnk", "run.url", "run.hta", "photo.png:run.exe", "photo.png\0"]) {
    const file = join(root, name);
    assert.equal(canOpenInSystemApp(file), false, name);
    await assert.rejects(openNativeFile({ path: file, size: 0, mtimeMs: 0, isDirectory: false }, async () => { launches++; }), refused("native_file_type_blocked", 403));
  }
  assert.equal(launches, 0);
});

test("an image-named symlink cannot turn the action into executable launch", async (t) => {
  const { root, info } = fixture(t);
  const script = join(root, "not-executed.cmd");
  const alias = join(root, "image.png");
  writeFileSync(script, "not executable fixture bytes");
  symlinkSync(script, alias);
  await assert.rejects(openNativeFile(info(alias), async () => { assert.fail("script must not launch"); }), refused("native_file_type_blocked", 403));
});

test("an image-named credential hardlink remains private", async (t) => {
  const { root, agent, info } = fixture(t);
  const secret = join(agent, "agent.db");
  const alias = join(root, "image.png");
  writeFileSync(secret, "private credential fixture");
  linkSync(secret, alias);
  await assert.rejects(openNativeFile(info(alias), async () => { assert.fail("credential must not launch"); }), refused("native_file_type_blocked", 403));
});

test("removed, replaced and directory targets cannot be opened using stale metadata", async (t) => {
  const { root, info } = fixture(t);
  const file = join(root, "changed.png");
  writeFileSync(file, "before");
  const original = info(file);
  writeFileSync(file, "different file bytes");
  const never = async () => { assert.fail("stale target must not launch"); };
  await assert.rejects(openNativeFile(original, never), refused("file_changed", 409));
  rmSync(file);
  await assert.rejects(openNativeFile(original, never), refused("file_not_found", 404));
  mkdirSync(file);
  await assert.rejects(openNativeFile(info(file), never), refused("not_a_file", 400));
});

test("a missing default application reports an actionable failure rather than success", async (t) => {
  const { root, info } = fixture(t);
  const file = join(root, "photo.png");
  writeFileSync(file, "fixture");
  await assert.rejects(openNativeFile(info(file), async () => { throw new Error("No associated application"); }), refused("native_open_failed", 502));
});
