import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, symlinkSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

let h, owner;
before(async () => {
  h = await workspaceHarness();
  owner = await h.startHost();
  const selected = await owner.host.sessionOps.validateCwd(owner.project);
  assert.equal(selected.ok, true);
});
after(async () => h?.close());

test("a remote workspace read returns its file after daemon-owned cwd selection", async () => {
  const file = join(owner.project, "remote.txt");
  writeFileSync(file, "bytes on the selected host\n");
  const res = await h.file(owner.id, file);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: "bytes on the selected host\n", language: "text", size: 27 });
});

test("an invalid requested filename does not masquerade as unavailable credential metadata", async () => {
  const response = await h.file(owner.id, join(owner.project, "invalid\0name.txt"));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "file_not_found");
});

test("workspace listing shows every name and confines symlinks to the selected Explorer root", async () => {
  const directory = join(owner.project, "tree");
  mkdirSync(join(directory, "build"), { recursive: true });
  mkdirSync(join(directory, ".git", "hooks"), { recursive: true });
  writeFileSync(join(directory, "source.txt"), "source");
  const normal = await h.file(owner.id, directory, "list");
  assert.equal(normal.status, 200);
  assert.deepEqual((await normal.json()).entries.map((entry) => entry.name), [".git", "build", "source.txt"]);
  const hooks = await h.file(owner.id, join(directory, ".git"), "list", { root: directory });
  assert.equal(hooks.status, 200);
  assert.deepEqual((await hooks.json()).entries.map((entry) => entry.name), ["hooks"]);
  const outside = join(h.root, "unselected");
  mkdirSync(outside);
  assert.equal((await h.file(owner.id, outside, "list", { root: directory })).status, 403);

  const sibling = join(owner.project, "tree-x");
  mkdirSync(sibling);
  const win = process.platform === "win32";
  symlinkSync(win ? join(directory, "build") : "build", join(directory, "inside"), win ? "junction" : "dir");
  symlinkSync(sibling, join(directory, "outside"), win ? "junction" : "dir");
  if (!win) symlinkSync("missing", join(directory, "dangling"));
  const rooted = await h.file(owner.id, directory, "list", { root: directory });
  assert.equal(rooted.status, 200);
  const entries = Object.fromEntries((await rooted.json()).entries.map((entry) => [entry.name, entry]));
  assert.equal(typeof entries.inside.linkTarget, "string");
  assert.equal(entries.inside.outsideRoot, undefined);
  assert.equal(typeof entries.outside.linkTarget, "string");
  assert.equal(entries.outside.outsideRoot, true);
  if (!win) {
    assert.equal(entries.dangling.linkTarget, "missing");
    assert.equal(entries.dangling.outsideRoot, true);
  }
  assert.equal((await h.file(owner.id, join(directory, "inside"), "list", { root: directory })).status, 200);
  for (const target of [sibling, join(directory, "outside")]) {
    const escaped = await h.file(owner.id, target, "list", { root: directory });
    assert.equal(escaped.status, 403);
    assert.equal((await escaped.json()).code, "outside_root");
  }
  for (const root of ["", ".", "..", "relative/root"]) {
    const refused = await h.file(owner.id, directory, "list", { root });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "outside_root");
  }
});

test("Explorer roots preserve literal POSIX backslashes", { skip: process.platform === "win32" }, async () => {
  const directory = join(owner.project, "literal\\root");
  mkdirSync(directory);
  writeFileSync(join(directory, "kept.txt"), "file bytes");
  const response = await h.file(owner.id, directory, "list", { root: directory });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).entries.map(entry => entry.name), ["kept.txt"]);
});

test("the original boolean listing operation remains usable by an older main", async () => {
  const directory = join(owner.project, "legacy-listing");
  mkdirSync(directory);
  writeFileSync(join(directory, "kept.txt"), "file bytes");
  const result = await owner.host.workspaceOps.listFiles({ segments: [directory], sessionId: null }, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.entries.map(entry => entry.name), ["kept.txt"]);
});

test("root-confined Explorer listing refuses a daemon advertising only the original listing contract", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const { HostOpError } = await import("./link-protocol.ts");
  const older = await linkHost("Boolean listing daemon", { hello: { workspaceOps: ["listFiles"] } });
  void older.serve({ listFiles(args) {
    if (typeof args.showHidden !== "boolean") throw new HostOpError(400, "invalid_request", "Expected the original boolean listing contract");
    return { ok: true, value: { path: owner.project, entries: [] } };
  } });
  try {
    const response = await h.file(older.id, owner.project, "list", { root: owner.project });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, "workspace_unsupported");
  } finally { older.drop(); }
});

test("credential symlinks and unselected files cannot be read through workspace roots", async () => {
  const secret = join(owner.agentDir, "agent.db");
  writeFileSync(secret, "secret credentials");
  const alias = join(owner.project, "harmless.txt");
  symlinkSync(secret, alias);
  assert.equal((await h.file(owner.id, alias)).status, 403);
  assert.equal((await h.file(owner.id, secret, "download")).status, 403);
});

