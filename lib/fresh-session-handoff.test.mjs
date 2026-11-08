import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const agentDir = mkdtempSync(join(tmpdir(), "omp-fresh-handoff-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const route = await import("../app/api/agent/new/route.ts");
const { runAgentCommand } = await import("./agent-command.ts");
const { getRpcSession } = await import("./rpc-manager.ts");
const { linkLocalHost, linkHost, listedSession, until } = await import("./hosts/link-driver.test-helper.mjs");
const hub = await import("./hosts/hub.ts");
const { revokeHost } = await import("./hosts/registry.ts");
const { StagedUploads } = await import("./hosts/uploads.ts");
const { saveCompletedUpload, completedUpload, closeOutboxStore } = await import("./message-outbox.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const { snapshotOutboxUploads } = await import("./uploads.ts");

function post(body, { cookie, signal } = {}) {
  return route.POST(new Request("http://omp.test/api/agent/new", {
    method: "POST", body: JSON.stringify({ cwd: agentDir, ...body }), signal,
    ...(cookie ? { headers: { cookie } } : {}),
  }));
}
async function json(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

async function fixture(t) {
  const before = { sessions: globalThis.__ompSessions, locks: globalThis.__ompStartLocks, creations: globalThis.__ompFreshCreations };
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = new Map();
  globalThis.__ompFreshCreations = new Map();
  const daemon = await linkLocalHost();
  const h = { children: [], commands: [], events: [], attaches: [], startupGate: null, killGate: null,
    rejectState: false, rejectModels: false, persisted: false, boundary: ["entry-before-send"] };
  const acks = [];
  h.staged = new StagedUploads((ack) => acks.push(ack), join(agentDir, "staged", randomUUID()));
  const byChannel = new Map();
  daemon.serve({
    async spawn(args) {
      const child = { id: args.sessionFile ? h.savedId : randomUUID(), ch: args.ch,
        file: args.sessionFile || join(agentDir, "sessions", randomUUID(), "fresh.jsonl"),
        model: { provider: "initial", id: "initial" } };
      if (args.spawnModel) {
        const slash = args.spawnModel.indexOf("/");
        child.model = { provider: args.spawnModel.slice(0, slash), id: args.spawnModel.slice(slash + 1) };
      }
      h.children.push({ ...child, args });
      byChannel.set(args.ch, child);
      h.events.push("spawn");
      if (h.startupGate) await h.startupGate;
      await daemon.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: path } }),
    sessionFileExists: () => h.persisted,
    invalidateSessionLists: () => null,
    listSessions: () => h.savedId ? [{ ...listedSession(h.savedId, agentDir), path: h.savedFile }] : [],
    readContext: ({ id, options }) => {
      h.events.push(`boundary:${id}`);
      assert.equal(options.boundary, true);
      return h.boundary === null ? { ok: false, status: 404, code: "session_not_found", error: "No file yet" }
        : { ok: true, value: { entryIds: h.boundary } };
    },
    async uploadAttach({ id, sessionFile, sessionId }) {
      const result = await h.staged.attach(id, sessionFile, sessionId);
      h.attaches.push(result);
      h.events.push("attached");
      return result;
    },
  }, async (message) => {
    if (message.type === "kill") {
      h.events.push("kill-requested");
      if (h.killGate) await h.killGate;
      h.events.push("exited");
      await daemon.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
      return;
    }
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    const child = byChannel.get(message.ch);
    h.commands.push(command);
    h.events.push(command.type);
    let outcome = { success: true, data: {} };
    if (command.type === "negotiate_protocol") outcome.data = { protocolVersion: 2 };
    else if (command.type === "get_state") {
      if (h.rejectState) {
        h.rejectState = false;
        outcome = { success: false, error: "startup failed" };
      } else outcome.data = { sessionId: child.id, sessionFile: child.file, model: child.model,
        isStreaming: false, isCompacting: false, queuedMessages: { steering: [], followUp: [] } };
    } else if (command.type === "set_model") {
      if (h.rejectModels) outcome = { success: false, error: "Model not found" };
      else child.model = { provider: command.provider, id: command.modelId };
    } else if (command.type === "prompt") outcome.data = { agentInvoked: false };
    await daemon.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", command: command.type, id: command.id, ...outcome }) });
  });
  h.upload = async (bytes, owner = "open") => {
    const id = randomUUID();
    await h.staged.start({ id, name: "fresh.txt", size: bytes.length, type: "text/plain", attempt: randomUUID() });
    h.staged.write(id, bytes);
    await until(() => acks.some((ack) => ack.id === id && ack.done), "staged bytes to complete");
    const receipt = { id, hostId: "local", name: "fresh.txt", size: bytes.length, type: "text/plain", attached: null };
    const proof = saveCompletedUpload(owner, receipt);
    return { id, proof, receipt, part: join(h.staged.dir, `${id}.part`) };
  };
  t.after(async () => {
    for (const wrapper of new Set(globalThis.__ompSessions.values())) await wrapper.destroyAndWait();
    hub.closeHostLink("local");
    globalThis.__ompSessions = before.sessions;
    globalThis.__ompStartLocks = before.locks;
    globalThis.__ompFreshCreations = before.creations;
  });
  return h;
}

after(() => {
  hub.flushLinkSamples();
  closeOutboxStore();
  closeNotificationStore();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(agentDir, { recursive: true, force: true });
});

test("an initial prompt joins in-flight precreation and dispatches exactly once without renderer continuation", async (t) => {
  const h = await fixture(t);
  const gate = Promise.withResolvers();
  h.startupGate = gate.promise;
  const ensure = post({ type: "ensure_session", creationKey: "inflight", provider: "old", modelId: "old", thinkingLevel: "low" });
  await until(() => h.children.length === 1, "cold creation to begin");
  const controller = new AbortController();
  const body = { type: "prompt", creationKey: "inflight", message: "send before renderer wakes", provider: "new", modelId: "new",
    thinkingLevel: "high", captureRunBoundary: true };
  const first = post(body, { signal: controller.signal });
  const duplicate = post(body);
  await new Promise((resolve) => setImmediate(resolve)); // The server has received both bodies while startup remains held.
  controller.abort();
  gate.resolve();
  const [prepared, sent, repeated] = await Promise.all([ensure.then((r) => json(r)), first.then((r) => json(r)), duplicate.then((r) => json(r))]);
  assert.equal(h.children.length, 1);
  assert.equal(prepared.sessionId, sent.sessionId);
  assert.deepEqual(repeated, sent);
  assert.deepEqual(sent.runBoundary, ["entry-before-send"]);
  assert.deepEqual(h.commands.filter((c) => c.type === "set_model").map((c) => [c.provider, c.modelId]), [["old", "old"], ["new", "new"]]);
  assert.deepEqual(h.commands.filter((c) => c.type === "set_thinking_level").map((c) => c.level), ["low", "high"]);
  const prompts = h.commands.filter((c) => c.type === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].message, body.message);
  for (const field of ["creationKey", "captureRunBoundary", "provider", "modelId", "thinkingLevel"]) assert.equal(Object.hasOwn(prompts[0], field), false);
  assert.ok(h.events.findIndex((event) => event.startsWith("boundary:")) < h.events.indexOf("prompt"));
  await json(await post({ type: "ensure_session", creationKey: "inflight", provider: "old", modelId: "old" }));
  assert.equal(h.commands.filter((c) => c.type === "set_model").length, 2, "late ensure cannot revert the newer selection");
});

test("prompt-first response races coalesce, and mismatched first messages or spawn identities fail explicitly", async (t) => {
  const h = await fixture(t);
  const body = { type: "prompt", creationKey: "prompt-first", message: "one", provider: "p", modelId: "m", captureRunBoundary: true };
  const sent = await json(await post(body));
  const ensured = await json(await post({ type: "ensure_session", creationKey: "prompt-first", provider: "old", modelId: "old" }));
  assert.equal(ensured.sessionId, sent.sessionId);
  assert.deepEqual(await json(await post(body)), sent);
  assert.equal(h.children.length, 1);
  assert.equal(h.commands.filter((c) => c.type === "prompt").length, 1);
  assert.equal((await json(await post({ ...body, message: "different" }), 400)).code, "creation_prompt_conflict");
  for (const changed of [{ cwd: `${agentDir}/other` }, { advisor: true }, { toolNames: ["read"] }]) {
    assert.equal((await json(await post({ ...body, ...changed }), 400)).code, "creation_key_conflict");
  }
});

test("a known pre-created ID applies selection and captures its host boundary before dispatch", async (t) => {
  const h = await fixture(t);
  const prepared = await json(await post({ type: "ensure_session", creationKey: "known" }));
  const response = await runAgentCommand(prepared.sessionId, { type: "prompt", message: "known fresh ID", provider: "chosen", modelId: "model",
    thinkingLevel: "medium", captureRunBoundary: true }, false, "open");
  assert.deepEqual((await json(response)).runBoundary, h.boundary);
  const ordered = h.commands.filter((c) => ["set_model", "set_thinking_level", "prompt"].includes(c.type));
  assert.deepEqual(ordered.map((c) => c.type), ["set_model", "set_thinking_level", "prompt"]);
  assert.equal(ordered[0].provider, "chosen");
  assert.equal(h.children.length, 1);
  h.boundary = null;
  const fileless = await json(await runAgentCommand(prepared.sessionId, { type: "prompt", message: "still fileless", captureRunBoundary: true }, false, "open"));
  assert.deepEqual(fileless.runBoundary, []);
});

test("staged upload refusal preserves bytes and authority, then the fresh prompt uses the shared attachment path", async (t) => {
  const h = await fixture(t);
  const bytes = Buffer.from("fresh staged bytes");
  const file = await h.upload(bytes);
  const body = { type: "prompt", creationKey: "attachment", message: "read this", uploads: [file.id], uploadProofs: { [file.id]: file.proof },
    images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], captureRunBoundary: true };
  const refused = await post({ ...body, uploadProofs: { [file.id]: "x".repeat(43) } });
  assert.equal(refused.status, 404);
  assert.deepEqual(readFileSync(file.part), bytes);
  assert.equal(h.children.length, 0);
  assert.equal(snapshotOutboxUploads([file.id], "open", { [file.id]: file.proof }).length, 1);
  const result = await json(await post(body));
  assert.equal(h.attaches.length, 1);
  assert.deepEqual(readFileSync(h.attaches[0].path), bytes);
  assert.equal(completedUpload(file.id), null);
  assert.deepEqual(await json(await post(body)), result, "a duplicate does not need consumed upload authority or attach twice");
  const [prompt] = h.commands.filter((c) => c.type === "prompt");
  assert.match(prompt.message, /Attached files/);
  assert.deepEqual(prompt.images, body.images);
  assert.equal(JSON.stringify(prompt).includes(file.proof), false);
  assert.ok(h.events.indexOf("attached") < h.events.findIndex((event) => event.startsWith("boundary:")));
  assert.ok(h.events.findIndex((event) => event.startsWith("boundary:")) < h.events.indexOf("prompt"));
});

