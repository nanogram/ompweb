import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDirectorLock, getDirectorDir, getDirectorStatePath, getDirectorWorkspaceCwd, isDirectorSession, isDirectorWorkspace, mutateDirectorState, newDirectorState, parseDirectorState, readDirectorState } from "./director-state.ts";

function isolated(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-director-state-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const id = "11111111-1111-4111-8111-111111111111";
const info = () => ({ id, path: join(getDirectorDir(), "native.jsonl"), cwd: getDirectorWorkspaceCwd(), hostId: "local", name: "Director", created: "2026-11-08T00:00:00Z", modified: "2026-11-08T00:00:00Z", firstMessage: "Review", messageCount: 1 });

test("missing state is disabled and read-only, never an instruction to create a chat", (t) => {
  isolated(t);
  assert.equal(readDirectorState().config.enabled, false);
  assert.equal(existsSync(getDirectorStatePath()), false);
  assert.equal(isDirectorSession(id), false);
  assert.equal(existsSync(getDirectorDir()), false);
});

test("existing observe-only state migrates without granting control or losing identity and accounting", (t) => {
  isolated(t);
  const legacy = newDirectorState();
  delete legacy.config.controlEnabled;
  legacy.session = info();
  legacy.config.enabled = true;
  legacy.config.watchedProjects = [{ cwd: "/selected", hostId: "local" }];
  legacy.daily.reviews = 3;
  legacy.daily.costUsd = 0.75;
  const migrated = parseDirectorState(JSON.stringify(legacy));
  assert.equal(migrated.config.controlEnabled, false);
  assert.deepEqual(migrated.session, legacy.session);
  assert.deepEqual(migrated.daily, legacy.daily);
  mutateDirectorState((state) => { Object.assign(state, migrated); state.config.controlEnabled = true; });
  assert.equal(readDirectorState().config.controlEnabled, true);
  assert.equal(readDirectorState().session.id, id);
});

test("retiring automation caps preserves the Director, scope, permissions and review ledger", (t) => {
  isolated(t);
  const current = newDirectorState();
  current.session = info();
  current.config.enabled = true;
  current.config.controlEnabled = true;
  current.config.watchedProjects = [{ cwd: "/selected", hostId: "local" }];
  current.daily.reviews = 27;
  current.daily.costUsd = 3.25;
  current.reviewed = { "local/worker": "a".repeat(64) };
  current.inFlight = { id: "review-id", startedAt: 1, phase: "uncertain", runStarted: false, terminalObserved: false };
  const legacy = structuredClone(current);
  legacy.config.dailyBudgetUsd = 2;
  legacy.config.maxReviewsPerDay = 24;
  const migrated = parseDirectorState(JSON.stringify(legacy));
  assert.deepEqual(migrated, current);
  mutateDirectorState((state) => { Object.assign(state, migrated); });
  assert.deepEqual(JSON.parse(readFileSync(getDirectorStatePath(), "utf8")), current);
});

test("atomic state retains exact native identity, creation reservations, cursors and accounting across reload", (t) => {
  isolated(t);
  const state = mutateDirectorState((state) => {
    state.session = info();
    state.config.enabled = true;
    state.config.watchedProjects = [{ cwd: "/selected", hostId: "local" }];
    state.creating = true;
    state.reviewed = { "local/worker": "a".repeat(64) };
    state.daily = { date: "2026-11-08", reviews: 4, baseline: 3, lastTotal: 3.5, costUsd: 0.5 };
    state.inFlight = { id: "review-id", startedAt: 1, phase: "uncertain", runStarted: false, terminalObserved: false };
  });
  assert.deepEqual(readDirectorState(), state);
  assert.equal(readDirectorState().session.id, id);
  assert.equal(readDirectorState().inFlight.phase, "uncertain");
  assert.equal(isDirectorSession(id), true);
  assert.deepEqual(readdirSync(getDirectorDir()), ["state.json"]);
  if (process.platform !== "win32") assert.equal(statSync(getDirectorStatePath()).mode & 0o777, 0o600);
});

test("invalid mutation preserves previously committed state and removes temporary files", (t) => {
  isolated(t);
  mutateDirectorState((state) => { state.session = info(); });
  const before = readFileSync(getDirectorStatePath(), "utf8");
  assert.throws(() => mutateDirectorState((state) => { state.session.id = "not-a-native-session-id"; }), /corrupt/);
  assert.equal(readFileSync(getDirectorStatePath(), "utf8"), before);
  assert.deepEqual(readdirSync(getDirectorDir()), ["state.json"]);
});

test("corrupt state fails closed and cannot break unrelated worker enforcement", (t) => {
  isolated(t);
  const release = acquireDirectorLock();
  release();
  writeFileSync(getDirectorStatePath(), "{broken", "utf8");
  assert.throws(readDirectorState, /corrupt/);
  assert.throws(() => mutateDirectorState((state) => { state.config.enabled = true; }), /corrupt/);
  assert.equal(readFileSync(getDirectorStatePath(), "utf8"), "{broken");
  assert.equal(isDirectorWorkspace(getDirectorWorkspaceCwd()), true);
  assert.equal(isDirectorSession(id, getDirectorWorkspaceCwd()), true);
  assert.equal(isDirectorSession(id, "/ordinary-worker"), false);
  assert.equal(isDirectorSession(id), false);
});

test("strict state parsing rejects foreign identity and malformed recovery fields", (t) => {
  isolated(t);
  for (const change of [
    (s) => { s.version = 2; },
    (s) => { delete s.config.enabled; },
    (s) => { s.daily.costUsd = -1; },
    (s) => { s.session = { ...info(), cwd: "/worker" }; },
    (s) => { s.session = { ...info(), hostId: "remote" }; },
    (s) => { s.inFlight = { id: "review-id", phase: "accepted", startedAt: 1, terminalObserved: false }; },
    (s) => { s.reviewed = { worker: "not-a-fingerprint" }; },
  ]) {
    const state = newDirectorState();
    change(state);
    assert.throws(() => parseDirectorState(JSON.stringify(state)), /corrupt/);
  }
});

test("installation owner lease refuses simultaneous owner and releases only its own lock", (t) => {
  isolated(t);
  const first = acquireDirectorLock();
  assert.equal(typeof first, "function");
  assert.equal(acquireDirectorLock(), null);
  first();
  const second = acquireDirectorLock();
  assert.equal(typeof second, "function");
  first();
  assert.equal(acquireDirectorLock(), null);
  second();
  assert.equal(existsSync(join(getDirectorDir(), "owner.lock")), false);
});

test("a proven-dead process owner can be recovered, while malformed ownership cannot", (t) => {
  isolated(t);
  const release = acquireDirectorLock();
  release();
  const lock = join(getDirectorDir(), "owner.lock");
  const child = spawnSync(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(lock)}, JSON.stringify({pid: process.pid}), {flag:'wx', mode:0o600})`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const recovered = acquireDirectorLock();
  assert.equal(typeof recovered, "function");
  recovered();
  writeFileSync(lock, "unreadable owner", "utf8");
  assert.equal(acquireDirectorLock(), null);
  assert.equal(readFileSync(lock, "utf8"), "unreadable owner");
});

test("another live web process owns the installation lease until it actually exits", async (t) => {
  isolated(t);
  const prepare = acquireDirectorLock();
  prepare();
  const lock = join(getDirectorDir(), "owner.lock");
  const child = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(lock)}, JSON.stringify({pid:process.pid}), {flag:'wx',mode:0o600}); console.log('ready'); setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lease owner did not become ready")), 5000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Lease owner exited before readiness")); });
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(acquireDirectorLock(), null);
  child.kill();
  await exited;
  const recovered = acquireDirectorLock();
  assert.equal(typeof recovered, "function");
  recovered();
});