test("preview boundaries do not cap downloads and suffix ranges preserve bytes", async () => {
  const file = join(owner.project, "preview.txt");
  writeFileSync(file, Buffer.alloc(256 * 1024, 120));
  assert.equal((await h.file(owner.id, file)).status, 200);
  writeFileSync(file, Buffer.alloc(256 * 1024 + 1, 121));
  assert.equal((await h.file(owner.id, file)).status, 413);
  const suffix = await h.file(owner.id, file, "download", {}, { range: "bytes=-3" });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 262142-262144/262145");
  assert.equal(await suffix.text(), "yyy");
  assert.equal((await h.file(owner.id, file, "download", {}, { range: "bytes=300000-" })).status, 416);
  const empty = join(owner.project, "empty.txt");
  writeFileSync(empty, "");
  const zero = await h.file(owner.id, empty, "download");
  assert.equal(zero.status, 200);
  assert.equal(await zero.text(), "");
});

test("large MP4, MOV and WebM previews stream from the owning host with video MIME and byte ranges", async () => {
  const bytes = Buffer.alloc(512 * 1024 + 17, 0x72);
  bytes.write("generated media");
  for (const [ext, mime] of [["mp4", "video/mp4"], ["MOV", "video/quicktime"], ["webm", "video/webm"]]) {
    const file = join(owner.project, `generated.${ext}`);
    writeFileSync(file, bytes);
    const meta = await h.file(owner.id, file, "meta");
    assert.equal(meta.status, 200, ext);
    assert.equal((await meta.json()).mime, mime, ext);
    const response = await h.file(owner.id, file);
    assert.equal(response.status, 200, ext);
    assert.equal(response.headers.get("content-type"), mime, ext);
    assert.equal(response.headers.get("accept-ranges"), "bytes", ext);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, ext);
    const ranged = await h.file(owner.id, file, "read", {}, { range: "bytes=262140-262150" });
    assert.equal(ranged.status, 206, ext);
    assert.equal(ranged.headers.get("content-type"), mime, ext);
    assert.equal(ranged.headers.get("content-range"), `bytes 262140-262150/${bytes.length}`, ext);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(262140, 262151), ext);
    const download = await h.file(owner.id, file, "download", {}, { range: "bytes=-4" });
    assert.equal(download.status, 206, ext);
    assert.match(download.headers.get("content-disposition"), /^attachment;/, ext);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes.subarray(-4), ext);
    assert.equal((await h.file(owner.id, file, "read", {}, { range: `bytes=${bytes.length}-` })).status, 416, ext);
  }
});

test("video reads use authorized host paths even when a running daemon still reports text MIME", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const bytes = Buffer.alloc(256 * 1024 + 1, 0x76);
  const older = await linkHost("Old media metadata", { hello: { workspaceOps: ["fileInfo", "openFile", "readFileChunk", "closeFile", "readTextFile"] } });
  const opened = [], closed = [];
  let textReads = 0;
  const staleInfo = (filePath) => ({ path: filePath, name: filePath.split("/").pop(), size: bytes.length, mtimeMs: 1, isDirectory: false, language: "text", mime: "text/plain", previewKind: null });
  void older.serve({
    fileInfo: ({ input }) => ({ ok: true, value: staleInfo(input.segments[0]) }),
    openFile: ({ input }) => {
      const filePath = input.segments[0];
      opened.push(filePath);
      return { ok: true, value: { id: filePath, info: staleInfo(filePath) } };
    },
    readFileChunk: ({ offset, length }) => bytes.subarray(offset, offset + length),
    closeFile: ({ id }) => { closed.push(id); return { ok: true, value: null }; },
    readTextFile: () => { textReads++; return { ok: false, status: 413, code: "file_too_large_preview", error: "File too large for preview (>256KB)" }; },
  });
  try {
    for (const [ext, mime] of [["mp4", "video/mp4"], ["mov", "video/quicktime"], ["webm", "video/webm"]]) {
      const filePath = `/only-on-owning-host/generated.${ext}`;
      const meta = await h.file(older.id, filePath, "meta");
      assert.equal(meta.status, 200, ext);
      assert.equal((await meta.json()).mime, mime, ext);
      const response = await h.file(older.id, filePath, "read", {}, { range: "bytes=-3" });
      assert.equal(response.status, 206, ext);
      assert.equal(response.headers.get("content-type"), mime, ext);
      assert.equal(response.headers.get("content-range"), `bytes ${bytes.length - 3}-${bytes.length - 1}/${bytes.length}`, ext);
      assert.equal(await response.text(), "vvv", ext);
      assert.ok(opened.includes(filePath), ext);
      assert.ok(closed.includes(filePath), ext);
    }
    assert.equal(textReads, 0);
  } finally { older.drop(); }
});