test("failed startup retains the coalescing slot through child shutdown, then the same key can recover", async (t) => {
  const h = await fixture(t);
  h.rejectState = true;
  const gate = Promise.withResolvers();
  h.killGate = gate.promise;
  const failed = post({ type: "ensure_session", creationKey: "recover" });
  await until(() => h.events.includes("kill-requested"), "failed startup shutdown");
  const joined = post({ type: "prompt", creationKey: "recover", message: "never dispatched on failed child" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.children.length, 1);
  gate.resolve();
  assert.equal((await failed).status, 400);
  assert.equal((await joined).status, 400);
  assert.equal(h.commands.filter((c) => c.type === "prompt").length, 0);
  h.killGate = null;
  await json(await post({ type: "prompt", creationKey: "recover", message: "after failed startup" }));
  assert.equal(h.children.length, 2);
  assert.ok(h.events.indexOf("exited") < h.events.lastIndexOf("spawn"));
});

test("creation keys are scoped to authenticated owners and cannot redirect to another host", async (t) => {
  const h = await fixture(t);
  const first = await json(await post({ type: "ensure_session", creationKey: "owner-key" }, { cookie: "omp_web_session=one" }));
  const second = await json(await post({ type: "ensure_session", creationKey: "owner-key" }, { cookie: "omp_web_session=two" }));
  assert.notEqual(first.sessionId, second.sessionId);
  const remote = await linkHost("Other fresh host");
  t.after(() => { hub.closeHostLink(remote.id); revokeHost(remote.id); });
  const rejected = await json(await post({ type: "ensure_session", creationKey: "owner-key", hostId: remote.id }, { cookie: "omp_web_session=one" }), 400);
  assert.equal(rejected.code, "creation_key_conflict");
  assert.equal(h.children.length, 2);
  assert.ok(getRpcSession(first.sessionId)?.isAlive());
});

test("a cold pre-created-ID prompt binds the chosen model at spawn before restoring an unusable saved model", async (t) => {
  const h = await fixture(t);
  const prepared = await json(await post({ type: "ensure_session", creationKey: "cold-known" }));
  const wrapper = getRpcSession(prepared.sessionId);
  h.savedId = wrapper.sessionId;
  h.savedFile = wrapper.sessionFile;
  await wrapper.destroyAndWait();
  h.persisted = true;
  h.rejectModels = true; // The native set_model reply is spurious, but the explicit spawn binding is authoritative.
  (await import("./hosts/session-index.ts")).invalidateHostSessionList("local");
  const response = await runAgentCommand(h.savedId, { type: "prompt", message: "resumed choice", provider: "cold", modelId: "selected",
    thinkingLevel: "high", captureRunBoundary: true }, false, "open");
  assert.deepEqual((await json(response)).runBoundary, h.boundary);
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].args.spawnModel, "cold/selected");
  const prompt = h.commands.findLast((command) => command.type === "prompt");
  assert.equal(prompt.message, "resumed choice");
  assert.equal(Object.hasOwn(prompt, "provider"), false);
});

