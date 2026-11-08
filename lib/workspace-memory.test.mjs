import assert from "node:assert/strict";
import test from "node:test";
const { clearLastViewedSession, getLastViewedSession, setLastViewedSession, getRestoreLastChat, setRestoreLastChat, workspaceKeyOf } = await import("./workspace-memory.ts");
function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}
test("startup restoration is browser-local and opt-in; remembered chat retains owning host and workspace", () => {
  const local = storage();
  assert.equal(getRestoreLastChat(local), false);
  assert.equal(getLastViewedSession(local), null);
  const remembered = { sessionId: "chat", hostId: "remote", workspace: "remote:/repo" };
  setLastViewedSession(remembered, local);
  assert.deepEqual(getLastViewedSession(local), remembered);
  assert.equal(getRestoreLastChat(local), false);
  setRestoreLastChat(true, local);
  assert.equal(getRestoreLastChat(local), true);
  assert.equal(getRestoreLastChat(storage()), false);
  setRestoreLastChat(false, local);
  assert.equal(getRestoreLastChat(local), false);
});
test("clearing a deleted or missing chat does not erase a newer tab's pointer", () => {
  const local = storage();
  setLastViewedSession({ sessionId: "newer", workspace: "" }, local);
  clearLastViewedSession("older", local);
  assert.equal(getLastViewedSession(local)?.sessionId, "newer");
  clearLastViewedSession("newer", local);
  assert.equal(getLastViewedSession(local), null);
});
test("unavailable browser storage does not block navigation", () => {
  const local = { getItem() { throw new Error("private"); }, setItem() { throw new Error("private"); }, removeItem() { throw new Error("private"); } };
  assert.equal(getRestoreLastChat(local), false);
  assert.equal(getLastViewedSession(local), null);
  setRestoreLastChat(true, local);
  setLastViewedSession({ sessionId: "chat", workspace: "" }, local);
  clearLastViewedSession("chat", local);
});
test("workspace identity preserves worktrees and cwd-less sessions", () => {
  assert.equal(workspaceKeyOf({ cwd: "D:/repo-worktrees/feature", projectRoot: "D:/repo" }), "D:/repo");
  assert.equal(workspaceKeyOf({ cwd: "/scratch", projectRoot: "", projectKey: "" }), "/scratch");
  assert.equal(workspaceKeyOf({ cwd: "", projectRoot: "", projectKey: "" }), "");
});
