import assert from "node:assert/strict";
import test from "node:test";
const { createSessionCatchUp } = await import("./useAgentSession-sync.ts");
const { selectSessionHistory } = await import("../lib/session-sync.ts");

const boundedWindow = (startOffset = 900) => ({ maxBytes: 134217728, startOffset, endOffset: startOffset + 134217728 });
const savedHistory = (ids, historyWindow) => ({
  messages: ids.map((id) => ({ role: "user", content: id })),
  entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  ...(historyWindow ? { historyWindow } : {}),
});
const responsePage = (page) => ({ ok: true, json: async () => ({ sessionId: "s1", leafId: null, live: null, ...page }) });
const requestCursor = (url) => JSON.parse(new URL(url, "http://localhost").searchParams.get("cursor"));

test("bounded catch-up publishes rows and disclosure atomically, rolls over, clears metadata and unpins completion", async (t) => {
  let saved = savedHistory(["b", "c", "d"], boundedWindow());
  const published = [];
  let release;
  let started;
  const held = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1;
    const base = requestCursor(url);
    const page = selectSessionHistory(saved, base, 2);
    if (calls === 2) {
      assert.equal(base.windowEndOffset, saved.historyWindow.endOffset);
      return new Promise((resolve) => { release = () => resolve(responsePage(page)); started(); });
    }
    return responsePage(page);
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history: (next) => published.push(next),
    live() {}, subscribe: () => false,
  });
  const initial = savedHistory(["old"], boundedWindow(100));
  catchUp.seed(initial);
  const pending = catchUp.request();
  await held;
  assert.equal(published.length, 1);
  assert.equal(catchUp.history(), initial);
  release();
  await pending;
  assert.deepEqual(published.at(-1), saved);
  assert.deepEqual(catchUp.position(), { firstEntryId: "b", lastEntryId: "d" });
  saved = savedHistory(["d", "e"], boundedWindow(2000));
  await catchUp.request();
  assert.deepEqual(published.at(-1), saved);
  assert.deepEqual(published.at(-1).entryIds, ["d", "e"], "rolled-out rows cannot survive replacement");
  saved = savedHistory(["d", "e", "f"]);
  await catchUp.request();
  assert.deepEqual(published.at(-1), saved);
  assert.equal(Object.hasOwn(published.at(-1), "historyWindow"), false);
  assert.deepEqual(catchUp.position(), { firstEntryId: "d", lastEntryId: "f" });
});

test("a moving byte window with surviving cursor IDs appends without reloading retained bodies", async (t) => {
  const old = savedHistory(["a", "old"], boundedWindow(100));
  const next = savedHistory(["a", "old", "new"], boundedWindow(200));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1;
    const page = selectSessionHistory(next, requestCursor(url));
    assert.deepEqual(page.context.entryIds, ["new"]);
    return responsePage(page);
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false,
  });
  catchUp.seed(old);
  await catchUp.request();
  assert.equal(calls, 1);
  assert.deepEqual(catchUp.history(), next);
});

for (const invalid of ["replacement", "moving window", "nonadvancing", "invalid pin"]) {
  test(`${invalid} pagination stops without publishing incomplete replacement metadata`, async (t) => {
    const initial = savedHistory(["old"]);
    const window = boundedWindow();
    const published = [];
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      assert.ok(calls <= 2, "malformed pagination must terminate");
      const first = calls === 1 || invalid === "nonadvancing";
      return responsePage({
        mode: first || invalid === "replacement" ? "replace" : "append",
        baseEntryId: first || invalid === "replacement" ? null : "a",
        context: savedHistory([first ? "a" : "b"], invalid === "moving window" && calls === 2 ? boundedWindow(901) : window),
        cursor: { firstEntryId: "a", lastEntryId: first ? "a" : "b", windowEndOffset: invalid === "invalid pin" ? -1 : window.endOffset },
        hasMore: true,
      });
    });
    const catchUp = createSessionCatchUp({
      sessionId: () => "s1", scope: () => "view", history: (next) => published.push(next),
      live() {}, subscribe: () => false,
    });
    catchUp.seed(initial);
    assert.equal(await catchUp.request(), null);
    assert.equal(catchUp.history(), initial);
    assert.deepEqual(published, [initial]);
    assert.equal(Object.hasOwn(catchUp.position(), "windowEndOffset"), false);
    assert.equal(calls, invalid === "invalid pin" ? 1 : 2);
  });
}

const recentCursor = (first = "c", last = "d") => ({ firstEntryId: first, lastEntryId: last, contextFirstEntryId: "a" });
const olderPage = (overrides = {}) => ({
  mode: "prepend", baseEntryId: "c", context: savedHistory(["a", "b"]),
  cursor: recentCursor("a"), hasMore: false, hasOlder: false, ...overrides,
});

