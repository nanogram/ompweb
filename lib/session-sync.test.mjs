import assert from "node:assert/strict";
import test from "node:test";
import { historyCursor, parseHistoryCursor, selectHistoryRange, selectRecentHistoryRange, selectSessionHistory } from "./session-sync.ts";

function context(ids) {
  return {
    messages: ids.map(() => ({ role: "assistant", content: [{ type: "text", text: "Repeated answer" }], model: "test", provider: "test" })),
    entryIds: ids,
    thinkingLevel: "high",
    model: { provider: "test", modelId: "test" },
    todoPhases: [],
  };
}

test("catch-up returns only entries after the confirmed cursor, including identical messages", () => {
  const saved = context(["a", "b", "c"]);
  const page = selectSessionHistory(saved, historyCursor(context(["a"])), 200);
  assert.equal(page.mode, "append");
  assert.equal(page.baseEntryId, "a");
  assert.deepEqual(page.context.entryIds, ["b", "c"]);
  assert.deepEqual(page.context.messages, [saved.messages[1], saved.messages[2]]);
  assert.deepEqual(page.cursor, { firstEntryId: "a", lastEntryId: "c" });
  assert.equal(page.hasMore, false);
  assert.equal(page.context.thinkingLevel, "high");
});

test("pages remain contiguous while new entries are appended", () => {
  const initial = selectSessionHistory(context(["a", "b", "c", "d"]), null, 2);
  assert.equal(initial.mode, "replace");
  assert.deepEqual(initial.context.entryIds, ["a", "b"]);
  assert.equal(initial.hasMore, true);
  const next = selectSessionHistory(context(["a", "b", "c", "d", "e"]), initial.cursor, 2);
  const last = selectSessionHistory(context(["a", "b", "c", "d", "e"]), next.cursor, 2);
  assert.deepEqual([...initial.context.entryIds, ...next.context.entryIds, ...last.context.entryIds], ["a", "b", "c", "d", "e"]);
  assert.equal(next.mode, "append");
  assert.equal(last.hasMore, false);
});

test("an orphaned branch cursor replaces history instead of appending unrelated entries", () => {
  const page = selectSessionHistory(context(["root", "other"]), historyCursor(context(["root", "old-branch"])));
  assert.equal(page.mode, "replace");
  assert.deepEqual(page.context.entryIds, ["root", "other"]);
  assert.equal(page.baseEntryId, null);
});

test("compaction changes the context prefix even when the old cursor survives", () => {
  const page = selectSessionHistory(context(["summary", "kept", "new"]), historyCursor(context(["old", "kept"])));
  assert.equal(page.mode, "replace");
  assert.deepEqual(page.context.entryIds, ["summary", "kept", "new"]);
});

test("an unchanged context returns an empty delta and retains its cursor", () => {
  const cursor = historyCursor(context(["a", "b"]));
  const page = selectSessionHistory(context(["a", "b"]), cursor);
  assert.equal(page.mode, "append");
  assert.deepEqual(page.context.messages, []);
  assert.deepEqual(page.context.entryIds, []);
  assert.deepEqual(page.cursor, cursor);
});

test("empty history remains resumable and truncation produces a reset", () => {
  const empty = selectSessionHistory(context([]), null);
  assert.deepEqual(empty.cursor, { firstEntryId: null, lastEntryId: null });
  assert.equal(selectSessionHistory(context([]), empty.cursor).mode, "append");
  assert.equal(selectSessionHistory(context([]), historyCursor(context(["a"]))).mode, "replace");
  const added = selectSessionHistory(context(["a"]), empty.cursor);
  assert.equal(added.mode, "replace");
  assert.deepEqual(added.context.entryIds, ["a"]);
});

test("indexed history selection preserves cursor boundaries and rejects stale positions", () => {
  const ids = ["a", "b", "c", "d"];
  const positions = new Map(ids.map((id, index) => [id, index]));
  const cursor = { firstEntryId: "a", lastEntryId: "b" };
  const range = selectHistoryRange(ids, cursor, 1, positions);
  assert.equal(range.mode, "append");
  assert.deepEqual(ids.slice(range.start, range.end), ["c"]);
  assert.deepEqual(range.cursor, { firstEntryId: "a", lastEntryId: "c" });
  assert.equal(range.hasMore, true);
  const changed = selectHistoryRange(["a", "different", "c", "d"], cursor, 2, positions);
  assert.equal(changed.mode, "replace");
  assert.equal(changed.baseEntryId, null);
});

