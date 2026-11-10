import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-director-policy-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { directorCommandError } = await import("./director-policy.ts");
const { getDirectorWorkspaceCwd, getDirectorStatePath, mutateDirectorState } = await import("./director-state.ts");
const cwd = getDirectorWorkspaceCwd();
const id = "01a18d03-02bb-72ba-82c2-faa463337fe5";

function persistIdentity() {
  rmSync(getDirectorStatePath(), { force: true });
  mutateDirectorState((state) => {
    state.session = {
      id, cwd, hostId: "local", path: join(agentDir, "director.jsonl"), name: "Director",
      firstMessage: "Review progress", messageCount: 2,
      created: new Date(0).toISOString(), modified: new Date(0).toISOString(),
    };
  });
}

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

test("Director permits conversation and inspection but not execution or identity changes", () => {
  for (const command of [
    { type: "prompt", message: "Which sessions need my input?" },
    { type: "steer", message: "Prioritize blocked work." },
    { type: "follow_up", message: "Summarize the observed errors." },
    { type: "get_state" }, { type: "get_session_stats" }, { type: "goal", op: "get" },
    { type: "set_model", provider: "example", modelId: "observer" },
    { type: "abort" }, { type: "compact" }, { type: "set_session_name", name: "Director" },
  ]) assert.equal(directorCommandError(id, cwd, command), null, JSON.stringify(command));
  for (const command of [
    { type: "bash", command: "echo forbidden" }, { type: "new_session" }, { type: "switch_session", sessionId: "other" },
    { type: "fork", entryId: "entry" }, { type: "edit_message", entryId: "entry", message: "replacement" },
    { type: "goal", op: "create" }, { type: "generate_title" },
    { type: "set_session_name", name: "Worker" }, { type: "__proto__" }, {},
  ]) assert.equal(typeof directorCommandError(id, cwd, command), "string", JSON.stringify(command));
});

test("Director cannot execute native slash or bang commands through any chat delivery mode", () => {
  for (const type of ["prompt", "steer", "follow_up"]) {
    for (const message of ["/model other", "  /new", "\n!echo unsafe", "!/bin/sh"]) {
      assert.equal(typeof directorCommandError(id, cwd, { type, message }), "string", `${type}: ${message}`);
    }
    assert.equal(directorCommandError(id, cwd, { type, message: "Explain /model without running it." }), null);
  }
});

test("cold Director requests are protected by the persisted singleton identity", () => {
  persistIdentity();
  assert.equal(typeof directorCommandError(id, undefined, { type: "bash", command: "echo forbidden" }), "string");
  assert.equal(directorCommandError(id, undefined, { type: "get_state" }), null);
  assert.equal(directorCommandError("another-session", undefined, { type: "new_session" }), null);
});

test("Director restrictions do not leak into workers, remote hosts or damaged unrelated state", () => {
  persistIdentity();
  assert.equal(directorCommandError(id, cwd, { type: "bash" }, "remote-host"), null);
  mkdirSync(join(agentDir, "omp-web", "director"), { recursive: true });
  writeFileSync(getDirectorStatePath(), "{incomplete");
  assert.equal(directorCommandError("worker", join(agentDir, "worker"), { type: "bash" }), null);
  assert.equal(directorCommandError("worker", undefined, { type: "bash" }), null);
  assert.equal(typeof directorCommandError(id, cwd, { type: "bash" }), "string");
});

test("ordinary session endpoints cannot rename, delete, archive or import another Director chat", async () => {
  persistIdentity();
  const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
  const autoNameRoute = await import("../app/api/sessions/[id]/auto-name/route.ts");
  const archiveRoute = await import("../app/api/sessions/[id]/archive/route.ts");
  const importRoute = await import("../app/api/sessions/import/route.ts");
  const context = { params: Promise.resolve({ id }) };
  const request = (method, body) => new Request(`http://localhost/api/sessions/${id}`, {
    method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const responses = [
    await sessionRoute.PATCH(request("PATCH", { name: "Worker" }), context),
    await sessionRoute.DELETE(request("DELETE"), context),
    await autoNameRoute.POST(request("POST"), context),
    await archiveRoute.POST(request("POST"), context),
    await importRoute.POST(request("POST", {
      fileName: "director.jsonl",
      content: `${JSON.stringify({ type: "session", id: "source", cwd })}\n`,
    })),
  ];
  for (const response of responses) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "director_managed");
  }
  const { readDirectorState } = await import("./director-state.ts");
  assert.equal(readDirectorState().session.id, id);
});
