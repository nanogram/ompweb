import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

const native = new Map();
const workers = new Map();
const taps = new Set();
const runningListeners = new Set();
const helloListeners = new Set();
let spawnCount = 0;
let resumeCount = 0;
let costAvailable = true;
let rejectPrompt = false;
let online = true;
let listingAvailable = true;
let resumeJoinsExisting = false;
let project = "";
let nextId = 1;
const commands = [];
const local = {
  id: "local", label: "This machine", status: () => online ? "online" : "offline",
  sessionFileExists: async (path) => [...native.values()].some((session) => session.sessionFile === path),
  sessionOps: {
    listSessions: async () => {
      if (!listingAvailable) throw new Error("Native session listing unavailable");
      return [...native.values()].map(nativeInfo).concat([...workers.values()].map((worker) => worker.info));
    },
    validateCwd: async (cwd) => cwd === "/missing" ? { ok: false, error: "Missing project", code: "invalid_project", status: 400 } : { ok: true, value: { cwd, projectRoot: cwd } },
    readSession: async (id) => ({ ok: true, value: { context: { messages: native.get(id)?.history ?? [] } } }),
  },
};
function makeNative(cwd, id) {
  const session = {
    host: local, cwd, sessionId: id, sessionFile: join(cwd, `${id}.jsonl`), alive: true, busy: false, cost: 0, history: [], activity: "idle",
    role: readFileSync(join(cwd, "..", "role.txt"), "utf8"), policyReloads: 0,
    isAlive() { return this.alive; },
    isRunning() { return this.busy; },
    isEditingHistory() { return false; },
    getActivity() { return { id, cwd, status: this.busy ? "running" : this.activity, updatedAt: 1 }; },
    async withPendingCommand(callback) { return callback(); },
    async reloadDirectorPolicy() {
      if (this.busy) throw Object.assign(new Error("Busy"), { code: "session_busy" });
      this.role = readFileSync(join(cwd, "..", "role.txt"), "utf8");
      this.policyReloads++;
    },
    async send(command) {
      commands.push({ id, ...command });
      if (command.type === "get_session_stats") return costAvailable ? { sessionId: id, cost: this.cost } : { sessionId: id };
      if (command.type === "get_state") return { sessionId: id, isStreaming: this.busy, isPromptRunning: this.busy, isBashRunning: false, isCompacting: false, queuedMessageCount: 0, systemPrompt: this.role };
      if (command.type === "get_last_assistant_text") return { text: "Small observed assistant result" };
      if (command.type === "prompt") {
        if (rejectPrompt) throw new Error("Host link lost after possible write");
        this.history.push({ role: "user", content: command.message });
        this.busy = true;
        for (const tap of taps) tap(this, { type: "agent_start" });
      }
      return null;
    },
  };
  native.set(id, session);
  return session;
}
function nativeInfo(session) {
  return { id: session.sessionId, path: session.sessionFile, cwd: session.cwd, hostId: "local", name: "Director", created: "2026-11-08T00:00:00Z", modified: "2026-11-08T00:00:00Z", firstMessage: "Director", messageCount: session.history.length };
}
mock.module("./hosts/hub.ts", () => ({
  getHost: (id) => id === "local" ? local : null,
  onHostHello: (listener) => { helloListeners.add(listener); return () => helloListeners.delete(listener); },
}));
mock.module("./hosts/session-index.ts", () => ({
  hostSessions: async (id) => id === "local" ? [...native.values()].map(nativeInfo).concat([...workers.values()].map((w) => w.info)) : [],
  listProjectsAllHosts: async () => [{ path: project, hostId: "local" }],
}));
mock.module("./rpc-manager.ts", () => ({
  getLiveRpcSessionIds: () => [...native.values()].filter((session) => session.alive).map((session) => session.sessionId),
  getRpcSession: (id) => native.get(id) ?? workers.get(id)?.wrapper,
  getSessionActivities: () => [...native.values()].map((session) => session.getActivity()).concat([...workers.values()].map((worker) => worker.activity)),
  subscribeRunningSessions: (listener) => { runningListeners.add(listener); return () => runningListeners.delete(listener); },
  tapSessionFrames: (listener) => { taps.add(listener); return () => taps.delete(listener); },
  startNewRpcSession: async (_host, cwd) => {
    spawnCount++;
    const id = `${String(nextId++).padStart(8, "0")}-1111-4111-8111-111111111111`;
    return { ok: true, value: { session: makeNative(cwd, id), realSessionId: id } };
  },
  startRpcSession: async (id, path, cwd) => {
    resumeCount++;
    const session = native.get(id);
    assert.ok(session, "resumes must use the exact recorded native identity");
    assert.equal(path, session.sessionFile);
    assert.equal(cwd, session.cwd);
    session.alive = true;
    if (!resumeJoinsExisting) session.role = readFileSync(join(cwd, "..", "role.txt"), "utf8");
    return { session, realSessionId: id };
  },
}));

