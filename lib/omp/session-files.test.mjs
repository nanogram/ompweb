import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let isolatedFresh = 0;
const { loadSessionFile, loadSessionFileAsync, matchesSessionFileSnapshot, serializeTitleSlot, MAX_SESSION_LOAD_BYTES } = await import("./session-files.ts");
const CHUNK_BYTES = 1024 * 1024;
const header = { type: "session", version: 3, id: "async-loader", cwd: "/project" };

function fixture(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-async-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  if (body !== undefined) writeFileSync(file, body);
  return { dir, file };
}

function message(id, content) {
  return { type: "message", id, parentId: null, message: { role: "user", content } };
}

function normalizeMigratedIds(loaded) {
  const ids = new Map(loaded.entries.map((entry, index) => [entry.id, `entry-${index}`]));
  return {
    ...loaded,
    entries: loaded.entries.map((entry) => ({
      ...entry,
      id: ids.get(entry.id),
      parentId: entry.parentId === null ? null : ids.get(entry.parentId),
      ...(entry.firstKeptEntryId ? { firstKeptEntryId: ids.get(entry.firstKeptEntryId) } : {}),
    })),
  };
}

test("async loading preserves title slots, lenient lines, UTF-8 and physical projection ranges", async (t) => {
  const slot = serializeTitleSlot({ title: "Async title 界", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" });
  const prefix = slot + JSON.stringify({ ...header, title: "old title", titleSource: "auto" }) + "\r\n";
  const entryPrefix = '{"type":"message","id":"utf8","parentId":null,"message":{"role":"user","content":"';
  const padding = "x".repeat(CHUNK_BYTES - 1 - Buffer.byteLength(prefix + entryPrefix));
  const first = entryPrefix + padding + '界末尾"}}\r\n';
  const last = JSON.stringify(message("last", "valid without trailing LF"));
  const body = Buffer.concat([Buffer.from(prefix + first + '{"torn":\n'), Buffer.from([0xff, 10]), Buffer.from(last)]);
  const { file } = fixture(t, body);
  const expectedRanges = [
    [Buffer.byteLength(prefix), Buffer.byteLength(first) - 1],
    [body.length - Buffer.byteLength(last), Buffer.byteLength(last)],
  ];
  const scans = [];
  for (const load of [loadSessionFile, loadSessionFileAsync]) {
    const ranges = [];
    const loaded = await load(file, {
      projectEntry(entry, offset, length, recordSha256) {
        assert.equal(recordSha256, undefined, "ordinary reads do not request record digests");
        ranges.push([offset, length]);
        assert.equal(JSON.parse(body.subarray(offset, offset + length).toString("utf8")).id, entry.id);
        return entry;
      },
    });
    assert.deepEqual(ranges, expectedRanges);
    assert.equal(loaded.header.title, "Async title 界");
    assert.equal(loaded.header.titleSource, "user");
    assert.ok(loaded.entries[0].message.content.endsWith("界末尾"));
    scans.push(loaded);
  }
  assert.deepEqual(scans[1], scans[0]);
  assert.deepEqual(await loadSessionFileAsync(file), loadSessionFile(file));
});

test("async loading preserves legacy migrations, cleared titles, and malformed-file lenience", async (t) => {
  for (const version of [1, 2, 3]) {
    const entries = [
      { ...message("one", "first"), message: { role: "hookMessage", content: "legacy" } },
      message("two", "kept"),
      { type: "compaction", id: "compact", parentId: "two", summary: "summary", ...(version === 1 ? { firstKeptEntryIndex: 2 } : { firstKeptEntryId: "two" }) },
    ];
    if (version === 1) for (const entry of entries) { delete entry.id; delete entry.parentId; }
    const slot = serializeTitleSlot({ title: "", updatedAt: "2026-01-01T00:00:00.000Z" });
    const { file } = fixture(t, slot + [JSON.stringify({ ...header, version, title: "cleared", titleSource: "auto" }), ...entries.map((entry) => JSON.stringify(entry)), '{"unfinished":'].join("\n"));
    const expected = loadSessionFile(file);
    const actual = await loadSessionFileAsync(file);
    assert.deepEqual(version === 1 ? normalizeMigratedIds(actual) : actual, version === 1 ? normalizeMigratedIds(expected) : expected);
    assert.equal(actual.header.title, undefined);
    assert.equal(actual.header.titleSource, undefined);
    assert.equal(actual.header.version, 3);
    if (version < 3) assert.equal(actual.entries[0].message.role, "custom");
    if (version === 1) assert.equal(actual.entries[2].firstKeptEntryId, actual.entries[1].id);
  }
  for (const body of [undefined, "", "not JSON\n", JSON.stringify(message("no-header", "invalid file"))]) {
    const { file } = fixture(t, body);
    assert.deepEqual(await loadSessionFileAsync(file), loadSessionFile(file));
  }
});

test("async loading retains blob resolution and tool-result skip semantics", async (t) => {
  const hash = "a".repeat(64);
  const missing = "b".repeat(64);
  const image = (value) => ({ type: "image", mimeType: "image/png", data: `blob:sha256:${value}` });
  const body = [header,
    { ...message("user", [image(hash), image(missing)]) },
    { ...message("tool", [image(hash)]), message: { role: "toolResult", content: [image(hash)] } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const { dir, file } = fixture(t, body);
  mkdirSync(join(dir, "blobs"));
  writeFileSync(join(dir, "blobs", hash), "image bytes");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  for (const options of [{}, { resolveBlobs: true }, { resolveBlobs: true, skipToolResultImages: true }]) {
    const loaded = await loadSessionFileAsync(file, options);
    assert.deepEqual(loaded, loadSessionFile(file, options));
    if (options.resolveBlobs) {
      assert.equal(loaded.entries[0].message.content[0].data, Buffer.from("image bytes").toString("base64"));
      assert.equal(loaded.entries[0].message.content[1].type, "text");
      assert.equal(loaded.entries[1].message.content[0].data, options.skipToolResultImages ? `blob:sha256:${hash}` : Buffer.from("image bytes").toString("base64"));
    }
  }
});

test("projected scans service queued event-loop work before finishing, and exclude later appends", async (t) => {
  const entries = Array.from({ length: 64 }, (_, index) => message(`entry-${index}`, "x".repeat(64 * 1024)));
  const { file } = fixture(t, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  let projected = 0;
  let projectedAtImmediate;
  const loaded = await loadSessionFileAsync(file, {
    projectEntry(entry) {
      projected++;
      if (projected === 1) {
        setImmediate(() => { projectedAtImmediate = projected; });
        appendFileSync(file, JSON.stringify(message("appended-during-scan", "next snapshot")) + "\n");
      }
      return { type: entry.type, id: entry.id, parentId: entry.parentId };
    },
  });
  assert.equal(loaded.entries.length, entries.length);
  assert.deepEqual(loaded.entries.map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.ok(projectedAtImmediate > 0 && projectedAtImmediate < entries.length, "queued work must run in the middle of parsing, not merely before/after it");
  assert.equal((await loadSessionFileAsync(file, { projectEntry: (entry) => ({ type: entry.type, id: entry.id }) })).entries.at(-1).id, "appended-during-scan");
});

test("async handle cleanup covers read/stat failures, budget stops and projected files above 1 GiB", async (t) => {
  let nextHandle;
  const openOverride = async () => nextHandle;
  await mockBuiltin(t, "node:fs/promises", { open: openOverride });
  const { loadSessionFileAsync: load, matchesSessionFileSnapshot: matches } = await import(`./session-files.ts?fresh=${isolatedFresh++}`);
  const body = Buffer.from([header, message("one", "text")].map((entry) => JSON.stringify(entry)).join("\n"));
  for (const mode of ["normal", "snapshot-short", "stat-failure", "read-failure", "full-budget", "projected-large", "projection-budget", "projection-error", "record-budget"]) {
    let closed = 0;
    let reads = 0;
    let snapshot;
    const callbackError = new Error("projection failed");
    nextHandle = {
      async stat() {
        if (mode === "stat-failure") throw new Error("stat failed");
        return { size: ["full-budget", "projected-large"].includes(mode) ? MAX_SESSION_LOAD_BYTES + 1 : mode === "record-budget" ? 34 * CHUNK_BYTES : mode === "snapshot-short" ? body.length + 1 : body.length };
      },
      async read(buffer, offset, length, position) {
        reads++;
        if (mode === "read-failure") throw new Error("read failed");
        if (mode === "record-budget") {
          buffer.fill(120, offset, offset + length);
          return { bytesRead: length, buffer };
        }
        const bytesRead = Math.min(length, Math.max(0, body.length - position));
        body.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead, buffer };
      },
      async close() { closed++; },
    };
    const options = mode === "full-budget" ? {} : {
      projectEntry(entry) {
        if (mode === "projection-budget") throw new RangeError("metadata budget");
        if (mode === "projection-error") throw callbackError;
        return entry;
      },
    };
    if (mode === "snapshot-short") options.onSnapshot = (value) => { snapshot = value; };
    if (mode === "projection-error") {
      await assert.rejects(load("virtual.jsonl", options), (error) => error === callbackError);
    } else {
      const loaded = await load("virtual.jsonl", options);
      if (["full-budget", "projection-budget", "record-budget"].includes(mode)) assert.equal(loaded.error, "too_large");
      else if (["stat-failure", "read-failure"].includes(mode)) assert.equal(loaded.header, null);
      else assert.equal(loaded.entries[0].id, "one");
    }
    if (mode === "snapshot-short") {
      assert.equal(snapshot.byteLength, body.length);
      assert.equal(snapshot.size, body.length + 1);
      assert.equal(await matches("virtual.jsonl", snapshot), false, "early EOF is never a certified complete snapshot");
    }
    assert.equal(closed, 1, `${mode}: handle is closed exactly once`);
    if (["stat-failure", "full-budget"].includes(mode)) assert.equal(reads, 0);
    if (mode === "projected-large") assert.ok(reads > 0, "projected reads bypass the full materialization ceiling");
    if (mode === "record-budget") assert.equal(reads, 33, "an unterminated projected record stops at the 32 MiB record budget");
  }
});

test("snapshot digests cover physical bytes across decoder boundaries without retaining them", async (t) => {
  const slot = serializeTitleSlot({ title: "Snapshot title", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" });
  const prefix = Buffer.from(slot + JSON.stringify(header) + "\r\n\n");
  const entryPrefix = '{"type":"message","id":"bytes","parentId":null,"message":{"role":"user","content":"';
  const padding = "x".repeat(CHUNK_BYTES - 1 - prefix.length - Buffer.byteLength(entryPrefix));
  const first = Buffer.concat([
    Buffer.from(entryPrefix + padding + "界"),
    Buffer.from([0xff, 0xe2, 0x82]),
    Buffer.from('"}}\r'),
  ]);
  const last = Buffer.from(JSON.stringify(message("last", "without LF")));
  const body = Buffer.concat([prefix, first, Buffer.from("\n\n{torn\n"), last]);
  const { file } = fixture(t, body);
  const projected = [];
  let snapshot;
  const loaded = await loadSessionFileAsync(file, {
    onSnapshot(value) { snapshot = value; },
    projectEntry(entry, offset, length, recordSha256) {
      projected.push({ id: entry.id, offset, length, recordSha256 });
      return entry;
    },
  });
  assert.equal(loaded.header.title, "Snapshot title");
  assert.ok(loaded.entries[0].message.content.endsWith("界\ufffd\ufffd"));
  assert.deepEqual(projected, [
    { id: "bytes", offset: prefix.length, length: first.length, recordSha256: createHash("sha256").update(first).digest("hex") },
    { id: "last", offset: body.length - last.length, length: last.length, recordSha256: createHash("sha256").update(last).digest("hex") },
  ]);
  assert.deepEqual(Object.keys(snapshot).sort(), ["byteLength", "ctimeMs", "dev", "ino", "mtimeMs", "sha256", "size"]);
  assert.equal(snapshot.size, body.length);
  assert.equal(snapshot.byteLength, body.length);
  assert.equal(snapshot.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
});

test("a captured scan validates append-only growth and the next scan discovers appended records", async (t) => {
  const entries = Array.from({ length: 40 }, (_, index) => message(`old-${index}`, "x".repeat(64 * 1024)));
  const body = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const { file } = fixture(t, body);
  let snapshot;
  let appended = false;
  const loaded = await loadSessionFileAsync(file, {
    onSnapshot(value) { snapshot = value; },
    projectEntry(entry) {
      if (!appended) {
        appended = true;
        appendFileSync(file, JSON.stringify(message("new", "next snapshot")) + "\n");
      }
      return { type: entry.type, id: entry.id };
    },
  });
  assert.deepEqual(loaded.entries.map((entry) => entry.id), entries.map((entry) => entry.id));
  assert.equal(snapshot.size, Buffer.byteLength(body));
  assert.equal(snapshot.byteLength, Buffer.byteLength(body));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
  assert.equal(yielded, true, "prefix verification cooperates with event-loop work");
  assert.equal((await loadSessionFileAsync(file)).entries.at(-1).id, "new");
  appendFileSync(file, JSON.stringify(message("newer", "another append")) + "\n");
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
});

test("snapshot prefix validation rejects rewrites, append plus rewrite, truncation, replacement and removal", async (t) => {
  const body = [header, message("old", "original")].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const appended = JSON.stringify(message("new", "appended")) + "\n";
  for (const mode of ["rewrite", "append-rewrite", "truncate", "replace", "remove"]) {
    const { file, dir } = fixture(t, body);
    let snapshot;
    await loadSessionFileAsync(file, { onSnapshot(value) { snapshot = value; } });
    if (mode === "rewrite") writeFileSync(file, body.replace("original", "modified"));
    if (mode === "append-rewrite") writeFileSync(file, body.replace("original", "modified") + appended);
    if (mode === "truncate") writeFileSync(file, body.slice(0, -2));
    if (mode === "replace") {
      renameSync(file, join(dir, "old-inode.jsonl"));
      writeFileSync(file, body + appended);
    }
    if (mode === "remove") rmSync(file);
    assert.equal(await matchesSessionFileSnapshot(file, snapshot), false, mode);
  }
});

test("failed and malformed asynchronous scans do not publish snapshots", async (t) => {
  for (const body of [undefined, "", "not JSON\n", JSON.stringify(message("missing-header", "invalid"))]) {
    const { file } = fixture(t, body);
    let captures = 0;
    await loadSessionFileAsync(file, { onSnapshot() { captures++; } });
    assert.equal(captures, 0);
  }
  const { file } = fixture(t, [header, message("one", "text")].map((entry) => JSON.stringify(entry)).join("\n"));
  let captures = 0;
  const loaded = await loadSessionFileAsync(file, {
    onSnapshot() { captures++; },
    projectEntry() { throw new RangeError("metadata budget"); },
  });
  assert.equal(loaded.error, "too_large");
  assert.equal(captures, 0);
});

test("record digests preserve CR and LF boundaries at either side of a read chunk", async (t) => {
  const prefix = JSON.stringify(header) + "\n";
  const base = JSON.stringify(message("boundary", ""));
  const last = JSON.stringify(message("last", "after empty line"));
  for (const delta of [-1, 0, 1]) {
    const entry = JSON.stringify(message("boundary", "x".repeat(CHUNK_BYTES + delta - Buffer.byteLength(prefix + base + "\r")))) + "\r";
    const body = Buffer.from(prefix + entry + "\n\n" + last);
    const { file } = fixture(t, body);
    const digests = [];
    await loadSessionFileAsync(file, {
      onSnapshot() {},
      projectEntry(value, offset, length, digest) {
        digests.push([value.id, digest]);
        assert.equal(digest, createHash("sha256").update(body.subarray(offset, offset + length)).digest("hex"));
        return value;
      },
    });
    assert.deepEqual(digests, [
      ["boundary", createHash("sha256").update(entry).digest("hex")],
      ["last", createHash("sha256").update(last).digest("hex")],
    ]);
  }
});

test("snapshot verification closes handles on success, read errors and every early rejection", async (t) => {
  let nextHandle;
  let nextStat;
  const openOverride = async () => nextHandle;
  const statOverride = async () => {
    if (nextStat instanceof Error) throw nextStat;
    return nextStat;
  };
  await mockBuiltin(t, "node:fs/promises", { open: openOverride, stat: statOverride });
  const { matchesSessionFileSnapshot: matches } = await import(`./session-files.ts?fresh=${isolatedFresh++}`);
  const body = Buffer.from("snapshot bytes\n");
  const version = { dev: 1, ino: 2, size: body.length, mtimeMs: 3, ctimeMs: 4 };
  const snapshot = { ...version, byteLength: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  for (const mode of ["normal", "identity", "shrink", "rewrite", "stat-error", "read-error", "short-read", "digest", "path-replace", "path-error", "final-shrink"]) {
    let closed = 0;
    let stats = 0;
    nextStat = mode === "path-error" ? new Error("path stat failed") : { ...version, ...(mode === "path-replace" ? { ino: 9 } : {}) };
    nextHandle = {
      async stat() {
        stats++;
        if (mode === "stat-error") throw new Error("handle stat failed");
        return {
          ...version,
          ...(mode === "identity" ? { ino: 9 } : {}),
          ...(mode === "shrink" || (mode === "final-shrink" && stats > 1) ? { size: body.length - 1 } : {}),
          ...(mode === "rewrite" ? { mtimeMs: 99 } : {}),
        };
      },
      async read(buffer, offset, length, position) {
        if (mode === "read-error") throw new Error("read failed");
        const end = mode === "short-read" ? body.length - 1 : body.length;
        const bytesRead = Math.min(length, Math.max(0, end - position));
        body.copy(buffer, offset, position, position + bytesRead);
        if (mode === "digest" && bytesRead) buffer[offset] ^= 1;
        return { bytesRead, buffer };
      },
      async close() { closed++; },
    };
    assert.equal(await matches("virtual.jsonl", snapshot), mode === "normal", mode);
    assert.equal(closed, 1, `${mode}: handle closes exactly once`);
  }
});

test("append plus rewriting an already-scanned prefix never validates as append-only", async (t) => {
  const entries = Array.from({ length: 40 }, (_, index) => message(`entry-${index}`, index === 0 ? "original" : "x".repeat(64 * 1024)));
  const body = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const { file } = fixture(t, body);
  let snapshot;
  let changed = false;
  const loaded = await loadSessionFileAsync(file, {
    onSnapshot(value) { snapshot = value; },
    projectEntry(entry) {
      if (!changed) {
        changed = true;
        writeFileSync(file, body.replace("original", "modified") + JSON.stringify(message("appended", "new")) + "\n");
      }
      return { type: entry.type, id: entry.id };
    },
  });
  assert.equal(loaded.entries.length, entries.length);
  assert.equal(snapshot.byteLength, Buffer.byteLength(body));
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), false);
});

test("tail windows preserve exact JSONL boundaries, actual headers and absolute UTF-8/CRLF ranges", async (t) => {
  const slot = serializeTitleSlot({ title: "Window title 界", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" });
  const head = slot + JSON.stringify({ ...header, cwd: "/actual-project", title: "stale" }) + "\r\n";
  const omitted = JSON.stringify(message("omitted", "x".repeat(700))) + "\r\n";
  const first = JSON.stringify(message("first", "界🙂é")) + "\r\n";
  const last = JSON.stringify(message("last", "last complete record"));
  const body = Buffer.from(head + omitted + first + last);
  const firstOffset = Buffer.byteLength(head + omitted);
  const lastOffset = firstOffset + Buffer.byteLength(first);
  const { file } = fixture(t, body);
  for (const [start, ids] of [
    [firstOffset - 1, ["first", "last"]],
    [firstOffset, ["first", "last"]],
    [firstOffset + 1, ["last"]],
    [firstOffset + Buffer.byteLength(first) - 2, ["last"]],
    [lastOffset - 1, ["last"]],
    [lastOffset, ["last"]],
    [lastOffset + 1, []],
  ]) {
    const ranges = [];
    let snapshot;
    const loaded = await loadSessionFileAsync(file, {
      historyWindowBytes: body.length - start,
      onSnapshot(value) { snapshot = value; },
      projectEntry(entry, offset, length, digest) {
        ranges.push([entry.id, offset, length]);
        const raw = body.subarray(offset, offset + length);
        assert.equal(JSON.parse(raw.toString("utf8")).id, entry.id);
        assert.equal(digest, createHash("sha256").update(raw).digest("hex"));
        return entry;
      },
    });
    assert.deepEqual(loaded.entries.map((entry) => entry.id), ids, `start ${start}`);
    assert.deepEqual(ranges, ids.map((id) => id === "first"
      ? [id, firstOffset, Buffer.byteLength(first) - 1]
      : [id, lastOffset, Buffer.byteLength(last)]));
    assert.equal(loaded.header.id, header.id);
    assert.equal(loaded.header.cwd, "/actual-project");
    assert.equal(loaded.header.title, "Window title 界");
    assert.equal(loaded.header.titleSource, "user");
    assert.deepEqual(loaded.historyWindow, { maxBytes: body.length - start, startOffset: start, endOffset: body.length });
    assert.equal(snapshot.byteOffset, start - 1, "the framing byte is covered by the range digest");
    assert.equal(snapshot.byteOffset + snapshot.byteLength, snapshot.windowEnd);
    assert.equal(snapshot.sha256, createHash("sha256").update(body.subarray(start - 1)).digest("hex"));
    assert.equal(snapshot.headerByteLength, Buffer.byteLength(head));
    assert.equal(snapshot.headerSha256, createHash("sha256").update(head).digest("hex"));
    assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
  }
  for (const maxBytes of [body.length, body.length + 1]) {
    const loaded = await loadSessionFileAsync(file, { historyWindowBytes: maxBytes });
    assert.deepEqual(loaded, loadSessionFile(file), "a non-omitting bound preserves the unbounded shape");
    assert.equal(loaded.historyWindow, undefined);
  }
  assert.deepEqual(readFileSync(file), body, "loading never modifies the canonical transcript");
});

test("a cut leading record cannot manufacture a valid-looking JSON suffix or context", async (t) => {
  const head = JSON.stringify(header) + "\n";
  const fake = JSON.stringify(message("not-a-record", "valid JSON inside a malformed physical record"));
  const last = JSON.stringify(message("real", "retained")) + "\n";
  const prefix = head + "malformed-prefix ";
  const body = Buffer.from(prefix + fake + "\n" + last);
  const { file } = fixture(t, body);
  const loaded = await loadSessionFileAsync(file, { historyWindowBytes: body.length - Buffer.byteLength(prefix) });
  assert.deepEqual(loaded.entries.map((entry) => entry.id), ["real"]);
  for (const tail of ["unterminated", '{"type":"message","id":"torn"', "界🙂\r"]) {
    writeFileSync(file, head + "x".repeat(500) + tail);
    const empty = await loadSessionFileAsync(file, { historyWindowBytes: Buffer.byteLength(tail) });
    assert.equal(empty.header.id, header.id);
    assert.deepEqual(empty.entries, []);
    assert.ok(empty.historyWindow);
  }
});

test("tail reads and verification never scan an omitted oversized physical record", async (t) => {
  const head = Buffer.from(JSON.stringify(header) + "\n");
  const tail = Buffer.from([message("kept-one", "界"), message("kept-two", "tail")].map((entry) => JSON.stringify(entry)).join("\r\n") + "\r\n");
  const start = 40 * CHUNK_BYTES;
  const size = start + tail.length;
  const version = { dev: 1, ino: 2, size, mtimeMs: 3, ctimeMs: 4 };
  const ending = Buffer.concat([Buffer.from("\n"), tail]);
  const segments = [{ position: 0, bytes: head }, { position: start - 1, bytes: ending }];
  const reads = [];
  let closed = 0;
  const openOverride = async () => ({
    async stat() { return version; },
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(length, Math.max(0, size - position));
      reads.push([position, bytesRead]);
      buffer.fill(120, offset, offset + bytesRead);
      for (const segment of segments) {
        const from = Math.max(position, segment.position);
        const to = Math.min(position + bytesRead, segment.position + segment.bytes.length);
        if (from < to) segment.bytes.copy(buffer, offset + from - position, from - segment.position, to - segment.position);
      }
      return { bytesRead, buffer };
    },
    async close() { closed++; },
  });
  const statOverride = async () => version;
  await mockBuiltin(t, "node:fs/promises", { open: openOverride, stat: statOverride });
  const { loadSessionFileAsync: load, matchesSessionFileSnapshot: matches } = await import(`./session-files.ts?fresh=${isolatedFresh++}`);
  let snapshot;
  const loaded = await load("virtual-tail.jsonl", {
    historyWindowBytes: tail.length,
    onSnapshot(value) { snapshot = value; },
    projectEntry(entry, offset, length) {
      assert.ok(offset >= start);
      assert.equal(JSON.parse(tail.subarray(offset - start, offset - start + length).toString("utf8")).id, entry.id);
      return entry;
    },
  });
  assert.deepEqual(loaded.entries.map((entry) => entry.id), ["kept-one", "kept-two"]);
  assert.equal(snapshot.byteOffset, start - 1);
  assert.equal(snapshot.byteLength, tail.length + 1);
  assert.equal(snapshot.size, size);
  assert.equal(snapshot.headerByteLength, head.length);
  assert.ok(reads.every(([position, length]) => position + length <= 64 * 1024 + 256 || position >= start - 1));
  assert.ok(reads.reduce((total, [, length]) => total + length, 0) <= tail.length + 1 + 64 * 1024 + 256);
  reads.length = 0;
  assert.equal(await matches("virtual-tail.jsonl", snapshot), true);
  assert.deepEqual(reads, [[start - 1, tail.length + 1], [0, head.length]]);
  assert.equal(closed, 2);
});

test("tail windows migrate v1/v2 without resolving absolute indices against the local suffix", async (t) => {
  for (const version of [1, 2]) {
    const old = Array.from({ length: 8 }, (_, index) => message(`old-${index}`, "omitted"));
    const kept = [
      { ...message("kept", "legacy"), parentId: "old-7", message: { role: "hookMessage", content: "legacy" } },
      { type: "compaction", id: "compact", parentId: "kept", summary: "retained summary", ...(version === 1 ? { firstKeptEntryIndex: 1 } : { firstKeptEntryId: "old-0" }) },
      message("last", "retained"),
    ];
    if (version === 1) for (const entry of [...old, ...kept]) { delete entry.id; delete entry.parentId; }
    const prefix = [JSON.stringify({ ...header, version }), ...old.map((entry) => JSON.stringify(entry))].join("\n") + "\n";
    const tail = kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const body = prefix + tail;
    const { file } = fixture(t, body);
    const offsets = kept.map((_, index) => Buffer.byteLength(prefix + kept.slice(0, index).map((entry) => JSON.stringify(entry) + "\n").join("")));
    const first = await loadSessionFileAsync(file, { historyWindowBytes: Buffer.byteLength(tail) });
    const second = await loadSessionFileAsync(file, { historyWindowBytes: Buffer.byteLength(tail) - (offsets[1] - offsets[0]) });
    assert.equal(first.header.version, 3);
    assert.equal(first.entries[0].message.role, "custom");
    if (version === 1) {
      assert.deepEqual(first.entries.map((entry) => entry.id), offsets.map((offset) => `v1-${offset.toString(36)}`));
      assert.deepEqual(first.entries.map((entry) => entry.parentId), [null, first.entries[0].id, first.entries[1].id]);
      assert.equal(first.entries[1].firstKeptEntryIndex, undefined);
      assert.equal(first.entries[1].firstKeptEntryId, undefined, "absolute index 1 points to an omitted row, not local row 1");
      assert.deepEqual(second.entries.map((entry) => entry.id), first.entries.slice(1).map((entry) => entry.id));
      const full = await loadSessionFileAsync(file);
      assert.equal(full.entries[9].firstKeptEntryId, full.entries[0].id, "unbounded migration keeps its absolute-index convention");
      assert.ok(full.entries.every((entry) => !entry.id.startsWith("v1-")));
    } else {
      assert.deepEqual(first.entries.map((entry) => entry.id), ["kept", "compact", "last"]);
      assert.equal(first.entries[0].parentId, "old-7", "missing ancestors remain missing");
      assert.equal(first.entries[1].firstKeptEntryId, "old-0");
    }
    assert.equal(readFileSync(file, "utf8"), body);
  }
});

test("pinned tail snapshots retain actual size and recover torn writes only on a later unpinned load", async (t) => {
  const prefix = JSON.stringify(header) + "\n" + JSON.stringify(message("omitted", "x".repeat(600))) + "\n";
  const kept = JSON.stringify(message("kept", "complete")) + "\n";
  const pending = JSON.stringify(message("recovered", "界 completed later")) + "\n";
  const cut = pending.indexOf("completed");
  const initial = prefix + kept + pending.slice(0, cut);
  const initialEnd = Buffer.byteLength(initial);
  const windowBytes = Buffer.byteLength(kept + pending);
  const { file } = fixture(t, initial);
  let initialSnapshot;
  const first = await loadSessionFileAsync(file, { historyWindowBytes: windowBytes, onSnapshot(value) { initialSnapshot = value; } });
  assert.deepEqual(first.entries.map((entry) => entry.id), ["kept"]);
  appendFileSync(file, pending.slice(cut));
  assert.equal(await matchesSessionFileSnapshot(file, initialSnapshot), true);
  let pinnedSnapshot;
  const pinned = await loadSessionFileAsync(file, {
    historyWindowBytes: windowBytes,
    historyWindowEnd: initialEnd,
    onSnapshot(value) { pinnedSnapshot = value; },
  });
  assert.deepEqual(pinned, first);
  assert.equal(pinnedSnapshot.size, Buffer.byteLength(prefix + kept + pending));
  assert.equal(pinnedSnapshot.windowEnd, initialEnd);
  assert.equal(pinnedSnapshot.byteOffset + pinnedSnapshot.byteLength, initialEnd);
  assert.equal(await matchesSessionFileSnapshot(file, pinnedSnapshot), true);
  const latest = await loadSessionFileAsync(file, { historyWindowBytes: windowBytes });
  assert.deepEqual(latest.entries.map((entry) => entry.id), ["kept", "recovered"]);
  appendFileSync(file, JSON.stringify(message("later", "append")) + "\n");
  assert.equal(await matchesSessionFileSnapshot(file, pinnedSnapshot), true);
  assert.equal(await matchesSessionFileSnapshot(file, { ...pinnedSnapshot, byteLength: pinnedSnapshot.byteLength - 1 }), false);
});

test("tail snapshots reject retained/header/framing rewrites, shrinkage and replacement but ignore omitted rewrites with appends", async (t) => {
  const slot = serializeTitleSlot({ title: "Window title", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" });
  const prefix = slot + JSON.stringify(header) + "\n" + JSON.stringify(message("omitted", "old-prefix " + "x".repeat(600))) + "\n";
  const retained = JSON.stringify(message("kept", "original")) + "\n";
  const future = JSON.stringify(message("future", "beyond pinned end")) + "\n";
  const body = prefix + retained + future;
  const end = Buffer.byteLength(prefix + retained);
  const appended = JSON.stringify(message("appended", "after snapshot")) + "\n";
  for (const mode of ["retained", "header", "framing", "same-size", "truncate", "replace", "omitted"]) {
    const { file, dir } = fixture(t, body);
    let snapshot;
    await loadSessionFileAsync(file, {
      historyWindowBytes: Buffer.byteLength(retained),
      historyWindowEnd: end,
      onSnapshot(value) { snapshot = value; },
    });
    if (mode === "retained") writeFileSync(file, body.replace("original", "modified") + appended);
    if (mode === "header") writeFileSync(file, body.replace("Window title", "Change title") + appended);
    if (mode === "framing") {
      const rewritten = Buffer.from(body);
      rewritten[Buffer.byteLength(prefix) - 1] = 32;
      writeFileSync(file, Buffer.concat([rewritten, Buffer.from(appended)]));
    }
    if (mode === "same-size") writeFileSync(file, body.replace("original", "modified"));
    if (mode === "truncate") writeFileSync(file, prefix + retained);
    if (mode === "replace") {
      renameSync(file, join(dir, "previous-inode.jsonl"));
      writeFileSync(file, body + appended);
    }
    if (mode === "omitted") writeFileSync(file, body.replace("old-prefix", "new-prefix") + appended);
    assert.equal(await matchesSessionFileSnapshot(file, snapshot), mode === "omitted", mode);
  }
});

test("a short bounded read is loadable but cannot certify its selected end", async (t) => {
  const head = Buffer.from(JSON.stringify(header) + "\n");
  const omitted = Buffer.from(JSON.stringify(message("omitted", "x".repeat(500))) + "\n");
  const tail = Buffer.from(JSON.stringify(message("retained", "last without LF")));
  const body = Buffer.concat([head, omitted, tail]);
  const version = { dev: 1, ino: 2, size: body.length + 1, mtimeMs: 3, ctimeMs: 4 };
  let closed = 0;
  const openOverride = async () => ({
    async stat() { return version; },
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(length, Math.max(0, body.length - position));
      body.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    async close() { closed++; },
  });
  await mockBuiltin(t, "node:fs/promises", { open: openOverride });
  const { loadSessionFileAsync: load, matchesSessionFileSnapshot: matches } = await import(`./session-files.ts?fresh=${isolatedFresh++}`);
  let snapshot;
  const loaded = await load("virtual-short-tail.jsonl", {
    historyWindowBytes: tail.length + 1,
    onSnapshot(value) { snapshot = value; },
  });
  assert.deepEqual(loaded.entries.map((entry) => entry.id), ["retained"]);
  assert.equal(snapshot.byteOffset, head.length + omitted.length - 1);
  assert.equal(snapshot.byteOffset + snapshot.byteLength, body.length);
  assert.equal(snapshot.windowEnd, body.length + 1);
  assert.equal(await matches("virtual-short-tail.jsonl", snapshot), false);
  assert.equal(closed, 1, "incomplete coverage is rejected without opening another handle");
});

test("bounded header probes never search through oversized or malformed headers", async (t) => {
  for (const slot of ["", serializeTitleSlot({ title: "title", updatedAt: "2026-01-01T00:00:00.000Z" })]) {
    const body = slot + JSON.stringify({ ...header, oversized: "x".repeat(70 * 1024) }) + "\n" + JSON.stringify(message("tail", "not a header")) + "\n";
    const { file } = fixture(t, body);
    let captures = 0;
    const loaded = await loadSessionFileAsync(file, { historyWindowBytes: 200, onSnapshot() { captures++; } });
    assert.equal(loaded.header, null);
    assert.deepEqual(loaded.entries, []);
    assert.equal(captures, 0);
  }
});

test("tail UTF-8 decoding crosses read chunks and a scan never absorbs concurrent appends", async (t) => {
  const prefix = JSON.stringify(header) + "\n" + JSON.stringify(message("omitted", "x".repeat(500))) + "\n";
  const entryPrefix = '{"type":"message","id":"utf8","parentId":null,"message":{"role":"user","content":"';
  const first = entryPrefix + "x".repeat(CHUNK_BYTES - 1 - Buffer.byteLength(entryPrefix)) + '界末尾"}}\r\n';
  const last = JSON.stringify(message("last", "finite tail")) + "\r\n";
  const body = Buffer.from(prefix + first + last);
  const windowBytes = Buffer.byteLength(first + last);
  const { file } = fixture(t, body);
  let snapshot;
  let appended = false;
  const loaded = await loadSessionFileAsync(file, {
    historyWindowBytes: windowBytes,
    onSnapshot(value) { snapshot = value; },
    projectEntry(entry, offset, length, digest) {
      assert.equal(digest, createHash("sha256").update(body.subarray(offset, offset + length)).digest("hex"));
      if (!appended) {
        appended = true;
        appendFileSync(file, JSON.stringify(message("appended", "next load")) + "\n");
      }
      return entry;
    },
  });
  assert.deepEqual(loaded.entries.map((entry) => entry.id), ["utf8", "last"]);
  assert.ok(loaded.entries[0].message.content.endsWith("界末尾"));
  assert.equal(snapshot.size, body.length);
  assert.equal(snapshot.windowEnd, body.length);
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
  const next = await loadSessionFileAsync(file, { historyWindowBytes: windowBytes });
  assert.equal(next.entries.at(-1).id, "appended");
});

async function projectedScan(file, previous, windowBytes, windowEnd) {
  const byEntry = new WeakMap((previous?.records ?? []).map((record) => [record.entry, record]));
  const projected = [];
  let snapshot;
  let state;
  const loaded = await loadSessionFileAsync(file, {
    historyWindowBytes: windowBytes,
    historyWindowEnd: windowEnd,
    reuseProjection: previous,
    onSnapshot(value) { snapshot = value; },
    onProjectionState(value) { state = value; },
    projectEntry(entry, offset, length, sha256) {
      projected.push(entry.id);
      const compact = {
        type: entry.type, id: entry.id, parentId: entry.parentId,
        ...(entry.message ? { message: { role: entry.message.role } } : {}),
      };
      byEntry.set(compact, { entry: compact, offset, length, sha256 });
      return compact;
    },
  });
  return {
    loaded, projected,
    reuse: { snapshot, ...state, records: loaded.entries.map((entry) => byEntry.get(entry)) },
  };
}

test("verified projection reuse parses only appended complete records and omits retained bodies", async (t) => {
  const entries = Array.from({ length: 40 }, (_, index) => message(`old-${index}`, "界".repeat(500)));
  const body = [header, ...entries].map(JSON.stringify).join("\n") + "\n";
  const { file } = fixture(t, body);
  const cold = await projectedScan(file);
  assert.equal(cold.projected.length, entries.length);
  const appended = [message("new-one", "next"), message("new-two", "last")];
  appendFileSync(file, appended.map(JSON.stringify).join("\n") + "\n");
  const warm = await projectedScan(file, cold.reuse);
  assert.deepEqual(warm.projected, ["new-one", "new-two"]);
  assert.equal(warm.reuse.resumeOffset, readFileSync(file).length);
  assert.equal(warm.reuse.sourceVersion, 3);
  assert.equal(await matchesSessionFileSnapshot(file, warm.reuse.snapshot), true);
  const quiet = await projectedScan(file, warm.reuse);
  assert.deepEqual(quiet.projected, []);
  assert.ok(quiet.reuse.records.every((record) => record.entry.message.content === undefined));
});

test("rolling projections discard cut records while reusing surviving physical metadata", async (t) => {
  const entries = Array.from({ length: 14 }, (_, index) => message(`row-${String(index).padStart(2, "0")}`, "x".repeat(400)));
  const { file } = fixture(t, [header, ...entries].map(JSON.stringify).join("\n") + "\n");
  const windowBytes = 2400;
  let prior = await projectedScan(file, undefined, windowBytes);
  for (let index = 14; index < 20; index++) {
    const entry = message(`row-${index}`, "x".repeat(400));
    appendFileSync(file, JSON.stringify(entry) + "\n");
    const next = await projectedScan(file, prior.reuse, windowBytes);
    const fresh = await projectedScan(file, undefined, windowBytes);
    assert.deepEqual(next.projected, [entry.id]);
    assert.deepEqual(next.loaded.entries, fresh.loaded.entries);
    const start = readFileSync(file).length - windowBytes;
    assert.ok(next.reuse.records.every((record) => record.offset >= start));
    assert.ok(next.reuse.records.length <= 5, "the reusable graph rolls out with the byte window");
    assert.equal(await matchesSessionFileSnapshot(file, next.reuse.snapshot), true);
    prior = next;
  }
});

test("incremental projections reread torn UTF-8 tails and unterminated valid records", async (t) => {
  const prefix = [header, message("root", "complete")].map(JSON.stringify).join("\n") + "\n";
  const last = Buffer.from(JSON.stringify(message("partial", "界🙂 completed")));
  const split = last.indexOf(Buffer.from("界")) + 1;
  const { file } = fixture(t, Buffer.concat([Buffer.from(prefix), last.subarray(0, split)]));
  const cold = await projectedScan(file);
  assert.deepEqual(cold.projected, ["root"]);
  assert.equal(cold.reuse.resumeOffset, Buffer.byteLength(prefix));
  appendFileSync(file, Buffer.concat([last.subarray(split), Buffer.from("\n" + JSON.stringify(message("next", "next")))]));
  const warm = await projectedScan(file, cold.reuse);
  assert.deepEqual(warm.projected, ["partial", "next"]);
  assert.deepEqual(warm.loaded.entries.map((entry) => entry.id), ["root", "partial", "next"]);
  // Extending valid JSON without a separating LF invalidates that physical
  // record. It must not survive merely because its old prefix was valid JSON.
  appendFileSync(file, "invalid suffix\n" + JSON.stringify(message("after", "after malformed line")) + "\n");
  const finished = await projectedScan(file, warm.reuse);
  assert.deepEqual(finished.projected, ["after"]);
  assert.deepEqual(finished.loaded.entries.map((entry) => entry.id), ["root", "partial", "after"]);
});

test("projection reuse hashes covered old bytes instead of trusting growth or same-size versions", async (t) => {
  for (const append of [false, true]) {
    const body = [header, message("original", "old body")].map(JSON.stringify).join("\n") + "\n";
    const { file } = fixture(t, body);
    const cold = await projectedScan(file);
    writeFileSync(file, body.replace('"id":"original"', '"id":"modified"') +
      (append ? JSON.stringify(message("appended", "new")) + "\n" : ""));
    const warm = await projectedScan(file, cold.reuse);
    assert.deepEqual(warm.loaded.entries.map((entry) => entry.id), append ? ["modified", "appended"] : ["modified"]);
    assert.ok(warm.projected.includes("modified"), "the rewritten old record is reparsed, not sampled or reused");
    assert.notEqual(warm.loaded.entries[0], cold.loaded.entries[0]);
    assert.equal(await matchesSessionFileSnapshot(file, warm.reuse.snapshot), true);
  }
});

test("pinned projected EOF remains finite during append and legacy changes use a fresh migration", async (t) => {
  const body = [header, message("one", "first"), message("two", "second")].map(JSON.stringify).join("\n") + "\n";
  const { file } = fixture(t, body);
  const windowBytes = Buffer.byteLength(body) - 10;
  const cold = await projectedScan(file, undefined, windowBytes);
  appendFileSync(file, JSON.stringify(message("three", "third")) + "\n");
  const pinned = await projectedScan(file, cold.reuse, windowBytes, Buffer.byteLength(body));
  assert.deepEqual(pinned.projected, []);
  assert.deepEqual(pinned.loaded.entries.map((entry) => entry.id), ["one", "two"]);
  assert.equal(pinned.reuse.snapshot.windowEnd, Buffer.byteLength(body));
  const latest = await projectedScan(file, pinned.reuse, windowBytes);
  assert.deepEqual(latest.projected, ["three"]);
  for (const version of [1, 2]) {
    writeFileSync(file, [{ ...header, version }, message("legacy", "old")].map(JSON.stringify).join("\n") + "\n");
    const legacy = await projectedScan(file);
    assert.equal(legacy.reuse.sourceVersion, version, "migration must not erase the source format version");
    appendFileSync(file, JSON.stringify(message("added", "next")) + "\n");
    const changed = await projectedScan(file, legacy.reuse);
    assert.deepEqual(changed.projected, ["legacy", "added"], "legacy state is deliberately rebuilt");
    assert.equal(changed.loaded.entries.length, 2);
  }
});

test("header and fixed-slot title rewrites invalidate reusable projected metadata", async (t) => {
  const slot = serializeTitleSlot({ title: "before", updatedAt: "2026-01-01T00:00:00.000Z" });
  const suffix = [header, message("one", "retained body")].map(JSON.stringify).join("\n") + "\n";
  const { file } = fixture(t, slot + suffix);
  const cold = await projectedScan(file);
  const nextSlot = serializeTitleSlot({ title: "after", updatedAt: "2026-01-01T00:00:00.000Z" });
  writeFileSync(file, nextSlot + suffix);
  const renamed = await projectedScan(file, cold.reuse);
  assert.equal(renamed.loaded.header.title, "after");
  assert.deepEqual(renamed.projected, ["one"], "changed headers cannot reuse an old projected graph");
  assert.notEqual(renamed.loaded.entries[0], cold.loaded.entries[0]);
  writeFileSync(file, nextSlot + suffix.replace('"/project"', '"/changed"'));
  const moved = await projectedScan(file, renamed.reuse);
  assert.equal(moved.loaded.header.cwd, "/changed");
  assert.deepEqual(moved.projected, ["one"]);
});

test("a rejected reuse rebuild resets its projection budget instead of falsely rejecting the valid file", async (t) => {
  const body = [header, message("one", "first"), message("two", "second")].map(JSON.stringify).join("\n") + "\n";
  const { file } = fixture(t, body);
  const cold = await projectedScan(file);
  writeFileSync(file, body.replace('"first"', '"fresh"') + JSON.stringify(message("three", "third")) + "\n");
  let chargedRecords = cold.reuse.records.length;
  let snapshot;
  const loaded = await loadSessionFileAsync(file, {
    reuseProjection: cold.reuse,
    onSnapshot(value) { snapshot = value; },
    onProjectionReset() { chargedRecords = 0; },
    projectEntry(entry) {
      if (++chargedRecords > 3) throw new RangeError("projection budget");
      return entry;
    },
  });
  assert.equal(loaded.error, undefined);
  assert.deepEqual(loaded.entries.map((entry) => entry.id), ["one", "two", "three"]);
  assert.equal(loaded.entries[0].message.content, "fresh");
  assert.equal(await matchesSessionFileSnapshot(file, snapshot), true);
});