test("recent overview cursor is reused for forward deltas; older bodies are strictly on demand", async (t) => {
  const requests = [];
  let snapshot;
  t.mock.method(globalThis, "fetch", async (url) => {
    const params = new URL(url, "http://localhost").searchParams;
    requests.push(params);
    assert.equal(params.get("recent"), "1");
    if (params.get("direction") === "older") return responsePage(olderPage());
    assert.deepEqual(requestCursor(url), recentCursor());
    return responsePage({ mode: "append", baseEntryId: "d", context: savedHistory([]), cursor: recentCursor(), hasMore: false, hasOlder: true });
  });
  const sync = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "view",
    history(next) { snapshot = next; }, live() {}, subscribe: () => false,
  });
  sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
  assert.equal(requests.length, 0);
  await sync.request();
  assert.deepEqual(snapshot.entryIds, ["c", "d"]);
  assert.equal(requests.length, 1);
  assert.equal(sync.hasOlder(), true);
  let anchored = 0;
  await sync.older(() => { anchored++; });
  assert.deepEqual(snapshot.entryIds, ["a", "b", "c", "d"]);
  assert.equal(sync.hasOlder(), false);
  assert.equal(anchored, 1);
  assert.deepEqual(sync.position(), recentCursor("a"));
});

test("older failure preserves current transcript and exposes a retry; stale-window replacement never prepends", async (t) => {
  let call = 0;
  const states = [];
  t.mock.method(globalThis, "fetch", async () => {
    if (++call === 1) throw new Error("offline");
    return responsePage(olderPage({ mode: "replace", baseEntryId: null, context: savedHistory(["replacement"]), cursor: { firstEntryId: "replacement", lastEntryId: "replacement", contextFirstEntryId: "replacement" } }));
  });
  const sync = createSessionCatchUp({ sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false, paging: (state) => states.push(state) });
  sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
  assert.equal(await sync.older(), false);
  assert.deepEqual(sync.history().entryIds, ["c", "d"]);
  assert.deepEqual(states.at(-1), { hasOlder: true, loadingOlder: false, error: true });
  let anchored = false;
  assert.equal(await sync.older(() => { anchored = true; }), true);
  assert.deepEqual(sync.history().entryIds, ["replacement"]);
  assert.equal(anchored, false, "replacement cannot scroll-anchor an unrelated branch as a prepend");
});

for (const race of ["view", "run", "stream", "forward"]) {
  test(`older response cannot cross a ${race} fence`, async (t) => {
    let scope = "run1";
    let release;
    let started;
    const held = new Promise((resolve) => { started = resolve; });
    t.mock.method(globalThis, "fetch", async (url) => {
      if (new URL(url, "http://localhost").searchParams.has("direction")) return new Promise((resolve) => { release = () => resolve(responsePage(olderPage())); started(); });
      return responsePage({ mode: "append", baseEntryId: "d", context: savedHistory(["e"]), cursor: recentCursor("c", "e"), hasMore: false, hasOlder: true });
    });
    const sync = createSessionCatchUp({ sessionId: () => "s1", scope: () => scope, history() {}, live() {}, subscribe: () => false });
    sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
    sync.observe({ type: "connected", web: { streamId: "old", sequence: 0 } });
    let anchored = false;
    const pending = sync.older(() => { anchored = true; });
    await held;
    if (race === "view") sync.select({ leafId: "branch", includePreCompaction: true });
    if (race === "run") { scope = "run2"; sync.invalidate(); }
    if (race === "stream") sync.observe({ type: "connected", web: { streamId: "new", sequence: 0 } });
    if (race === "forward") await sync.request();
    release();
    assert.equal(await pending, false);
    assert.equal(anchored, false);
    assert.deepEqual(sync.history()?.entryIds ?? [], race === "view" ? [] : race === "forward" ? ["c", "d", "e"] : ["c", "d"]);
  });
}

for (const status of [404, 401, 403, 503]) {
  test(`HTTP ${status} distinguishes authoritative removal from temporary context failure`, async (t) => {
    let missing = null;
    t.mock.method(globalThis, "fetch", async () => ({ ok: false, status }));
    const sync = createSessionCatchUp({ sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false, missing: (denied) => { missing = denied; } });
    sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
    await sync.request();
    assert.deepEqual(sync.history()?.entryIds ?? [], status === 503 ? ["c", "d"] : []);
    assert.equal(missing, status === 503 ? null : status !== 404);
  });
}

