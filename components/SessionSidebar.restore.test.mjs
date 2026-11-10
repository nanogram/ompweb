import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, render, screen, waitFor, fireEvent } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { translate } = await import("@/lib/i18n");
const { getLastViewedSession, setLastViewedSession, clearLastViewedSession, getRestoreLastChat } = await import("@/lib/workspace-memory");
const { getInitialNavigation } = await import("@/lib/initial-navigation");
afterEach(cleanup);
const noop = () => {};
function environment(t) {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  t.after(() => { globalThis.Worker = previousWorker; });
}
const base = { selectedSessionId: null, addProjectOpen: false, setAddProjectOpen: noop, onSelectSession: noop, usageVisible: false };

function fastRestoreRetries(t) {
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => originalTimeout(fn, delay === 1000 ? 0 : delay, ...args));
}

function fixtureSession(overrides = {}) {
  return { id: "target", hostId: "owner", path: "/fixture/chat.jsonl", cwd: "/worktrees/feature", projectRoot: "/repo", projectKey: "/repo", name: "Target chat", firstMessage: "hi", messageCount: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", ...overrides };
}

test("remote remembered chat survives transient owner failure, then only confirmed absence clears it", async (t) => {
  environment(t);
  fastRestoreRetries(t);
  setLastViewedSession({ sessionId: "remembered", hostId: "owner", workspace: "owner:/repo" });
  t.after(() => clearLastViewedSession("remembered"));
  let ownerAvailable = false;
  const lookups = [];
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (target.searchParams.has("id")) {
        lookups.push(target);
        return ownerAvailable ? Response.json({ sessions: [] }) : Response.json({ error: "host unavailable" }, { status: 503 });
      }
      return Response.json({ sessions: [] });
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const missing = [];
  const done = [];
  const props = { ...base, initialSessionId: "remembered", initialHostId: "owner", onInitialSessionMissing: id => { missing.push(id); clearLastViewedSession(id); }, onInitialRestoreDone: () => done.push(true) };
  const view = render(React.createElement(SessionSidebar, { ...props, refreshKey: 0 }));
  await screen.findByRole("alert", {}, { timeout: 15_000 });
  assert.equal(getLastViewedSession()?.sessionId, "remembered");
  assert.deepEqual(missing, []);
  assert.deepEqual(done, []);
  assert.equal(lookups.at(-1).searchParams.get("id"), "remembered");
  assert.equal(lookups.at(-1).searchParams.get("hostId"), "owner");
  ownerAvailable = true;
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 1 }));
  await waitFor(() => assert.deepEqual(missing, ["remembered"]), { timeout: 5000 });
  assert.equal(getLastViewedSession(), null);
  assert.deepEqual(done, [true]);
});

