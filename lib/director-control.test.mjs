import assert from "node:assert/strict";
import test from "node:test";

const { executeDirectorControlTool } = await import("./director-control.ts");
const { AgentToolGuard, MAX_AGENT_TOOL_CALLS_PER_MINUTE, MAX_AGENT_TOOL_CHAIN_DEPTH, MAX_AGENT_TOOL_MESSAGE_CHARS } = await import("./agent-tools.ts");

function context(overrides = {}) {
  return {
    sourceSessionId: "director-1",
    workspaceCwd: "/private/director/workspace",
    config: {
      enabled: true, paused: false, controlEnabled: true,
      watchedProjects: [{ cwd: "/projects/selected", hostId: "local" }],
      minReviewIntervalMs: 60_000,
    },
    guard: new AgentToolGuard(),
    ...overrides,
  };
}

function session(overrides = {}) {
  return { id: "worker-1", name: "Worker", cwd: "/projects/selected", hostId: "local", status: "idle", ...overrides };
}

function fixture(rows = [session()]) {
  const effects = [];
  const ops = {
    async listSessions() { return rows; },
    async resume(target) { effects.push({ kind: "resume", target }); return { accepted: true }; },
    async deliver(target, delivery, message) { effects.push({ kind: "deliver", target, delivery, message }); return { accepted: true }; },
    async stop(target) { effects.push({ kind: "stop", target }); return { accepted: true }; },
  };
  return { ops, effects };
}

const command = (overrides = {}) => ({ sessionId: "worker-1", hostId: "local", action: "message", message: "Review the selected project", ...overrides });
const control = (args, ctx, ops) => executeDirectorControlTool("director_control", args, ctx, ops);
const list = (args, ctx, ops) => executeDirectorControlTool("director_sessions", args, ctx, ops);

async function rejectedWithoutEffects(args, ctx = context(), rows = [session()]) {
  const { ops, effects } = fixture(rows);
  await assert.rejects(() => control(args, ctx, ops));
  assert.deepEqual(effects, []);
}

test("selected project and exact host restrict both enumeration and side effects", async () => {
  const rows = [
    session(),
    session({ id: "prefix-escape", cwd: "/projects/selected-other" }),
    session({ id: "child-not-selected", cwd: "/projects/selected/subdirectory" }),
    session({ id: "traversal", cwd: "/projects/selected/../secret" }),
    session({ id: "other-project", cwd: "/projects/secret" }),
    session({ id: "foreign-host", hostId: "h-build" }),
    session({ id: "worktree", cwd: "/worktrees/topic", projectRoot: "/projects/selected" }),
    session({ id: "root-escape", projectRoot: "/projects/secret" }),
  ];
  const ctx = context();
  const { ops, effects } = fixture(rows);
  assert.deepEqual((await list({}, ctx, ops)).sessions.map((row) => row.id), ["worker-1", "worktree"]);
  for (const row of rows.filter((row) => row.id !== "worker-1" && row.id !== "worktree")) {
    await assert.rejects(() => control(command({ sessionId: row.id, hostId: row.hostId }), ctx, ops));
  }
  await assert.rejects(() => control(command({ hostId: "This machine" }), ctx, ops));
  await assert.rejects(() => control(command({ hostId: "h-build" }), ctx, ops));
  await assert.rejects(() => control(command({ sessionId: "Worker" }), ctx, ops));
  assert.deepEqual(effects, []);
  await control(command({ sessionId: "worktree" }), ctx, ops);
  assert.equal(effects[0].target.cwd, "/worktrees/topic");
});

test("Windows project comparison preserves host identity and POSIX case sensitivity", async () => {
  const ctx = context();
  ctx.config.watchedProjects = [{ cwd: "C:\\Projects\\Selected\\", hostId: "h-win" }, { cwd: "/Projects/App", hostId: "local" }];
  const { ops } = fixture([
    session({ id: "windows", cwd: "c:/projects/SELECTED", hostId: "h-win" }),
    session({ id: "wrong-machine", cwd: "C:/Projects/Selected", hostId: "local" }),
    session({ id: "wrong-case", cwd: "/projects/app" }),
    session({ id: "posix", cwd: "/Projects/App" }),
  ]);
  assert.deepEqual((await list({}, ctx, ops)).sessions.map((row) => row.id), ["windows", "posix"]);
});

