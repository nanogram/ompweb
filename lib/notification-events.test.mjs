import assert from "node:assert/strict";
import test from "node:test";

const { createNotificationDetector, parseNotificationPrefs, renderNotification, buildNotificationDialog } = await import("./notification-events.ts");

const session = { sessionId: "s1", sessionName: "Refactor auth" };

function run(frames) {
  const detect = createNotificationDetector();
  return frames.flatMap((frame) => detect(frame, session));
}

const summary = (events) => events.map((event) => [event.type, event.detail]);

test("completion fires when the session settles, not per prompt or per subagent", () => {
  const events = run([
    { type: "agent_start" },
    { type: "subagent_lifecycle", payload: { id: "a", status: "completed" } },
    { type: "subagent_event", payload: { id: "a", event: { type: "agent_end", isTerminal: true } } },
    { type: "agent_end", isTerminal: false },
    { type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events, [{ sessionId: "s1", sessionName: "Refactor auth", type: "completed" }]);
});

test("local slash commands and aborted runs do not notify", () => {
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "unknown command" } }]), []);
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: true, status: "aborted" }, { type: "session_settled" }]), []);
});

test("a run failure reported by omp-web and again by omp notifies once; a later crash adds nothing", () => {
  const events = run([
    { type: "prompt_error", errorMessage: "usage reserve is fail-closed" },
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "usage reserve is fail-closed" } },
    { type: "process_exit", detail: "code 1" },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "usage reserve is fail-closed"]]);
});

test("a failed run notifies once as an error, not again as completed", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "Retry budget exhausted" } },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "Retry budget exhausted"]]);
});

test("after a failed stretch, a background wake with no prompt completes normally", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "boom" } },
    { type: "session_settled" },
    { type: "agent_start" },
    { type: "agent_end", isTerminal: true },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["error", "completed"]);
});