test("restoring a remote worktree chat retains cwd, project root and host without goal callbacks", async (t) => {
  environment(t);
  const session = { id: "worktree", path: "/fixture/chat.jsonl", cwd: "/worktrees/feature", projectRoot: "/repo", projectKey: "/repo", hostId: "owner", worktreeBranch: "feature", name: "Remote feature", firstMessage: "hi", messageCount: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" };
  t.mock.method(globalThis, "fetch", async url => {
    if (new URL(String(url), "http://fixture").pathname === "/api/sessions") return Response.json({ sessions: [session] });
    if (String(url) === "/api/projects") return Response.json({ projects: [{ path: "/repo", hostId: "owner" }] });
    return Response.json({});
  });
  const opened = [];
  const cwd = [];
  render(React.createElement(SessionSidebar, { ...base, initialSessionId: session.id, initialHostId: "owner", onSelectSession: (...args) => opened.push(args), onCwdChange: (...args) => cwd.push(args) }));
  await waitFor(() => assert.equal(opened.length, 1));
  assert.deepEqual(opened[0], [session, true]);
  await waitFor(() => assert.ok(cwd.some(([path, root, host]) => path === session.cwd && root === "/repo" && host === "owner")));
});

test("failed session lists recover on foreground and online without a forever loading state", async (t) => {
  environment(t);
  const pendingLists = [];
  const errors = [];
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url) === "/api/sessions") return new Promise(resolve => pendingLists.push(resolve));
    if (String(url) === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  // Flush the response and its passive shell notification together, rather
  // than treating a DOM mutation as evidence that the effect has also run.
  const respond = async response => {
    assert.equal(pendingLists.length, 1, "the recovery event starts one session-list request");
    await act(async () => { pendingLists.shift()(response); });
  };
  await act(async () => {
    render(React.createElement(SessionSidebar, { ...base, onLoadErrorChange: error => errors.push(error) }));
  });
  await respond(Response.json({}, { status: 503 }));
  assert.ok(screen.getByRole("alert"));
  assert.ok(errors.at(-1));
  await act(async () => { fireEvent(window, new Event("online")); });
  assert.ok(screen.getByRole("alert"), "the failure remains actionable while retrying");
  await respond(Response.json({ sessions: [] }));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(errors.at(-1), null);
  await act(async () => { fireEvent(window, new Event("online")); });
  await respond(Response.json({}, { status: 503 }));
  assert.ok(screen.getByRole("alert"));
  assert.ok(errors.at(-1));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  t.after(() => { delete document.visibilityState; });
  await act(async () => { fireEvent(document, new Event("visibilitychange")); });
  await respond(Response.json({ sessions: [] }));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(errors.at(-1), null);
  assert.equal(screen.queryByRole("status", { name: translate("sessionSidebar.loading") }), null);
});

test("a listening but non-responsive sessions endpoint reaches a visible retryable error", async (t) => {
  environment(t);
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => originalTimeout(fn, delay === 15_000 ? 0 : delay, ...args));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "/api/sessions") return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    if (String(url) === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  render(React.createElement(SessionSidebar, base));
  await screen.findByRole("alert");
  assert.equal(screen.queryByRole("status", { name: translate("sessionSidebar.loading") }), null);
  assert.ok(screen.getAllByRole("button", { name: translate("sessionSidebar.refresh") }).some(button => !button.disabled));
});

test("existing deployed opt-in restores its raw local id, then viewing a remote chat persists that owner", async (t) => {
  environment(t);
  window.localStorage.setItem("omp-web:restore-last-chat", "true");
  window.localStorage.setItem("omp-web:last-viewed-session", "legacy-chat");
  t.after(() => {
    window.localStorage.removeItem("omp-web:restore-last-chat");
    window.localStorage.removeItem("omp-web:last-viewed-session");
  });
  const local = { id: "legacy-chat", hostId: "local", path: "/fixture/local.jsonl", cwd: "/worktrees/local", projectRoot: "/repo", projectKey: "/repo", name: "Legacy chat", firstMessage: "hi", messageCount: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z" };
  const remote = { ...local, id: "remote-next", hostId: "owner", cwd: "/remote/worktree", projectRoot: "/remote/repo", projectKey: "/remote/repo", name: "Remote next chat" };
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") return Response.json({ sessions: target.searchParams.has("id") ? [local, remote].filter(session => session.id === target.searchParams.get("id")) : [local, remote] });
    if (String(url) === "/api/projects") return Response.json({ projects: [{ path: "/repo" }, { path: "/remote/repo", hostId: "owner" }] });
    return Response.json({});
  });
  const startup = getInitialNavigation(new URLSearchParams(), getRestoreLastChat() ? getLastViewedSession() : null);
  assert.equal(startup.sessionId, local.id);
  assert.equal(startup.hostId, "local");
  assert.equal(getLastViewedSession().workspace, undefined, "migration does not invent a workspace");
  const opened = [];
  const props = { ...base, initialSessionId: startup.sessionId, initialHostId: startup.hostId, onSelectSession: session => opened.push(session) };
  const view = render(React.createElement(SessionSidebar, props));
  await waitFor(() => assert.deepEqual(opened, [local]));
  view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: local.id }));
  await waitFor(() => assert.equal(getLastViewedSession().workspace, "/repo"));
  view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: remote.id }));
  await waitFor(() => assert.deepEqual(getLastViewedSession(), { sessionId: remote.id, hostId: "owner", workspace: "owner:/remote/repo" }));
  assert.deepEqual(getInitialNavigation(new URLSearchParams(), getLastViewedSession()), { requestedCwd: null, sessionId: remote.id, hostId: "owner" });
});