const { ensureDirector, getDirectorSnapshot, getDirectorStatus, requestDirectorReview, startDirectorSupervisor, updateDirectorConfig } = await import("./director.ts");
const { getDirectorWorkspaceCwd, mutateDirectorState, readDirectorState } = await import("./director-state.ts");
async function fixture(t) {
  listingAvailable = true;
  resumeJoinsExisting = false;
  const root = mkdtempSync(join(tmpdir(), "omp-web-director-supervisor-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  project = join(root, "project");
  mkdirSync(project);
  native.clear(); workers.clear(); taps.clear(); runningListeners.clear(); helloListeners.clear(); commands.length = 0;
  spawnCount = 0; resumeCount = 0; costAvailable = true; rejectPrompt = false; online = true; nextId = 1;
  globalThis.__ompDirectorSupervisor = undefined;
  t.after(async () => {
    const supervisor = globalThis.__ompDirectorSupervisor;
    if (supervisor) { await supervisor.flush(); supervisor.stop(); }
    globalThis.__ompDirectorSupervisor = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function settleDirector(status, cost = 0.1, outcome = "completed") {
  const session = native.get(status.session.id);
  session.busy = false;
  session.cost += cost;
  session.activity = outcome;
  const answer = { role: "assistant", content: [{ type: "text", text: "Concrete next step" }], stopReason: outcome === "completed" ? "stop" : "error" };
  session.history.push(answer);
  for (const tap of taps) tap(session, { type: "agent_end", isTerminal: true, messages: [answer] });
  await globalThis.__ompDirectorSupervisor.flush();
  return session;
}
function addWorker(id, cwd = project, status = "completed") {
  const activity = { id, cwd, hostId: "local", status, updatedAt: Date.now() };
  const wrapper = { sessionId: id, cwd, host: local, isAlive: () => true, getActivity: () => activity, async send(command) { commands.push({ id, ...command }); assert.equal(command.type, "get_last_assistant_text", "workers may only receive passive text reads"); return { text: "Observed result" }; } };
  const info = { id, cwd, projectRoot: cwd, path: "worker.jsonl", name: "Worker", created: "", modified: "", messageCount: 1, firstMessage: "Work", hostId: "local" };
  workers.set(id, { info, activity, wrapper });
  return { activity, wrapper };
}
const prompts = () => commands.filter((command) => command.type === "prompt");

test("disabled startup and GET never spawn native sessions or spend", async (t) => {
  await fixture(t);
  const stop = startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).supervisor, "disabled");
  assert.equal(spawnCount, 0);
  assert.equal(commands.length, 0);
  stop();
});

test("ensure creates one named real conversation, strict hidden resume config, and meaningful bootstrap", async (t) => {
  const root = await fixture(t);
  const foreign = { path: project, addedAt: "2026-01-01", hidden: false, launchConfig: { profile: "work", advisor: true, extraArgs: ["--verbose"] }, foreignMetadata: "preserve" };
  writeFileSync(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [foreign] }));
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  assert.equal(status.session.name, "Director");
  assert.equal(status.session.cwd, getDirectorWorkspaceCwd());
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
  const registry = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
  assert.deepEqual(registry.projects.find((p) => p.path === project), foreign);
  const reserved = registry.projects.find((p) => p.path === getDirectorWorkspaceCwd());
  assert.equal(reserved.hidden, true);
  await ensureDirector({ cwd: project, hostId: "local" });
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
});

test("web restart rejoins the exact persistent session without duplicate bootstrap or native spawn", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status);
  const id = status.session.id;
  globalThis.__ompDirectorSupervisor.stop();
  globalThis.__ompDirectorSupervisor = undefined;
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  const restored = await getDirectorStatus();
  assert.equal(restored.session.id, id);
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
  assert.equal(restored.daily.costUsd, 0.1);
  native.get(id).alive = false;
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(resumeCount, 1);
  assert.equal((await getDirectorStatus()).session.id, id);
});