test("self and every local private-workspace session remain inaccessible even if selected", async () => {
  const ctx = context();
  ctx.config.watchedProjects.push({ cwd: ctx.workspaceCwd, hostId: "local" }, { cwd: ctx.workspaceCwd, hostId: "h-remote" });
  const rows = [
    session({ id: ctx.sourceSessionId }),
    session({ id: "private", cwd: ctx.workspaceCwd }),
    session({ id: "private-child", cwd: `${ctx.workspaceCwd}/nested`, projectRoot: "/projects/selected" }),
    session({ id: "private-root", projectRoot: ctx.workspaceCwd }),
    session({ id: "remote", cwd: ctx.workspaceCwd, hostId: "h-remote" }),
  ];
  const { ops, effects } = fixture(rows);
  assert.deepEqual((await list({}, ctx, ops)).sessions.map((row) => row.id), ["remote"]);
  for (const row of rows.slice(0, -1)) {
    await assert.rejects(() => control(command({ sessionId: row.id, action: "resume", message: undefined }), ctx, ops));
  }
  assert.deepEqual(effects, []);
});

test("disabled, paused and read-only modes reject every mutation but retain scoped inspection", async () => {
  for (const patch of [{ enabled: false }, { paused: true }, { controlEnabled: false }]) {
    const ctx = context();
    Object.assign(ctx.config, patch);
    const { ops, effects } = fixture();
    assert.equal((await list({}, ctx, ops)).sessions.length, 1);
    for (const action of ["resume", "message", "steer", "followUp", "stop"]) {
      await assert.rejects(() => control(command({ action, message: action === "resume" || action === "stop" ? undefined : "Continue" }), ctx, ops));
    }
    assert.deepEqual(effects, []);
  }
});

test("permission, selected scope and chain bounds are checked again after asynchronous metadata lookup", async () => {
  for (const revoke of [
    (ctx) => { ctx.config.paused = true; },
    (ctx) => { ctx.config.controlEnabled = false; },
    (ctx) => { ctx.config.enabled = false; },
    (ctx) => { ctx.config.watchedProjects = []; },
    (ctx) => { ctx.guard.setDepth(ctx.sourceSessionId, MAX_AGENT_TOOL_CHAIN_DEPTH); },
  ]) {
    const ctx = context();
    const { ops, effects } = fixture();
    ops.listSessions = async () => { revoke(ctx); return [session()]; };
    await assert.rejects(() => control(command(), ctx, ops));
    assert.deepEqual(effects, []);
  }
});

test("malformed, arbitrary, shell and approval controls never reach an operation", async () => {
  const invalid = [
    null, [], "message", {},
    command({ sessionId: " worker-1" }), command({ sessionId: "worker-1/child" }),
    command({ sessionId: "x".repeat(201) }), command({ hostId: "x".repeat(201) }),
    command({ hostId: "LOCAL" }), command({ action: "constructor" }), command({ action: "__proto__" }),
    command({ action: "shell" }), command({ action: "delete" }), command({ action: "new_session" }),
    command({ action: "extension_ui_response" }), command({ action: "approve" }),
    command({ command: "rm -rf /" }), command({ wait: true }),
    command({ action: "resume", message: "unexpected" }), command({ action: "stop", message: "unexpected" }),
    command({ message: undefined }), command({ message: null }), command({ message: 2 }), command({ message: " \n " }),
    command({ message: "x".repeat(MAX_AGENT_TOOL_MESSAGE_CHARS + 1) }),
    command({ message: "  /approve all" }), command({ message: "\n!rm -rf /" }),
    command({ message: "/model another" }), command({ message: "ordinary\u0000!shell" }),
  ];
  for (const args of invalid) await rejectedWithoutEffects(args);
  const { ops, effects } = fixture();
  await assert.rejects(() => executeDirectorControlTool("bash", command(), context(), ops));
  assert.deepEqual(effects, []);
});