test("known owner restores once before delayed aggregate sessions and projects settle", async (t) => {
  environment(t);
  const session = fixtureSession();
  let finishSessions;
  let finishProjects;
  const lookups = [];
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (!target.searchParams.has("id")) return new Promise(resolve => { finishSessions = resolve; });
      lookups.push(target);
      return Response.json({ sessions: [session] });
    }
    if (target.pathname === "/api/projects") return new Promise(resolve => { finishProjects = resolve; });
    return Response.json({});
  });
  const opened = [];
  const cwd = [];
  const props = { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: (...args) => opened.push(args), onCwdChange: (...args) => cwd.push(args) };
  const view = render(React.createElement(SessionSidebar, props));
  await waitFor(() => assert.deepEqual(opened, [[session, true]]));
  assert.ok(screen.getByRole("status", { name: translate("sessionSidebar.loading") }));
  await waitFor(() => assert.ok(cwd.some(([path, root, host]) => path === session.cwd && root === session.projectRoot && host === session.hostId)));
  assert.equal(lookups[0].searchParams.get("id"), session.id);
  assert.equal(lookups[0].searchParams.get("hostId"), session.hostId);
  await act(async () => {
    finishSessions(Response.json({ sessions: [] }));
    finishProjects(Response.json({ projects: [{ path: "/repo", hostId: session.hostId }] }));
  });
  view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: session.id }));
  await waitFor(() => assert.deepEqual(getLastViewedSession(), { sessionId: session.id, hostId: session.hostId, workspace: "owner:/repo" }));
  t.after(() => clearLastViewedSession(session.id));
  assert.deepEqual(opened, [[session, true]]);
});

test("an owner failure cannot restore a stale aggregate row or disappear behind list success", async (t) => {
  environment(t);
  const session = fixtureSession();
  let available = false;
  let finishSessions;
  const errors = [];
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (target.searchParams.has("id")) return available ? Response.json({ sessions: [session] }) : Response.json({ error: "owner unavailable" }, { status: 503 });
      return new Promise(resolve => { finishSessions = resolve; });
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [{ path: "/repo", hostId: session.hostId }] });
    return Response.json({});
  });
  const opened = [];
  const missing = [];
  const props = { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id), onLoadErrorChange: error => errors.push(error) };
  const view = render(React.createElement(SessionSidebar, { ...props, refreshKey: 0 }));
  await screen.findByRole("alert");
  await act(async () => { finishSessions(Response.json({ sessions: [session] })); });
  assert.ok(screen.getByRole("alert"));
  assert.ok(errors.at(-1));
  assert.deepEqual(opened, []);
  assert.deepEqual(missing, []);
  available = true;
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 1 }));
  await waitFor(() => {
    assert.deepEqual(opened, [session]);
    assert.equal(screen.queryByRole("alert"), null);
    assert.equal(errors.at(-1), null);
  });
  await act(async () => { finishSessions(Response.json({ sessions: [session] })); });
});

