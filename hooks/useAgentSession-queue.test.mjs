import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SERVER_OUTBOX, applyOutboxSnapshot, mergeHeldMessages } from "./useAgentSession-queue.ts";

const local = (id, createdAt, enqueueOrder) => ({ id, sessionId: "s", scope: "scope", mode: "followUp", message: id, state: "sending", createdAt, enqueueOrder });
const stored = (id, createdAt, state = "held") => ({ id, sessionId: "s", mode: "followUp", message: id, state, createdAt });
const order = (held) => held.map(({ id, local }) => `${id}:${local ? "browser" : "server"}`);

test("held messages keep delivery order across the browser-to-server handoff, whatever the two clocks say", () => {
  // Saved offline at 100 and 200 in this browser; the server accepted the first at 1000 and another device's at 1500.
  const browser = [local("first", 100, 1), local("second", 200, 2)];
  const server = applyOutboxSnapshot(EMPTY_SERVER_OUTBOX, [stored("first", 1000), stored("other-device", 1500)]);
  assert.deepEqual(order(mergeHeldMessages("s", browser, [], server)), ["first:server", "other-device:server", "second:browser"]);
});

test("a confirmation the server snapshot has not covered yet replaces the browser copy and stays ahead of later local entries", () => {
  const browser = [local("first", 100, 1), local("second", 200, 2), local("third", 300, 3)];
  const server = applyOutboxSnapshot(EMPTY_SERVER_OUTBOX, [stored("first", 1000)]);
  const confirmed = [stored("second", 1100), stored("gone", 900, "delivered")];
  assert.deepEqual(order(mergeHeldMessages("s", browser, confirmed, server)), ["first:server", "second:server", "third:browser"]);
  assert.deepEqual(order(mergeHeldMessages("s", [local("gone", 50, 0)], confirmed, EMPTY_SERVER_OUTBOX)), ["second:server"], "a delivered confirmation removes the browser copy");
});

test("settling one original id removes its late failed bridge, never an unrelated identical held prompt", () => {
  const unknown = { ...stored("original", 100, "failed"), message: "identical", mayHaveBeenSent: true };
  const identical = { ...stored("different", 100, "failed"), message: "identical", mayHaveBeenSent: true };
  const current = applyOutboxSnapshot(EMPTY_SERVER_OUTBOX, [unknown, identical]);
  const reconciled = applyOutboxSnapshot(current, [identical], ["original"]);
  const lateLocal = { ...local("original", 100, 1), message: "identical" };
  assert.deepEqual(mergeHeldMessages("s", [lateLocal], [unknown], reconciled).map(({ id, mayHaveBeenSent }) => [id, mayHaveBeenSent]), [["different", true]]);
  assert.equal(mergeHeldMessages("s", [], [], current).length, 2, "unknown same-time/text records remain distinct until correlated settlement");
});