test("selected completion coalesces under cooldown; streaming alone and foreign projects never send reviews", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status);
  const worker = addWorker("worker-selected", project, "running");
  addWorker("worker-foreign", "/foreign", "error");
  for (let i = 0; i < 20; i++) for (const tap of taps) tap(worker.wrapper, { type: "message_update" });
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 1);
  worker.activity.status = "completed";
  worker.activity.updatedAt += 1;
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 1);
  assert.ok(readDirectorState().nextReviewAt > Date.now());
  mutateDirectorState((state) => { state.lastReviewAt = Date.now() - state.config.minReviewIntervalMs - 1; });
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 2);
  const snapshot = await getDirectorSnapshot();
  assert.deepEqual(snapshot.map((summary) => summary.id), ["worker-selected"]);
  assert.ok(!commands.some((command) => command.id === "worker-foreign"));
  assert.ok(commands.filter((command) => command.id === "worker-selected").every((command) => command.type === "get_last_assistant_text"));
  await settleDirector(status);
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 2);
});

test("unavailable cost remains visible without blocking automatic or requested reviews", async (t) => {
  await fixture(t);
  costAvailable = false;
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
  assert.equal(status.daily.costUsd, null);
  assert.equal(status.supervisor, "reviewing");
  await settleDirector(status);
  await requestDirectorReview();
  await globalThis.__ompDirectorSupervisor.flush();
  const current = await getDirectorStatus();
  assert.equal(prompts().length, 2);
  assert.equal(current.daily.costUsd, null);
  assert.equal(current.supervisor, "reviewing");
  assert.equal(current.lastError, null);
});

test("scheduled reviews resume past 24 without waiting for a retired midnight limit", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status);
  addWorker("worker-finished", project, "completed");
  mutateDirectorState((state) => {
    state.daily.reviews = 24;
    state.lastReviewAt = Date.now() - state.config.minReviewIntervalMs - 1;
    state.lastError = "Daily automatic review limit reached";
    state.nextReviewAt = Date.now() + 86_400_000;
  });
  await globalThis.__ompDirectorSupervisor.flush();
  const current = await getDirectorStatus();
  assert.equal(prompts().length, 2);
  assert.equal(current.daily.reviews, 25);
  assert.equal(current.session.id, status.session.id);
  assert.equal(current.supervisor, "reviewing");
  assert.equal(current.lastError, null);
  assert.equal(current.nextReviewAt, null);
});

test("Director can initiate another review after reporting more than two dollars", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status, 3.25);
  await requestDirectorReview();
  await globalThis.__ompDirectorSupervisor.flush();
  const current = await getDirectorStatus();
  assert.equal(prompts().length, 2);
  assert.equal(current.session.id, status.session.id);
  assert.equal(current.daily.costUsd, 3.25);
  assert.equal(current.supervisor, "reviewing");
  assert.equal(current.lastError, null);
});

test("quota failures still pause automatic reviews until explicitly resumed", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status, 0.1, "quota");
  assert.equal(readDirectorState().config.paused, true);
  assert.match(readDirectorState().lastError, /review stopped/);
  addWorker("worker-finished", project, "completed");
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 1);
  await updateDirectorConfig({ paused: false });
  await requestDirectorReview();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 2);
  assert.equal(readDirectorState().config.paused, false);
  assert.equal(readDirectorState().lastError, null);
});

test("uncertain send survives restart without blind retry or handshake completion", async (t) => {
  await fixture(t);
  rejectPrompt = true;
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  assert.equal(prompts().length, 1);
  assert.equal(readDirectorState().inFlight.phase, "uncertain");
  const session = native.get(status.session.id);
  for (const tap of taps) tap(session, { type: "agent_end", isTerminal: true, messages: [] });
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(readDirectorState().inFlight.terminalObserved, false);
  globalThis.__ompDirectorSupervisor.stop();
  globalThis.__ompDirectorSupervisor = undefined;
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(prompts().length, 1);
  assert.match(readDirectorState().lastError, /uncertain/);
});