test("id-only deep links use fresh owner metadata, not the aggregate discovery row", async (t) => {
  environment(t);
  const stale = fixtureSession({ name: "Stale title" });
  const fresh = { ...stale, name: "Fresh owner title", cwd: "/worktrees/fresh" };
  let finishOwner;
  const lookups = [];
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (!target.searchParams.has("id")) return Response.json({ sessions: [stale] });
      lookups.push(target);
      if (target.searchParams.get("hostId") === stale.hostId) return new Promise(resolve => { finishOwner = resolve; });
      return Response.json({ sessions: [stale] });
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const opened = [];
  render(React.createElement(SessionSidebar, { ...base, initialSessionId: stale.id, onSelectSession: session => opened.push(session) }));
  await waitFor(() => assert.ok(finishOwner));
  assert.deepEqual(opened, []);
  assert.equal(lookups[0].searchParams.has("hostId"), false);
  await act(async () => { finishOwner(Response.json({ sessions: [fresh] })); });
  assert.deepEqual(opened, [fresh]);
});

for (const [label, rows] of [
  ["foreign-owner", [fixtureSession({ hostId: "foreign" })]],
  ["unrelated-id", [fixtureSession({ id: "unrelated" })]],
]) {
  test(`${label} rows never satisfy a known-owner restore`, async (t) => {
    environment(t);
    fastRestoreRetries(t);
    const opened = [];
    const missing = [];
    const done = [];
    t.mock.method(globalThis, "fetch", async url => {
      const target = new URL(String(url), "http://fixture");
      if (target.pathname === "/api/sessions") return Response.json({ sessions: rows });
      if (target.pathname === "/api/projects") return Response.json({ projects: [] });
      return Response.json({});
    });
    render(React.createElement(SessionSidebar, { ...base, initialSessionId: "target", initialHostId: "owner", onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id), onInitialRestoreDone: () => done.push(true) }));
    await waitFor(() => assert.deepEqual(missing, ["target"]), { timeout: 5000 });
    assert.deepEqual(opened, []);
    assert.deepEqual(done, [true]);
  });
}

test("a newly flushed owner session is retried without waiting for aggregate metadata", async (t) => {
  environment(t);
  fastRestoreRetries(t);
  const session = fixtureSession();
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (target.searchParams.has("id")) return Response.json({ sessions: ++lookups === 1 ? [] : [session] });
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const opened = [];
  const missing = [];
  render(React.createElement(SessionSidebar, { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id) }));
  await waitFor(() => assert.deepEqual(opened, [session]), { timeout: 5000 });
  assert.deepEqual(missing, []);
  assert.ok(screen.getByRole("status", { name: translate("sessionSidebar.loading") }));
});

for (const [label, selection] of [
  ["another selected chat", { selectedSessionId: "later", selectedCwd: "/later", selectedHostId: "later-owner" }],
  ["a new-chat workspace", { selectedSessionId: null, selectedCwd: "/later", selectedHostId: "later-owner" }],
]) {
  test(`later navigation to ${label} wins over a stale targeted completion`, async (t) => {
    environment(t);
    const session = fixtureSession();
    let finishOwner;
    let signal;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      const target = new URL(String(url), "http://fixture");
      if (target.pathname === "/api/sessions") {
        if (!target.searchParams.has("id")) return Response.json({ sessions: [] });
        signal = options.signal;
        return new Promise(resolve => { finishOwner = resolve; });
      }
      if (target.pathname === "/api/projects") return Response.json({ projects: [] });
      return Response.json({});
    });
    const opened = [];
    const missing = [];
    const done = [];
    const cwd = [];
    const props = { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id), onInitialRestoreDone: () => done.push(true), onCwdChange: path => cwd.push(path) };
    const view = render(React.createElement(SessionSidebar, props));
    await waitFor(() => assert.ok(finishOwner));
    view.rerender(React.createElement(SessionSidebar, { ...props, ...selection }));
    assert.equal(signal.aborted, true);
    await act(async () => { finishOwner(Response.json({ sessions: [session] })); });
    assert.deepEqual(opened, []);
    assert.deepEqual(missing, []);
    assert.deepEqual(done, [true]);
    assert.equal(cwd.at(-1), "/later");
  });
}