test("a model-preparation failure does not kill a session another ensure request already owns", async (t) => {
  const h = await fixture(t);
  const ensured = await json(await post({ type: "ensure_session", creationKey: "shared-failure" }));
  h.rejectModels = true;
  const failed = await json(await post({ type: "prompt", creationKey: "shared-failure", message: "not delivered", provider: "missing", modelId: "missing" }), 400);
  assert.equal(failed.sessionId, ensured.sessionId);
  assert.equal(getRpcSession(ensured.sessionId)?.isAlive(), true);
  assert.equal(h.commands.some((command) => command.type === "prompt"), false);
  assert.equal(h.events.includes("kill-requested"), false);
  const again = await json(await post({ type: "ensure_session", creationKey: "shared-failure" }));
  assert.equal(again.sessionId, ensured.sessionId);
  assert.equal(h.children.length, 1);
});

test("boundary refusal from the owning host never falls back to the server's local filesystem or dispatches a prompt", async (t) => {
  const h = await fixture(t);
  const ensured = await json(await post({ type: "ensure_session", creationKey: "host-boundary" }));
  h.persisted = true;
  h.boundary = null;
  const response = await runAgentCommand(ensured.sessionId, { type: "prompt", message: "must not be dispatched", captureRunBoundary: true }, false, "open");
  assert.equal((await json(response, 404)).code, "session_not_found");
  assert.equal(h.commands.some((command) => command.type === "prompt"), false);
  assert.ok(getRpcSession(ensured.sessionId)?.isAlive());
});