test("cursor parsing accepts opaque entry IDs but rejects malformed or unbounded input", () => {
  const cursor = { firstEntryId: "first-id", lastEntryId: "last-id" };
  assert.deepEqual(parseHistoryCursor(JSON.stringify(cursor)), cursor);
  assert.equal(parseHistoryCursor(null), null);
  for (const raw of ["", "[]", "null", "{}", "not-json", JSON.stringify({ firstEntryId: null, lastEntryId: "id" }), JSON.stringify({ firstEntryId: "a", lastEntryId: "x".repeat(257) }), " ".repeat(2049)]) {
    assert.throws(() => parseHistoryCursor(raw));
  }
});

test("bounded history pins intermediate pages but completion and fresh cursors discover later appends", () => {
  const historyWindow = { maxBytes: 134217728, startOffset: 900, endOffset: 134218628 };
  const saved = { ...context(["a", "b", "c"]), historyWindow };
  const first = selectSessionHistory(saved, null, 1);
  assert.deepEqual(first.context.historyWindow, historyWindow);
  assert.equal(first.cursor.windowEndOffset, historyWindow.endOffset);
  assert.deepEqual(parseHistoryCursor(JSON.stringify(first.cursor)), first.cursor);
  const second = selectSessionHistory(saved, first.cursor, 1);
  assert.equal(second.cursor.windowEndOffset, historyWindow.endOffset);
  const final = selectSessionHistory(saved, second.cursor, 1);
  assert.equal(final.hasMore, false);
  assert.equal(Object.hasOwn(final.cursor, "windowEndOffset"), false);
  assert.equal(Object.hasOwn(historyCursor(saved), "windowEndOffset"), false);
  const appended = selectSessionHistory({ ...saved, ...context(["a", "b", "c", "d"]) }, final.cursor, 1);
  assert.deepEqual(appended.context.entryIds, ["d"]);
  assert.equal(appended.hasMore, false);
});

test("cursor window end accepts only nonnegative safe integers", () => {
  const cursor = { firstEntryId: "a", lastEntryId: "b" };
  for (const windowEndOffset of [0, 134217728, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(parseHistoryCursor(JSON.stringify({ ...cursor, windowEndOffset })), { ...cursor, windowEndOffset });
  }
  for (const windowEndOffset of [-1, 1.5, "128", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseHistoryCursor(JSON.stringify({ ...cursor, windowEndOffset })));
  }
});

test("recent hydration starts at the newest page without disguising older rows as forward work", () => {
  const ids = Array.from({ length: 123 }, (_, index) => `m${index}`);
  const page = selectRecentHistoryRange(ids, null);
  assert.equal(page.mode, "replace");
  assert.deepEqual(ids.slice(page.start, page.end), ids.slice(-50));
  assert.deepEqual(page.cursor, { firstEntryId: "m73", lastEntryId: "m122", contextFirstEntryId: "m0" });
  assert.equal(page.hasMore, false);
  assert.equal(page.hasOlder, true);
});

test("older pages prepend contiguously and preserve the append boundary", () => {
  const ids = Array.from({ length: 123 }, (_, index) => `m${index}`);
  const positions = new Map(ids.map((id, index) => [id, index]));
  const newest = selectRecentHistoryRange(ids, null, 50, positions);
  const older = selectRecentHistoryRange(ids, newest.cursor, 50, positions, { older: true });
  assert.equal(older.mode, "prepend");
  assert.equal(older.baseEntryId, "m73");
  assert.deepEqual(ids.slice(older.start, older.end), ids.slice(23, 73));
  assert.deepEqual(older.cursor, { firstEntryId: "m23", lastEntryId: "m122", contextFirstEntryId: "m0" });
  assert.equal(older.hasMore, false);
  assert.equal(older.hasOlder, true);
  const first = selectRecentHistoryRange(ids, older.cursor, 50, positions, { older: true });
  assert.deepEqual(ids.slice(first.start, first.end), ids.slice(0, 23));
  assert.equal(first.hasOlder, false);
  assert.equal(first.cursor.lastEntryId, "m122");
  const exhausted = selectRecentHistoryRange(ids, first.cursor, 50, positions, { older: true });
  assert.equal(exhausted.start, exhausted.end);
  assert.deepEqual(exhausted.cursor, first.cursor);
  const grown = [...ids, "new1", "new2", "new3"];
  const delta = selectRecentHistoryRange(grown, older.cursor, 2);
  assert.equal(delta.mode, "append");
  assert.equal(delta.baseEntryId, "m122");
  assert.deepEqual(grown.slice(delta.start, delta.end), ["new1", "new2"]);
  assert.deepEqual(delta.cursor, { firstEntryId: "m23", lastEntryId: "new2", contextFirstEntryId: "m0" });
  assert.equal(delta.hasMore, true);
  assert.equal(delta.hasOlder, true);
  const final = selectRecentHistoryRange(grown, delta.cursor, 2);
  assert.deepEqual(grown.slice(final.start, final.end), ["new3"]);
  assert.equal(final.hasMore, false);
});

test("recent pages honor exact byte boundaries and progress through one oversized row", () => {
  const ids = ["a", "b", "c", "d"];
  const rowBytes = [5, 6, 4, 6];
  const newest = selectRecentHistoryRange(ids, null, 50, undefined, { rowBytes, maxBytes: 10 });
  assert.deepEqual(ids.slice(newest.start, newest.end), ["c", "d"]);
  const older = selectRecentHistoryRange(ids, newest.cursor, 50, undefined, { older: true, rowBytes, maxBytes: 10 });
  assert.deepEqual(ids.slice(older.start, older.end), ["b"]);
  assert.equal(older.hasOlder, true);
  const delta = selectRecentHistoryRange([...ids, "e", "f"], newest.cursor, 50, undefined, {
    rowBytes: [...rowBytes, 11, 1], maxBytes: 10,
  });
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].slice(delta.start, delta.end), ["e"]);
  assert.equal(delta.hasMore, true);
  const oversized = selectRecentHistoryRange(ids, null, 50, undefined, { rowBytes: [1, 1, 1, 11], maxBytes: 10 });
  assert.deepEqual(ids.slice(oversized.start, oversized.end), ["d"]);
  const oversizedOlder = selectRecentHistoryRange(ids, newest.cursor, 50, undefined, {
    older: true, rowBytes: [1, 11, 1, 1], maxBytes: 10,
  });
  assert.deepEqual(ids.slice(oversizedOlder.start, oversizedOlder.end), ["b"]);
});

