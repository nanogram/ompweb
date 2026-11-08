import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-session-list-activity-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET } = await import("../app/api/sessions/route.ts");
const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const { closeHostLink, flushLinkSamples } = await import("./hosts/hub.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
const { closeNotificationStore } = await import("./notification-store.ts");

test.after(() => {
  closeHostLink("local");
  flushLinkSamples();
  closeOutboxStore();
  closeNotificationStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const diskSession = {
  id: "0a000000-0000-4000-8000-000000000091",
  path: "/fixture/session.jsonl", cwd: "/fixture/project",
  created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1, firstMessage: "task", activityStatus: "completed",
};

function isolateLiveState(t) {
  const previousSessions = globalThis.__ompSessions;
  const previousActivities = globalThis.__ompSessionActivities;
  const previousLists = globalThis.__ompHostLists;
  globalThis.__ompSessions = new Map();
  globalThis.__ompSessionActivities = new Map();
  globalThis.__ompHostLists = undefined;
  t.after(() => {
    closeHostLink("local");
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompSessionActivities = previousActivities;
    globalThis.__ompHostLists = previousLists;
  });
}

test("session lists include retained remote outcomes and activity changes invalidate conditional responses", async (t) => {
  isolateLiveState(t);
  await linkLocalDaemon({ listSessions: async () => [diskSession] });
  const remote = { id: "remote-run", cwd: "/remote/project", hostId: "remote-fixture", status: "quota", detail: "usage limit reached", updatedAt: 1 };
  globalThis.__ompSessionActivities.set(remote.id, remote);
  const first = await GET(new Request("http://localhost/api/sessions"));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const body = await first.json();
  assert.equal(body.sessions[0].activityStatus, "completed", "disk fallback remains separate from live outcomes");
  assert.deepEqual(body.sessionActivities, [remote]);
  assert.deepEqual(body.runningSessionIds, []);
  const etag = first.headers.get("etag");
  assert.equal((await GET(new Request("http://localhost/api/sessions", { headers: { "if-none-match": etag } }))).status, 304);
  globalThis.__ompSessionActivities.set(remote.id, { ...remote, status: "waiting_input", updatedAt: 2 });
  const changed = await GET(new Request("http://localhost/api/sessions", { headers: { "if-none-match": etag } }));
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.equal((await changed.json()).sessionActivities[0].status, "waiting_input");
});

test("targeted session navigation filters only disk rows, retaining complete running and activity metadata", async (t) => {
  isolateLiveState(t);
  await linkLocalDaemon({ listSessions: async () => [diskSession] });
  const running = { id: "other-running", cwd: "/remote/project", hostId: "remote-fixture" };
  const activity = { ...running, status: "error", detail: "provider failed", updatedAt: 3 };
  globalThis.__ompSessions.set(running.id, {
    sessionId: running.id, cwd: running.cwd, host: { id: running.hostId },
    isRunning: () => true, isAlive: () => true, getActivity: () => ({ ...activity }),
  });
  const response = await GET(new Request(`http://localhost/api/sessions?id=${diskSession.id}&hostId=local`, { headers: { "if-none-match": "anything" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), null);
  const body = await response.json();
  assert.deepEqual(body.sessions.map((session) => [session.id, session.hostId]), [[diskSession.id, "local"]]);
  assert.deepEqual(body.runningSessions, [running]);
  assert.deepEqual(body.runningSessionIds, [running.id]);
  assert.deepEqual(body.sessionActivities, [activity]);
  const missing = await GET(new Request("http://localhost/api/sessions?id=missing&hostId=local"));
  assert.equal(missing.status, 200);
  assert.deepEqual((await missing.json()).sessions, []);
});

test("remembered-session lookup distinguishes an unavailable owning host from authoritative absence", async (t) => {
  isolateLiveState(t);
  await linkLocalDaemon({ listSessions: async () => { throw new Error("host list unavailable"); } });
  const failed = await GET(new Request(`http://localhost/api/sessions?id=${diskSession.id}&hostId=local`));
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, "host_sessions_unavailable");
  closeHostLink("local");
  const offline = await GET(new Request(`http://localhost/api/sessions?id=${diskSession.id}&hostId=local`));
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).code, "host_offline");
  const unknown = await GET(new Request(`http://localhost/api/sessions?id=${diskSession.id}&hostId=unknown-owner`));
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).code, "host_offline");
});