test("waiting-input sessions cannot receive chat, steering or follow-ups; stop aborts without answering", async () => {
  const rows = [session({ status: "waiting_input" })];
  for (const action of ["message", "steer", "followUp"]) await rejectedWithoutEffects(command({ action, message: "yes" }), context(), rows);
  const { ops, effects } = fixture(rows);
  await control(command({ action: "stop", message: undefined }), context(), ops);
  assert.deepEqual(effects.map((effect) => effect.kind), ["stop"]);
  assert.equal(effects[0].target.status, "waiting_input");
});

test("delivery phase determines accepted native operations and the consumer observes sender attribution", async () => {
  for (const status of ["idle", "completed", "error", "quota", "interrupted", "running"]) {
    const { ops, effects } = fixture([session({ status })]);
    const ctx = context();
    if (status === "running") {
      await assert.rejects(() => control(command(), ctx, ops));
      assert.deepEqual(effects, []);
      await control(command({ action: "steer", message: "Keep the existing changes\nand review the result" }), ctx, ops);
      assert.equal(effects[0].delivery, "steer");
    } else {
      await assert.rejects(() => control(command({ action: "steer" }), ctx, ops));
      await assert.rejects(() => control(command({ action: "stop", message: undefined }), ctx, ops));
      assert.deepEqual(effects, []);
      await control(command(), ctx, ops);
      assert.equal(effects[0].delivery, "prompt");
    }
    assert.equal(effects[0].message, `[From session director-1 via omp-web agent tools]: ${status === "running" ? "Keep the existing changes\nand review the result" : "Review the selected project"}`);
    await control(command({ action: "followUp", message: "Report the outcome" }), ctx, ops);
    assert.equal(effects[1].delivery, "followUp");
    assert.equal(effects[1].message, "[From session director-1 via omp-web agent tools]: Report the outcome");
    await control(command({ action: "resume", message: undefined }), ctx, ops);
    assert.equal(effects[2].kind, "resume");
    if (status === "running") {
      await control(command({ action: "stop", message: undefined }), ctx, ops);
      assert.equal(effects[3].kind, "stop");
    }
  }
});

test("ambiguous exact identities fail closed instead of choosing a session", async () => {
  await rejectedWithoutEffects(command(), context(), [session(), session({ cwd: "/projects/secret" })]);
});

test("rate and chain limits reject before effects and failed delivery never advances the chain", async () => {
  let now = 0;
  const guard = new AgentToolGuard(() => now);
  const ctx = context({ guard });
  const { ops, effects } = fixture();
  for (let index = 0; index < MAX_AGENT_TOOL_CALLS_PER_MINUTE; index++) await control(command(), ctx, ops);
  assert.equal(effects.length, MAX_AGENT_TOOL_CALLS_PER_MINUTE);
  await assert.rejects(() => control(command(), ctx, ops), /rate limit/);
  assert.equal(effects.length, MAX_AGENT_TOOL_CALLS_PER_MINUTE);
  now = 60_000;
  await control(command(), ctx, ops);
  assert.equal(effects.length, MAX_AGENT_TOOL_CALLS_PER_MINUTE + 1);
  guard.setDepth(ctx.sourceSessionId, MAX_AGENT_TOOL_CHAIN_DEPTH);
  for (const action of ["message", "resume", "stop"]) {
    await assert.rejects(() => control(command({ action, message: action === "message" ? "Continue" : undefined }), ctx, ops), /chain depth/);
  }
  assert.equal(effects.length, MAX_AGENT_TOOL_CALLS_PER_MINUTE + 1);
  const fresh = context();
  const error = new Error("delivery outcome uncertain");
  let attempts = 0;
  ops.deliver = async () => { attempts++; throw error; };
  await assert.rejects(() => control(command(), fresh, ops), (actual) => actual === error);
  assert.equal(attempts, 1);
  assert.equal(fresh.guard.depthFor("worker-1"), 0);
  const accepted = fixture();
  await control(command(), fresh, accepted.ops);
  assert.equal(fresh.guard.depthFor("worker-1"), 1);
});