test("an older prepend winning a concurrent forward read retries the delta from its widened cursor", async (t) => {
  let releaseOlder;
  let releaseForward;
  let olderStarted;
  let forwardStarted;
  const olderReady = new Promise((resolve) => { olderStarted = resolve; });
  const forwardReady = new Promise((resolve) => { forwardStarted = resolve; });
  let forwardCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const params = new URL(url, "http://localhost").searchParams;
    if (params.has("direction")) return new Promise((resolve) => { releaseOlder = () => resolve(responsePage(olderPage())); olderStarted(); });
    const base = requestCursor(url);
    const delta = () => responsePage({ mode: "append", baseEntryId: "d", context: savedHistory(["e"]), cursor: recentCursor(base.firstEntryId, "e"), hasOlder: base.firstEntryId !== "a", hasMore: false });
    if (++forwardCalls === 1) return new Promise((resolve) => { releaseForward = () => resolve(delta()); forwardStarted(); });
    assert.equal(base.firstEntryId, "a");
    return delta();
  });
  const sync = createSessionCatchUp({ sessionId: () => "s1", scope: () => "view", history() {}, live() {}, subscribe: () => false });
  sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
  const older = sync.older();
  await olderReady;
  const forward = sync.request();
  await forwardReady;
  releaseOlder();
  await older;
  releaseForward();
  await forward;
  assert.deepEqual(sync.history().entryIds, ["a", "b", "c", "d", "e"]);
  assert.equal(forwardCalls, 2);
  assert.deepEqual(sync.position(), recentCursor("a", "e"));
});

test("an overlapping overview refresh preserves loaded older rows and refreshes its confirmed tail", () => {
  let shown;
  const sync = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view", history(next) { shown = next; },
    live() {}, subscribe: () => false,
  });
  sync.seed(savedHistory(["a", "b", "c", "d"]), null, {
    cursor: { firstEntryId: "a", lastEntryId: "d", contextFirstEntryId: "a" }, hasOlder: false,
  });
  const latest = savedHistory(["c", "d", "e"]);
  latest.messages[0].content = "fresh c";
  sync.seed(latest, sync.position(), {
    cursor: { firstEntryId: "c", lastEntryId: "e", contextFirstEntryId: "a" }, hasOlder: true,
  });
  assert.deepEqual(shown.entryIds, ["a", "b", "c", "d", "e"]);
  assert.equal(shown.messages[2].content, "fresh c");
  assert.equal(sync.hasOlder(), false);
  assert.deepEqual(sync.position(), { firstEntryId: "a", lastEntryId: "e", contextFirstEntryId: "a" });
  sync.seed(savedHistory(["x", "y"]), sync.position(), {
    cursor: { firstEntryId: "x", lastEntryId: "y", contextFirstEntryId: "other-branch" }, hasOlder: true,
  });
  assert.deepEqual(shown.entryIds, ["x", "y"], "a different selected-path anchor must replace, not preserve unrelated rows");
});

test("an overview ahead of the loaded tail reconciles the missing forward gap before publication", async (t) => {
  let shown;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(requestCursor(url).lastEntryId, "d");
    return responsePage({
      mode: "append", baseEntryId: "d", context: savedHistory(["e", "f", "g"]),
      cursor: { firstEntryId: "a", lastEntryId: "g", contextFirstEntryId: "a" },
      hasMore: false, hasOlder: false,
    });
  });
  const sync = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view", history(next) { shown = next; },
    live() {}, subscribe: () => false,
  });
  const original = savedHistory(["a", "b", "c", "d"]);
  sync.seed(original, null, { cursor: { firstEntryId: "a", lastEntryId: "d", contextFirstEntryId: "a" } });
  sync.seed(savedHistory(["f", "g"]), sync.position(), {
    cursor: { firstEntryId: "f", lastEntryId: "g", contextFirstEntryId: "a" }, hasOlder: true,
  });
  assert.deepEqual(shown.entryIds, original.entryIds);
  await sync.request();
  assert.deepEqual(shown.entryIds, ["a", "b", "c", "d", "e", "f", "g"]);
});

test("a temporary HTML gateway failure preserves cached history and older-page retry state", async (t) => {
  let denied = null;
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Temporary gateway outage</html>", {
    status: 503, headers: { "Content-Type": "text/html" },
  }));
  const sync = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view", history() {}, live() {}, subscribe: () => false,
    missing(accessDenied) { denied = accessDenied; },
  });
  sync.seed(savedHistory(["c", "d"]), null, { cursor: recentCursor(), hasOlder: true });
  await sync.request();
  assert.deepEqual(sync.history()?.entryIds, ["c", "d"]);
  assert.equal(denied, null, "an HTML 503 is not evidence that authorization was revoked");
  assert.equal(sync.hasOlder(), true);
  assert.equal(await sync.older(), false);
  assert.deepEqual(sync.history()?.entryIds, ["c", "d"]);
  assert.equal(sync.hasOlder(), true, "the failed older request must remain retryable");
});