test("unresolved creation reservation fails closed; host reconnect adopts one discoverable native identity", async (t) => {
  await fixture(t);
  mutateDirectorState((state) => { state.config.enabled = true; state.config.watchedProjects = [{ cwd: project, hostId: "local" }]; state.creating = true; });
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(spawnCount, 0);
  assert.match((await getDirectorStatus()).lastError, /creation was interrupted/);
  const id = "22222222-2222-4222-8222-222222222222";
  makeNative(getDirectorWorkspaceCwd(), id);
  for (const listener of helloListeners) listener("local", []);
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).session.id, id);
  assert.equal(spawnCount, 0);
  assert.equal(prompts().length, 1);
});

test("offline hosts are honest and recovery does not replace a retained Director identity", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  await settleDirector(status);
  online = false;
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).supervisor, "offline");
  assert.equal(spawnCount, 1);
  online = true;
  for (const listener of helloListeners) listener("local", []);
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).session.id, status.session.id);
  assert.equal(spawnCount, 1);
});

test("failed authoritative native discovery cannot use stale cached absence to create a duplicate", async (t) => {
  await fixture(t);
  listingAvailable = false;
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  assert.equal(spawnCount, 0);
  assert.equal(status.session, null);
  assert.match(status.lastError, /identity discovery is unavailable/);
  assert.equal(readDirectorState().creating, false);
  listingAvailable = true;
  for (const listener of helloListeners) listener("local", []);
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
});

test("an obsolete Director role waits for idle then reloads only that chat without another review", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  const session = await settleDirector(status);
  session.role = "Earlier observe-only policy";
  session.busy = true;
  globalThis.__ompDirectorSupervisor.stop();
  globalThis.__ompDirectorSupervisor = undefined;
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(session.policyReloads, 0);
  assert.equal(session.busy, true);
  session.busy = false;
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(session.policyReloads, 1);
  assert.equal((await getDirectorStatus()).session.id, status.session.id);
  assert.equal(spawnCount, 1);
  assert.equal(prompts().length, 1);
  await updateDirectorConfig({ controlEnabled: true });
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).mode, "control");
  assert.equal(session.policyReloads, 1);
  await updateDirectorConfig({ controlEnabled: false });
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal((await getDirectorStatus()).mode, "observe");
  assert.equal(session.policyReloads, 1);
});

test("a temporary preparation collision cannot strand an obsolete Director policy", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  const session = await settleDirector(status);
  session.role = "Earlier policy";
  const reload = session.reloadDirectorPolicy.bind(session);
  let attempts = 0;
  let applied;
  const policyApplied = new Promise((resolve) => { applied = resolve; });
  session.reloadDirectorPolicy = async () => {
    if (attempts++ === 0) throw Object.assign(new Error("Another request is preparing"), { code: "session_busy" });
    await reload();
    applied();
  };
  globalThis.__ompDirectorSupervisor.stop();
  globalThis.__ompDirectorSupervisor = undefined;
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  let timeout;
  try {
    await Promise.race([policyApplied, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Policy remained stranded after preparation ended")), 5000); })]);
  } finally { clearTimeout(timeout); }
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(session.policyReloads, 1);
  assert.equal((await getDirectorStatus()).session.id, status.session.id);
  assert.equal(prompts().length, 1);
});

test("a cold web wrapper joining an existing native Director still applies the new policy", async (t) => {
  await fixture(t);
  const status = await ensureDirector({ cwd: project, hostId: "local" });
  const session = await settleDirector(status);
  globalThis.__ompDirectorSupervisor.stop();
  globalThis.__ompDirectorSupervisor = undefined;
  session.role = "Earlier observe-only native policy";
  session.alive = false;
  resumeJoinsExisting = true;
  startDirectorSupervisor();
  await globalThis.__ompDirectorSupervisor.flush();
  assert.equal(resumeCount, 1);
  assert.equal(session.policyReloads, 1);
  assert.equal((await getDirectorStatus()).session.id, status.session.id);
  assert.equal(prompts().length, 1);
});