test("recent compaction, branch, rolled-window and stale-index cursors reset to the latest page", () => {
  const cursor = { firstEntryId: "kept", lastEntryId: "tip", contextFirstEntryId: "root" };
  for (const [ids, positions] of [
    [["summary", "kept", "tip", "new"], undefined],
    [["root", "other", "new"], undefined],
    [["kept", "tip", "new"], undefined],
    [["root", "kept", "tip", "new"], new Map([["root", 0], ["kept", 2], ["tip", 1]])],
  ]) {
    for (const older of [false, true]) {
      const page = selectRecentHistoryRange(ids, cursor, 2, positions, { older });
      assert.equal(page.mode, "replace");
      assert.equal(page.baseEntryId, null);
      assert.deepEqual(ids.slice(page.start, page.end), ids.slice(-2));
      assert.equal(page.cursor.contextFirstEntryId, ids[0]);
      assert.equal(page.hasMore, false);
    }
  }
  const ids = ["root", "kept", "tip"];
  assert.equal(selectRecentHistoryRange(ids, { firstEntryId: "kept", lastEntryId: "tip" }).mode, "replace", "a display-only cursor cannot reconstruct the selected-path anchor");
  assert.equal(selectRecentHistoryRange(ids, { firstEntryId: "tip", lastEntryId: "kept", contextFirstEntryId: "root" }).mode, "replace");
});

test("recent empty cursors resume safely and nonempty truncation resets both anchors", () => {
  const empty = selectRecentHistoryRange([], null);
  assert.deepEqual(empty.cursor, { firstEntryId: null, lastEntryId: null, contextFirstEntryId: null });
  assert.equal(empty.hasOlder, false);
  assert.equal(selectRecentHistoryRange([], empty.cursor).mode, "append");
  assert.equal(selectRecentHistoryRange(["new"], empty.cursor).mode, "replace");
  const truncated = selectRecentHistoryRange([], { firstEntryId: "a", lastEntryId: "b", contextFirstEntryId: "a" });
  assert.equal(truncated.mode, "replace");
  assert.deepEqual(truncated.cursor, empty.cursor);
});

test("recent cursor anchors round-trip and reject malformed shapes", () => {
  for (const cursor of [
    { firstEntryId: "loaded", lastEntryId: "last", contextFirstEntryId: "root", windowEndOffset: 123 },
    { firstEntryId: null, lastEntryId: null, contextFirstEntryId: null },
  ]) assert.deepEqual(parseHistoryCursor(JSON.stringify(cursor)), cursor);
  for (const contextFirstEntryId of [null, "", "x".repeat(257), 0, {}, []]) {
    assert.throws(() => parseHistoryCursor(JSON.stringify({ firstEntryId: "a", lastEntryId: "b", contextFirstEntryId })));
  }
  assert.throws(() => parseHistoryCursor(JSON.stringify({ firstEntryId: null, lastEntryId: null, contextFirstEntryId: "root" })));
  for (const limit of [0, 51, 1.5, NaN]) assert.throws(() => selectRecentHistoryRange(["a"], null, limit), RangeError);
  for (const maxBytes of [0, -1, Infinity, 1.5]) assert.throws(() => selectRecentHistoryRange(["a"], null, 50, undefined, { maxBytes }), RangeError);
  assert.throws(() => selectRecentHistoryRange(["a"], null, 50, undefined, { rowBytes: [] }), RangeError);
});