test("every blocking dialog method asks for input; non-blocking UI frames do not", () => {
  const blocking = ["select", "confirm", "input", "editor", "open_url"].map((method) => ({ type: "extension_ui_request", id: method, method, title: `${method}?` }));
  const events = run([
    ...blocking,
    { type: "extension_ui_request", id: "ask", method: "ask", questions: [{ id: "q", question: "Ship it?", options: [] }] },
    { type: "extension_ui_request", id: "n", method: "notify", message: "fyi" },
    { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k" },
    { type: "extension_ui_request", id: "p", method: "__proto__", title: "x" },
  ]);
  assert.deepEqual(summary(events), [
    ["input", "select?"], ["input", "confirm?"], ["input", "input?"], ["input", "editor?"], ["input", "open_url?"], ["input", "Ship it?"],
  ]);
});

test("a fallback takes its reason from the retry error omp sends right after it", () => {
  // omp's order: retry_fallback_applied, then auto_retry_start for the same failure.
  const events = run([
    { type: "auto_retry_start", attempt: 1, errorMessage: "429 rate limit, retry in 2s" },
    { type: "auto_retry_end", success: true },
    { type: "retry_fallback_applied", from: "anthropic/fable", to: "anthropic/opus", role: "default" },
    { type: "auto_retry_start", attempt: 2, errorMessage: "Request refused by the safety classifier" },
  ]);
  assert.deepEqual(events.map((event) => [event.from, event.to, event.detail]), [["anthropic/fable", "anthropic/opus", "Request refused by the safety classifier"]]);
});

test("an explicit fallback reason wins; a fallback with no following retry has none", () => {
  const events = run([
    { type: "retry_fallback_applied", from: "a/x", to: "b/y", reason: "usage reserve reached" },
    { type: "auto_retry_start", errorMessage: "ignored for the explicit reason" },
    { type: "retry_fallback_applied", from: "a/x", to: "b/y" },
    { type: "prompt_result", agentInvoked: true, status: "completed" },
    { type: "retry_fallback_applied", from: "a/x" },
  ]);
  assert.deepEqual(summary(events), [["modelSwitch", "usage reserve reached"], ["modelSwitch", undefined]]);
});

test("prewalk and plan hand-offs notify as model switches; other notices do not", () => {
  const events = run([
    { type: "notice", level: "info", source: "prewalk", message: "Prewalk: switched to openai/gpt-5 after first edit call." },
    { type: "notice", level: "info", source: "plan-yolo", message: "Plan-yolo: plan approved, switched to openai/gpt-5." },
    { type: "notice", level: "error", source: "session-persistence", message: "disk full" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["modelSwitch", "modelSwitch"]);
});

test("untrusted prefs fall back to defaults field by field", () => {
  assert.deepEqual(parseNotificationPrefs({ enabled: true, types: { input: false, bogus: true }, whenActive: "loud", locale: "<script>" }), {
    enabled: true,
    types: { completed: true, input: false, error: true, modelSwitch: false },
    whenActive: "toast",
    locale: "en",
  });
});

test("rendered notifications open their session and clip long details", () => {
  const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ""}`;
  const rendered = renderNotification({ type: "error", sessionId: "a b", sessionName: null, detail: "x".repeat(500) }, t);
  assert.equal(rendered.url, "/?session=a%20b");
  assert.equal(rendered.title, "notifications.untitledSession");
  assert.equal(rendered.tag, "a b:error");
  assert.ok(rendered.body.length < 260, rendered.body);
});

test("a pasted overlong session name is clipped so push payloads stay small", () => {
  const rendered = renderNotification({ type: "completed", sessionId: "s1", sessionName: "y".repeat(60_000) }, (key) => key);
  assert.equal(rendered.title.length, 100);
  assert.ok(rendered.title.endsWith("…"));
  assert.equal(renderNotification({ type: "completed", sessionId: "s1", sessionName: "Fix bug" }, (key) => key).title, "Fix bug");
});

test("answerable notification dialogs preserve exact option labels and request identity", () => {
  const labels = ["  Keep spacing  ", "two\nlines"];
  const dialog = buildNotificationDialog({ id: "question", method: "select", title: "Choose", options: [{ label: labels[0] }, labels[1]], expiresAt: 12345 });
  assert.deepEqual(dialog, { requestId: "question", method: "select", title: "Choose", options: labels, expiresAt: 12345 });
  const rendered = renderNotification({ ...session, type: "input", requestId: "question", dialog }, (key) => key);
  assert.deepEqual(rendered.actions, [{ action: "option-0", title: labels[0] }, { action: "option-1", title: labels[1] }]);
  assert.deepEqual(rendered.responses, { "option-0": { value: labels[0] }, "option-1": { value: labels[1] } });
});

test("oversize, incomplete and ambiguous dialogs are open-only rather than partially answerable", () => {
  for (const frame of [
    { id: " question", method: "confirm", title: "Confirm?" },
    { id: "question", method: "__proto__", title: "Unsafe?" },
    { id: "question", method: "select", options: Array.from({ length: 13 }, (_, n) => String(n)) },
    { id: "question", method: "select", options: ["too long".repeat(100)] },
    { id: "question", method: "ask", questions: [{ id: "q", question: "One" }, { id: "q", question: "Two" }] },
    { id: "question", method: "ask", questions: [{ id: " q", question: "One" }] },
  ]) assert.equal(buildNotificationDialog(frame), undefined, JSON.stringify(frame));
  const tooManyButtons = buildNotificationDialog({ id: "question", method: "select", title: "Choose", options: ["A", "B", "C"] });
  assert.ok(tooManyButtons, "native clients still receive the complete representable dialog");
  assert.equal(renderNotification({ ...session, type: "input", dialog: tooManyButtons }, (key) => key).actions, undefined, "system notifications open the session if the choices cannot fit two buttons");
});

test("ask payloads preserve all question ids, labels and custom-answer policy", () => {
  const dialog = buildNotificationDialog({
    id: "ask-1", method: "ask",
    questions: [{ id: "first", question: "Choose", options: [{ label: " A " }], multi: true, allowCustom: false }, { id: "second", question: "Explain", options: [] }],
  });
  assert.deepEqual(dialog.questions, [{ id: "first", question: "Choose", options: [" A "], multi: true }, { id: "second", question: "Explain", allowCustom: true }]);
});

test("detected inputs carry a retraction id even when open_url has no answerable dialog", () => {
  const [url, confirm] = run([
    { type: "extension_ui_request", id: "url", method: "open_url", title: "Visit link" },
    { type: "extension_ui_request", id: "confirm", method: "confirm", title: "Continue?", message: "Confirm the operation" },
  ]);
  assert.equal(url.requestId, "url");
  assert.equal(url.dialog, undefined);
  assert.equal(confirm.dialog.method, "confirm");
  const rendered = renderNotification(confirm, (key) => `translated:${key}`);
  assert.deepEqual(rendered.actions, [{ action: "confirm", title: "translated:chatWindow.confirm" }, { action: "decline", title: "translated:chatWindow.cancel" }]);
  assert.deepEqual(rendered.responses, { confirm: { confirmed: true }, decline: { confirmed: false } });
});