test("a sidebar session click owns navigation before its parent rerenders", async (t) => {
  environment(t);
  const session = fixtureSession({ hostId: "local" });
  const later = fixtureSession({ id: "later", hostId: "local", cwd: "", projectRoot: "", projectKey: "", name: "Later chat" });
  let finishOwner;
  t.mock.method(globalThis, "fetch", async url => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (target.searchParams.has("id")) return new Promise(resolve => { finishOwner = resolve; });
      return Response.json({ sessions: [later] });
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const opened = [];
  render(React.createElement(SessionSidebar, { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session) }));
  fireEvent.click(await screen.findByText(later.name));
  assert.deepEqual(opened, [later]);
  await act(async () => { finishOwner(Response.json({ sessions: [session] })); });
  assert.deepEqual(opened, [later]);
});

test("StrictMode cleanup aborts only its own lookup and never selects its late result", async (t) => {
  environment(t);
  const session = fixtureSession();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (target.searchParams.has("id")) return new Promise(resolve => requests.push({ resolve, signal: options.signal }));
      return Response.json({ sessions: [] });
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const opened = [];
  const props = { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session) };
  render(React.createElement(React.StrictMode, null, React.createElement(SessionSidebar, props)));
  await waitFor(() => assert.ok(requests.length >= 2));
  const active = requests.at(-1);
  assert.equal(active.signal.aborted, false);
  await act(async () => {
    for (const request of requests.slice(0, -1)) {
      assert.equal(request.signal.aborted, true);
      request.resolve(Response.json({ sessions: [{ ...session, name: "Abandoned response" }] }));
    }
  });
  assert.deepEqual(opened, []);
  assert.equal(active.signal.aborted, false);
  await act(async () => { active.resolve(Response.json({ sessions: [session] })); });
  assert.deepEqual(opened, [session]);
});

test("a timed-out owner lookup remains retryable without treating absence as confirmed", async (t) => {
  environment(t);
  const session = fixtureSession();
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay, ...args) => originalTimeout(fn, delay === 15_000 ? 0 : delay, ...args));
  let responsive = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = new URL(String(url), "http://fixture");
    if (target.pathname === "/api/sessions") {
      if (!target.searchParams.has("id")) return Response.json({ sessions: [session] });
      if (responsive) return Response.json({ sessions: [session] });
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    if (target.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const opened = [];
  const missing = [];
  const done = [];
  render(React.createElement(SessionSidebar, { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id), onInitialRestoreDone: () => done.push(true) }));
  await screen.findByRole("alert");
  assert.deepEqual(opened, []);
  assert.deepEqual(missing, []);
  assert.deepEqual(done, []);
  responsive = true;
  fireEvent(window, new Event("online"));
  await waitFor(() => {
    assert.deepEqual(opened, [session]);
    assert.equal(screen.queryByRole("alert"), null);
  });
});

for (const status of [401, 403]) {
  test(`HTTP ${status} from the owner does not select a cached chat or confirm its deletion`, async (t) => {
    environment(t);
    const session = fixtureSession();
    const opened = [];
    const missing = [];
    const done = [];
    t.mock.method(globalThis, "fetch", async url => {
      const target = new URL(String(url), "http://fixture");
      if (target.pathname === "/api/sessions") return target.searchParams.has("id")
        ? Response.json({ error: "not authorized" }, { status })
        : Response.json({ sessions: [session] });
      if (target.pathname === "/api/projects") return Response.json({ projects: [] });
      return Response.json({});
    });
    render(React.createElement(SessionSidebar, { ...base, initialSessionId: session.id, initialHostId: session.hostId, onSelectSession: session => opened.push(session), onInitialSessionMissing: id => missing.push(id), onInitialRestoreDone: () => done.push(true) }));
    await screen.findByRole("alert");
    assert.deepEqual(opened, []);
    assert.deepEqual(missing, []);
    assert.deepEqual(done, []);
  });
}
