import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";

const calls = [];
const status = { mode: "observe", config: { enabled: false, paused: false, watchedProjects: [], minReviewIntervalMs: 300000 }, session: null, workspaceCwd: "/private/director/workspace", supervisor: "disabled", monitored: [], lastReviewAt: null, nextReviewAt: null, lastError: null, daily: { date: "2026-11-08", reviews: 0, costUsd: null } };
mock.module("./director.ts", () => ({
  getDirectorStatus: async () => { calls.push(["status"]); return status; },
  ensureDirector: async (project) => { calls.push(["ensure", project]); return status; },
  updateDirectorConfig: async (patch) => { calls.push(["configure", patch]); return status; },
  requestDirectorReview: async () => { calls.push(["review"]); return status; },
}));
mock.module("./api-utils.ts", () => ({ apiErrorResponse: (error) => Response.json({ error: String(error) }, { status: 500 }) }));
const { GET, POST } = await import("../app/api/director/route.ts");
const request = (body) => new Request("http://localhost/api/director", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("Director GET only reads passive status and forbids cache reuse", async () => {
  calls.length = 0;
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), status);
  assert.deepEqual(calls, [["status"]]);
});

test("Director actions pass only validated scope/configuration and schedule Review promptly", async () => {
  calls.length = 0;
  assert.equal((await POST(request({ action: "ensure", project: { cwd: "/project", hostId: "local" } }))).status, 200);
  assert.equal((await POST(request({ action: "configure", patch: { enabled: true, watchedProjects: [{ cwd: "/project", hostId: "local" }] } }))).status, 200);
  assert.equal((await POST(request({ action: "review" }))).status, 200);
  assert.deepEqual(calls, [["ensure", { cwd: "/project", hostId: "local" }], ["configure", { enabled: true, watchedProjects: [{ cwd: "/project", hostId: "local" }] }], ["review"]]);
});

test("malformed actions and settings are rejected before invoking backend mutations", async () => {
  calls.length = 0;
  for (const body of [null, [], {}, { action: "send", sessionId: "worker" }, { action: "ensure", project: { cwd: "/project" } }, { action: "ensure", command: "bash" }, { action: "configure" }, { action: "configure", patch: { maxReviewsPerDay: 24 } }, { action: "configure", patch: { dailyBudgetUsd: 2 } }, { action: "configure", patch: { toolNames: ["bash"] } }, { action: "review", sessionId: "worker" }]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = await response.json();
    assert.equal(typeof error.error, "string");
    assert.match(error.code, /^invalid_director_/);
  }
  assert.deepEqual(calls, []);
});

test("bounded JSON rejects oversized chunked bodies and malformed input", async () => {
  calls.length = 0;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"action":"ensure","padding":"${"x".repeat(40000)}"}`)); controller.close(); } });
  const tooLarge = await POST(new Request("http://localhost/api/director", { method: "POST", body: stream, duplex: "half" }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "request_too_large");
  const malformed = await POST(new Request("http://localhost/api/director", { method: "POST", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_json");
  assert.deepEqual(calls, []);
});
