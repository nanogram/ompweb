import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-answer-route-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const route = await import("../app/api/notifications/answer/route.ts");
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { localHost } = await import("./hosts/local-host.ts");
const store = await import("./notification-store.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
const hub = await import("./notification-hub.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await import("./notification-events.ts");

after(() => {
  store.closeNotificationStore();
  closeOutboxStore();
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const post = (body) => route.POST(new Request("http://localhost/api/notifications/answer", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

async function liveSession(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousHub = globalThis.__ompNotificationHub;
  globalThis.__ompNotificationHub = undefined;
  const listeners = new Set();
  const sent = [];
  let failure;
  const proc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    sendCommand: async (command) => command.type === "get_state"
      ? { sessionId: "answer-session", sessionFile: "/tmp/answer-session.jsonl", isStreaming: false, isCompacting: false } : {},
    sendFrame: (frame) => sent.push(frame),
    async sendFrameAsync(frame) { if (failure) throw failure; sent.push(frame); },
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, false, "answer-session", undefined, localHost);
  wrapper.start();
  await wrapper.waitUntilReady();
  globalThis.__ompSessions = new Map([["answer-session", wrapper]]);
  store.saveDevice("answer-device", { ...DEFAULT_NOTIFICATION_PREFS, enabled: true, whenActive: "system" });
  const notifications = [];
  const detach = hub.attachNotificationClient("answer-client", (message) => notifications.push(message), "answer-device");
  t.after(async () => {
    detach();
    await wrapper.destroyAndWait();
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompNotificationHub = previousHub;
  });
  return {
    wrapper, sent, notifications,
    emit(frame) { for (const listener of listeners) listener(frame); },
    failWrites(error) { failure = error; },
  };
}

test("the answer endpoint really resolves a server-owned confirm without forwarding it to omp", async (t) => {
  const { wrapper, sent, notifications } = await liveSession(t);
  const answer = wrapper.confirmFromServer("Start a session on build-box?");
  const input = notifications.find((message) => message.kind === "os" && message.event.type === "input").event;
  assert.equal(input.dialog.method, "confirm");
  const response = await post({ sessionId: "answer-session", requestId: input.requestId, response: { confirmed: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.equal(await answer, true);
  assert.deepEqual(sent, [], "a server-owned dialog has no native answer frame");
  assert.ok(notifications.some((message) => message.kind === "dismiss" && message.requestId === input.requestId));
  assert.deepEqual(await (await post({ sessionId: "answer-session", requestId: input.requestId, response: { confirmed: false } })).json(), { status: "alreadySettled" });
});

test("invalid answers and failed native transport writes leave the real dialog answerable", async (t) => {
  const state = await liveSession(t);
  state.emit({ type: "extension_ui_request", id: "native-confirm", method: "confirm", title: "Continue?" });
  const invalid = await post({ sessionId: "answer-session", requestId: "native-confirm", response: { value: "yes" } });
  assert.equal(invalid.status, 400);
  state.failWrites(new Error("host transport refused write"));
  await assert.rejects(post({ sessionId: "answer-session", requestId: "native-confirm", response: { confirmed: true } }), /host transport refused write/);
  assert.equal(state.notifications.filter((message) => message.kind === "dismiss").length, 0);
  state.failWrites(undefined);
  const accepted = await post({ sessionId: "answer-session", requestId: "native-confirm", response: { confirmed: false } });
  assert.deepEqual(await accepted.json(), { status: "answered" });
  assert.deepEqual(state.sent, [{ type: "extension_ui_response", id: "native-confirm", confirmed: false }]);
  assert.equal(state.notifications.filter((message) => message.kind === "dismiss").length, 1);
});

test("in-app answer, native cancellation, expiry and wrapper exit all retract their notifications", async (t) => {
  const state = await liveSession(t);
  state.emit({ type: "extension_ui_request", id: "in-app", method: "confirm", title: "Continue?" });
  await state.wrapper.send({ type: "extension_ui_response", id: "in-app", confirmed: true });
  state.emit({ type: "extension_ui_request", id: "cancelled", method: "input", title: "Name?" });
  state.emit({ type: "extension_ui_request", method: "cancel", targetId: "cancelled" });
  state.emit({ type: "extension_ui_request", id: "expires", method: "input", title: "Name?", timeout: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  state.emit({ type: "extension_ui_request", id: "exit", method: "input", title: "Name?" });
  await state.wrapper.destroyAndWait();
  assert.deepEqual(state.notifications.filter((message) => message.kind === "dismiss").map((message) => message.requestId), ["in-app", "cancelled", "expires", "exit"]);
});

test("malformed bodies are rejected and absent sessions never spawn or claim an answer", async () => {
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map();
  try {
    for (const body of ["{", null, {}, { sessionId: "s", requestId: "q", response: { confirmed: true, cancelled: true } }, { sessionId: "s", requestId: "q", response: { cancelled: false } }, { sessionId: "s", requestId: "q", response: { answers: [{ id: "q", selectedOptions: "bad" }] } }]) {
      assert.equal((await post(body)).status, 400);
    }
    const gone = await post({ sessionId: "missing", requestId: "q", response: { cancelled: true } });
    assert.deepEqual(await gone.json(), { status: "sessionGone" });
    assert.equal(globalThis.__ompSessions.size, 0);
    assert.equal((await post({ sessionId: "s", requestId: "q", response: { value: "x".repeat(65 * 1024) } })).status, 413);
  } finally {
    globalThis.__ompSessions = previous;
  }
});

test("text, exact select labels, ask answers and explicit cancellation share the real settlement path", async (t) => {
  const state = await liveSession(t);
  const cases = [
    [{ id: "text", method: "input", title: "Name?" }, { value: "New name" }],
    [{ id: "select", method: "select", title: "Pick", options: [{ label: " A " }, { label: "B" }] }, { value: " A " }],
    [{ id: "ask", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "Details" }] }],
    [{ id: "editor", method: "editor", title: "Edit" }, { cancelled: true }],
  ];
  for (const [request, answer] of cases) {
    state.emit({ type: "extension_ui_request", ...request });
    const response = await post({ sessionId: "answer-session", requestId: request.id, response: answer });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "answered" });
  }
  assert.deepEqual(state.sent, cases.map(([request, answer]) => ({ type: "extension_ui_response", id: request.id, ...answer })));
  assert.deepEqual(state.notifications.filter((message) => message.kind === "dismiss").map((message) => message.requestId), cases.map(([request]) => request.id));
});