test("resume, stop and list failures propagate without retries", async () => {
  for (const action of ["resume", "stop"]) {
    const error = new Error(`${action} transport failed`);
    const { ops, effects } = fixture([session({ status: "running" })]);
    let attempts = 0;
    ops[action] = async () => { attempts++; throw error; };
    await assert.rejects(() => control(command({ action, message: undefined }), context(), ops), (actual) => actual === error);
    assert.equal(attempts, 1);
    assert.deepEqual(effects, []);
  }
  const error = new Error("host unavailable");
  const { ops, effects } = fixture();
  let attempts = 0;
  ops.listSessions = async () => { attempts++; throw error; };
  await assert.rejects(() => control(command(), context(), ops), (actual) => actual === error);
  assert.equal(attempts, 1);
  assert.deepEqual(effects, []);
  await assert.rejects(() => list({}, context(), ops), (actual) => actual === error);
  assert.equal(attempts, 2);
});

test("stable filtered pagination reaches every selected session beyond the observation window", async () => {
  const ctx = context();
  ctx.config.watchedProjects.push({ cwd: "/projects/selected", hostId: "h-build" });
  const rows = Array.from({ length: 287 }, (_, index) => session({
    id: `session-${String(index).padStart(4, "0")}`,
    name: index % 3 ? "Selected task" : "Excluded query",
    hostId: index % 2 ? "h-build" : "local",
    lastAssistantText: "private history must not be returned",
  })).reverse();
  rows.push(session({ id: "outside", name: "Selected task", cwd: "/projects/secret" }));
  const { ops, effects } = fixture(rows);
  const actual = [];
  let cursor;
  do {
    const page = await list({ query: "selected TASK", limit: 17, ...(cursor ? { cursor } : {}) }, ctx, ops);
    assert.ok(page.sessions.length > 0 && page.sessions.length <= 17);
    assert.ok(JSON.stringify(page).length <= 65_536);
    for (const row of page.sessions) assert.equal(Object.hasOwn(row, "lastAssistantText"), false);
    actual.push(...page.sessions.map((row) => `${row.hostId}/${row.id}`));
    cursor = page.nextCursor;
    rows.reverse(); // Native listing order cannot affect cursor ordering.
  } while (cursor);
  const expected = rows.filter((row) => row.name === "Selected task" && row.cwd === "/projects/selected")
    .map((row) => `${row.hostId}/${row.id}`).sort();
  assert.ok(actual.length > 64);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(effects, []);
});

test("default/max page limits and output ceiling preserve complete traversal with oversized metadata", async () => {
  const rows = Array.from({ length: 115 }, (_, index) => session({ id: `s-${String(index).padStart(3, "0")}` }));
  const small = fixture(rows);
  assert.equal((await list({}, context(), small.ops)).sessions.length, 25);
  assert.equal((await list({ limit: 100 }, context(), small.ops)).sessions.length, 100);
  const longPath = `/projects/${"\u0001".repeat(8000)}`;
  const largeRows = Array.from({ length: 8 }, (_, index) => session({
    id: `long-${index}`, cwd: longPath, projectRoot: longPath, name: "\u0001".repeat(100_000),
  }));
  const ctx = context();
  ctx.config.watchedProjects = [{ cwd: longPath, hostId: "local" }];
  const { ops } = fixture(largeRows);
  const ids = [];
  let cursor;
  do {
    const page = await list({ limit: 100, ...(cursor ? { cursor } : {}) }, ctx, ops);
    assert.ok(JSON.stringify(page).length <= 65_536);
    assert.ok(page.sessions.length > 0);
    ids.push(...page.sessions.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, largeRows.map((row) => row.id));
});

test("bounded list arguments reject invalid cursors, changed queries and unbounded requests before enumeration", async () => {
  const { ops } = fixture([session(), session({ id: "worker-2" })]);
  const first = await list({ query: "worker", limit: 1 }, context(), ops);
  assert.ok(first.nextCursor);
  let reads = 0;
  ops.listSessions = async () => { reads++; return [session()]; };
  for (const args of [
    null, [], { query: "x".repeat(257) }, { query: 2 }, { query: "\u0000" },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: NaN }, { limit: "25" },
    { cursor: "x".repeat(4097) }, { cursor: 2 }, { cursor: "%invalid" },
    { query: "other", cursor: first.nextCursor }, { cursor: encodeURIComponent('["local","worker-1"]') },
    { command: "shell" },
  ]) await assert.rejects(() => list(args, context(), ops));
  assert.equal(reads, 0);
});
