import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const cwd = "F:/selected";
const registry = new Map();
let info;
let writes;
let starts;
let listingHook;
let stateHook;
let sendFailure;
let transcriptAvailable;
const host = {
  id: "local", status: () => "online",
  sessionFileExists: async () => transcriptAvailable,
  sessionOps: {
    listSessions: async () => { if (listingHook) await listingHook(); return [info]; },
    validateCwd: async (path) => ({ ok: true, value: { cwd: path, projectRoot: path } }),
  },
};
function worker() {
  return {
    sessionId: TARGET, host, cwd, alive: true, running: false, status: "completed", editing: false, queued: [],
    isAlive() { return this.alive; }, isRunning() { return this.running; }, isEditingHistory() { return this.editing; },
    getActivity() { return { status: this.status }; },
    async withPendingCommand(callback) { return callback(); },
    async send(command) {
      if (command.type === "get_state") {
        if (stateHook) await stateHook(this);
        return { sessionId: this.sessionId, activity: { status: this.status }, isStreaming: this.running, isPromptRunning: this.running, isBashRunning: false, isCompacting: false };
      }
      writes.push(command);
      if (sendFailure) throw sendFailure;
      if (command.type === "prompt") {
        if (this.running) {
          if (command.streamingBehavior !== "followUp") throw new Error("A native running turn requires follow-up queue intent");
          this.queued.push(command.message);
        } else { this.running = true; this.status = "running"; }
      } else if (command.type === "abort") { this.running = false; this.status = "interrupted"; }
      else if (command.type !== "steer") throw new Error("Unsupported native command");
      return null;
    },
  };
}
mock.module("./hosts/hub.ts", () => ({ getHost: (id) => id === "local" ? host : null }));
mock.module("./hosts/session-index.ts", () => ({ hostSessions: async () => [info] }));
mock.module("./rpc-manager.ts", () => ({
  getRpcSession: (id) => registry.get(id),
  getLiveRpcSessionIds: () => [...registry].filter(([, session]) => session.isAlive()).map(([id]) => id),
  getSessionActivities: () => [],
  startRpcSession: async (id, path) => {
    starts.push({ id, path });
    const session = worker();
    registry.set(id, session);
    return { session, realSessionId: session.sessionId };
  },
}));
const { getDirectorWorkspaceCwd, mutateDirectorState } = await import("./director-state.ts");
const { executeDirectorRuntimeTool } = await import("./director-runtime.ts");

function fixture(t, live = true) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-director-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writes = []; starts = []; listingHook = null; stateHook = null; sendFailure = null; transcriptAvailable = true;
  registry.clear();
  globalThis.__ompDirectorControlGuard = undefined;
  registry.set(SOURCE, { sessionId: SOURCE, host, cwd: getDirectorWorkspaceCwd(), isAlive: () => true, isRunning: () => false, getActivity: () => ({ status: "idle" }) });
  const target = worker();
  if (live) registry.set(TARGET, target);
  info = { id: TARGET, hostId: "local", cwd, projectRoot: cwd, path: "native-target.jsonl", name: "Worker", activityStatus: "completed", firstMessage: "Assigned work" };
  mutateDirectorState((state) => {
    state.session = { id: SOURCE, cwd: getDirectorWorkspaceCwd(), hostId: "local", path: "director.jsonl", name: "Director", created: "2026-11-09T00:00:00Z", modified: "2026-11-09T00:00:00Z", firstMessage: "Direct my projects", messageCount: 1 };
    state.config.enabled = true;
    state.config.controlEnabled = true;
    state.config.watchedProjects = [{ cwd, hostId: "local" }];
  });
  t.after(() => {
    registry.clear();
    globalThis.__ompDirectorControlGuard = undefined;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return target;
}
const control = (action = "message") => executeDirectorRuntimeTool(SOURCE, "director_control", { sessionId: TARGET, hostId: "local", action, ...(action === "message" ? { message: "Continue the human's assigned work." } : {}) });

test("a cold control resumes the existing native transcript, never creates a replacement chat", async (t) => {
  fixture(t, false);
  const result = await control();
  assert.equal(result.accepted, true);
  assert.equal(result.targetSessionId, TARGET);
  assert.equal(registry.get(TARGET).running, true);
  assert.deepEqual(starts, [{ id: TARGET, path: info.path }]);
  assert.equal(writes.length, 1);
});

test("follow-up starts an inactive target and queues behind an active turn without replacing it", async (t) => {
  const session = fixture(t);
  const send = () => executeDirectorRuntimeTool(SOURCE, "director_control", {
    sessionId: TARGET, hostId: "local", action: "followUp", message: "Do the next assigned step.",
  });
  const first = await send();
  assert.equal(first.accepted, true);
  assert.equal(session.running, true);
  assert.equal(session.queued.length, 0);
  const second = await send();
  assert.equal(second.accepted, true);
  assert.equal(session.running, true);
  assert.equal(session.queued.length, 1);
  assert.ok(session.queued[0].endsWith("Do the next assigned step."));
});

test("revoking control during a native read prevents the pending mutation", async (t) => {
  fixture(t);
  stateHook = () => mutateDirectorState((state) => { state.config.controlEnabled = false; });
  await assert.rejects(control());
  assert.equal(writes.length, 0);
});

test("changing project scope during authoritative owner lookup prevents a resume", async (t) => {
  fixture(t, false);
  listingHook = () => mutateDirectorState((state) => { state.config.watchedProjects = [{ cwd: "F:/elsewhere", hostId: "local" }]; });
  await assert.rejects(control());
  assert.equal(starts.length, 0);
  assert.equal(writes.length, 0);
});

test("a native question appearing after metadata selection cannot be bypassed by a message", async (t) => {
  fixture(t);
  stateHook = (session) => { session.status = "waiting_input"; session.running = true; };
  await assert.rejects(control());
  assert.equal(writes.length, 0);
});

test("an old alias cannot redirect a Director instruction into a different conversation", async (t) => {
  const session = fixture(t);
  session.sessionId = OTHER;
  await assert.rejects(control());
  assert.equal(starts.length, 0);
  assert.equal(writes.length, 0);
});

test("a native identity move during preparation cannot receive the pending instruction", async (t) => {
  fixture(t);
  stateHook = (session) => { session.sessionId = OTHER; };
  await assert.rejects(control());
  assert.equal(writes.length, 0);
});

test("unavailable authoritative metadata or transcript fails before any replacement process", async (t) => {
  fixture(t, false);
  listingHook = () => { throw new Error("Owner lookup unavailable"); };
  await assert.rejects(control());
  assert.equal(starts.length, 0);
  listingHook = null;
  transcriptAvailable = false;
  await assert.rejects(control());
  assert.equal(starts.length, 0);
  assert.equal(writes.length, 0);
});

test("an uncertain native send is surfaced without an automatic retry", async (t) => {
  fixture(t);
  sendFailure = new Error("Lost acknowledgement");
  await assert.rejects(control());
  assert.equal(writes.length, 1);
  assert.equal(starts.length, 0);
});

test("stop aborts a waiting turn without answering the question or destroying its session", async (t) => {
  const session = fixture(t);
  session.status = "waiting_input";
  session.running = true;
  const result = await control("stop");
  assert.equal(result.accepted, true);
  assert.equal(session.status, "interrupted");
  assert.equal(session.isAlive(), true);
  assert.deepEqual(writes.map((command) => command.type), ["abort"]);
});