test("a download larger than one link result is streamed byte-exact", async () => {
  const file = join(owner.project, "large.bin");
  const size = 64 * 1024 * 1024 + 17;
  const fd = openSync(file, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  const response = await h.file(owner.id, file, "download");
  assert.equal(response.status, 200);
  const actual = createHash("sha256");
  let received = 0;
  for await (const chunk of response.body) { received += chunk.byteLength; actual.update(chunk); }
  const expected = createHash("sha256");
  const zero = Buffer.alloc(64 * 1024);
  for (let at = 0; at < size; at += zero.length) expected.update(zero.subarray(0, Math.min(zero.length, size - at)));
  assert.equal(received, size);
  assert.equal(actual.digest("hex"), expected.digest("hex"));
});

test("a session reference permits only its owning host and never grants directory listing", async () => {
  const id = randomUUID();
  const outside = join(owner.home, "referenced.txt");
  writeFileSync(outside, "referenced on this host");
  const dir = join(owner.agentDir, "sessions", "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-11-03_${id}.jsonl`), [
    { type: "session", version: 3, id, cwd: owner.project, timestamp: "2026-11-03T00:00:00Z" },
    { type: "message", id: "ref-entry", parentId: null, message: { role: "assistant", content: [{ type: "text", text: outside }] } },
  ].map(JSON.stringify).join("\n") + "\n");
  owner.host.invalidateSessionLists();
  const allowed = await h.file(owner.id, outside, "read", { sessionId: id });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).content, "referenced on this host");
  assert.equal((await h.file(owner.id, owner.home, "list", { sessionId: id })).status, 403);
  const other = await h.startHost();
  assert.equal((await h.file(other.id, outside, "read", { sessionId: id })).status, 409);
});

test("an older linked daemon refuses workspace access instead of reading main's disk", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const older = await linkHost("Old daemon");
  try {
    const response = await h.file(older.id, join(owner.project, "remote.txt"));
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, "workspace_unsupported");
  } finally { older.drop(); }
});

test("a malformed file result from a linked host is refused at the boundary", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const bad = await linkHost("Malformed daemon", { hello: { workspaceOps: ["fileInfo"] } });
  bad.serve({ fileInfo: () => ({ ok: true, value: { path: "/secret", size: "not a byte count" } }) });
  try {
    const response = await h.file(bad.id, "/secret");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "host_bad_result");
  } finally { bad.drop(); }
});

test("malformed symlink listing metadata from a linked host is refused", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const bad = await linkHost("Malformed symlinks", { hello: { workspaceOps: ["listFilesInRoot"] } });
  let metadata = { linkTarget: 42 };
  void bad.serve({ listFilesInRoot: () => ({ ok: true, value: { path: "/tree", entries: [
    { name: "link", isDir: true, size: 0, modified: "", ...metadata },
  ] } }) });
  try {
    for (const invalid of [{ linkTarget: 42 }, { outsideRoot: "true" }]) {
      metadata = invalid;
      const response = await h.file(bad.id, "/tree", "list", { root: "/tree" });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, "host_bad_result");
    }
  } finally { bad.drop(); }
});

test("system-app actions reject linked hosts instead of opening main's local namesake", async () => {
  const { POST } = await import("../../app/api/files/[...path]/route.ts");
  const { filePathApiSegments } = await import("../file-paths.ts");
  const file = join(owner.project, "generated.png");
  writeFileSync(file, "inert media fixture");
  const response = await POST(new Request(`http://localhost/api/files/ignored?type=open-native&hostId=${owner.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({ path: filePathApiSegments(file) }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "native_open_remote_host");
});

test("local system-app actions keep workspace authorization and cannot execute files or GET actions", async () => {
  const { POST } = await import("../../app/api/files/[...path]/route.ts");
  const { filePathApiSegments } = await import("../file-paths.ts");
  const local = await h.startHost(true);
  assert.equal((await local.host.sessionOps.validateCwd(local.project)).ok, true);
  const script = join(local.project, "not-executed.cmd");
  const directory = join(local.project, "directory.png");
  const outside = join(local.home, "private.png");
  writeFileSync(script, "inert executable fixture");
  mkdirSync(directory);
  writeFileSync(outside, "outside workspace");
  const post = (file, body = {}) => POST(new Request("http://localhost/api/files/ignored?type=open-native&hostId=local", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ path: filePathApiSegments(file) }) });
  for (const [file, status, code] of [
    [script, 403, "native_file_type_blocked"],
    [directory, 400, "not_a_file"],
    [outside, 403, "access_denied"],
    [join(local.project, "missing.png"), 404, "file_not_found"],
  ]) {
    const response = await post(file);
    assert.equal(response.status, status, file);
    assert.equal((await response.json()).code, code, file);
  }
  const mismatch = await post(script, { hostId: owner.id });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "workspace_host_mismatch");
  const get = await h.file(local.id, script, "open-native");
  assert.equal(get.status, 400);
  assert.equal((await get.json()).code, "invalid_request_type");
});
