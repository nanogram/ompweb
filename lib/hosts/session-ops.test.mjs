import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { sessionOps } = await import("./session-ops.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** Throwaway agent dir holding one fixture session (as in session-reader.test.mjs). */
function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ops-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id: SESSION_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "test", model: "m", content: [{ type: "text", text: "hi" }] } },
  ];
  writeFileSync(join(projectDir, "2026-01-01_fixture.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
}

const options = { deferThinking: false, deferMedia: false };

test("readSession returns the session's info and context", () => withAgentDir(async () => {
  const result = await sessionOps.readSession(SESSION_ID, options);
  assert.equal(result.ok, true);
  assert.equal(result.value.info.id, SESSION_ID);
  assert.ok(result.value.context.messages.length > 0);
}));

test("readSession of an unknown id is a 404", () => withAgentDir(async () => {
  const result = await sessionOps.readSession("missing", options);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "session_not_found");
}));

test("readMedia rejects a hash that is not 64 lowercase hex chars", () => withAgentDir(async () => {
  const result = await sessionOps.readMedia("x");
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
}));

test("readMedia returns stored bytes and 404s a missing blob", () => withAgentDir(async () => {
  const hash = "a".repeat(64);
  assert.equal((await sessionOps.readMedia(hash)).status, 404);
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "blobs"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "blobs", hash), "bytes");
  const result = await sessionOps.readMedia(hash);
  assert.equal(result.ok, true);
  assert.ok(result.value instanceof Uint8Array);
  assert.equal(Buffer.from(result.value).toString(), "bytes");
}));

test("renameSessionFile renames the session in listSessions", () => withAgentDir(async () => {
  assert.deepEqual(await sessionOps.renameSessionFile(SESSION_ID, "Renamed"), { ok: true, value: null });
  const session = (await sessionOps.listSessions()).find((s) => s.id === SESSION_ID);
  assert.equal(session?.name, "Renamed");
  assert.equal((await sessionOps.renameSessionFile("missing", "x")).status, 404);
}));

test("recent readSession and async readContext produce serializable bounded pages and boundaries", () => withAgentDir(async () => {
  const initial = await sessionOps.readSession(SESSION_ID, {});
  const file = initial.value.filePath;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    type: "message", id: `tail-${index}`, parentId: index ? `tail-${index - 1}` : "a1",
    message: { role: "user", content: `tail ${index}` },
  }));
  appendFileSync(file, entries.map(JSON.stringify).join("\n") + "\n");
  const recent = await sessionOps.readSession(SESSION_ID, { recent: true, paged: true });
  assert.equal(recent.ok, true);
  assert.deepEqual(recent.value.context.entryIds, entries.slice(-50).map(entry => entry.id));
  assert.equal(recent.value.info.messageCount, 102);
  assert.equal(recent.value.hasOlder, true);
  const boundary = await sessionOps.readContext(SESSION_ID, undefined, { boundary: true });
  assert.equal(boundary.ok, true);
  assert.equal(boundary.value.entryIds.length, 102);
  assert.deepEqual(JSON.parse(JSON.stringify(boundary)).value, boundary.value, "no Promise crosses the host link");
  const older = await sessionOps.readContext(SESSION_ID, undefined, {
    sync: { cursor: recent.value.cursor, limit: 50, recent: true, older: true },
  });
  assert.equal(older.value.history.mode, "prepend");
  assert.deepEqual(older.value.history.context.entryIds, entries.slice(0, 50).map(entry => entry.id));
  assert.deepEqual(JSON.parse(JSON.stringify(older)).value, older.value);
  const legacy = await sessionOps.readSession(SESSION_ID, {});
  assert.equal(legacy.value.context.messages.length, 102);
  assert.equal("cursor" in legacy.value, false);
}));

test("canonical thinking reads still access historical branches without rewriting bytes", () => withAgentDir(async () => {
  const initial = await sessionOps.readSession(SESSION_ID, {});
  const file = initial.value.filePath;
  appendFileSync(file, JSON.stringify({
    type: "message", id: "thinking-branch", parentId: "u1",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "historical thinking" }] },
  }) + "\n" + JSON.stringify({
    type: "message", id: "other-branch", parentId: "u1", message: { role: "user", content: "current branch" },
  }) + "\n");
  const bytes = readFileSync(file);
  const result = await sessionOps.readThinking(SESSION_ID, "thinking-branch", 0);
  assert.deepEqual(result, { ok: true, value: { thinking: "historical thinking" } });
  assert.deepEqual(readFileSync(file), bytes);
}));
