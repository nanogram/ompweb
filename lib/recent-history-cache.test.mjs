import assert from "node:assert/strict";
import test from "node:test";
const { createRecentHistoryCache, encodeRecentHistory, decodeRecentHistory, RECENT_CACHE_MAX_MESSAGES, RECENT_CACHE_SESSION_BYTES, RECENT_CACHE_TOTAL_BYTES, RECENT_CACHE_MAX_ENTRIES, RECENT_CACHE_TTL_MS } = await import("./recent-history-cache.ts");
const view = { leafId: null, includePreCompaction: false };
const history = (count = 1, text = "saved") => ({ messages: Array.from({ length: count }, (_, i) => ({ role: "user", content: `${text}${i}` })), entryIds: Array.from({ length: count }, (_, i) => `e${i}`), model: null, thinkingLevel: "off", todoPhases: [] });

// Request/transaction boundary double, not a cache replacement: exercise the
// actual IDB adapter, serialization, eviction and cancellation implementation.
function storage() {
  const rows = new Map();
  let failure = false;
  let closeCount = 0;
  const factory = { open() {
    const open = {};
    queueMicrotask(() => {
      open.result = {
        close() { closeCount += 1; },
        transaction() {
          let pending = 0;
          let completion;
          let aborted = false;
          const tx = { abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); }, objectStore() { return store; } };
          const schedule = (fn) => {
            pending += 1;
            clearImmediate(completion);
            queueMicrotask(() => {
              if (aborted) return;
              try { fn(); } catch { aborted = true; tx.onerror?.(); }
              pending -= 1;
              if (!pending && !aborted) completion = setImmediate(() => tx.oncomplete?.());
            });
          };
          const store = {
            get(key) { const request = {}; schedule(() => { request.result = structuredClone(rows.get(key)); request.onsuccess?.(); }); return request; },
            put(value) { schedule(() => { if (failure) throw new Error("quota"); rows.set(value.key, structuredClone(value)); }); },
            delete(key) { schedule(() => rows.delete(key)); },
            clear() { schedule(() => rows.clear()); },
            openCursor() {
              const request = {};
              const keys = [...rows.keys()];
              let i = 0;
              const next = () => schedule(() => {
                const key = keys[i++];
                request.result = key === undefined ? null : { value: structuredClone(rows.get(key)), delete() { store.delete(key); }, continue: next };
                request.onsuccess?.();
              });
              next();
              return request;
            },
          };
          return tx;
        },
      };
      open.onsuccess?.();
    });
    return open;
  } };
  return { rows, factory, fail() { failure = true; }, get closeCount() { return closeCount; } };
}

test("cache serializes only a bounded recent persisted transcript, never authoritative live fields", () => {
  const source = history(100);
  source.messages[99] = { role: "assistant", content: [{ type: "text", text: "answer" }], model: "m", provider: "p", usage: { input: 50 }, errorMessage: "old error", stopReason: "error" };
  source.running = true;
  source.question = { secret: "not transcript" };
  const payload = encodeRecentHistory(source);
  const cached = decodeRecentHistory(payload);
  assert.equal(cached.messages.length, RECENT_CACHE_MAX_MESSAGES);
  assert.equal(cached.entryIds[0], "e50");
  assert.equal(cached.messages.at(-1).usage, undefined);
  assert.equal(cached.messages.at(-1).errorMessage, undefined);
  assert.equal(cached.running, undefined);
  assert.equal(cached.question, undefined);
  assert.equal(encodeRecentHistory(history(1, "x".repeat(RECENT_CACHE_SESSION_BYTES))), null);
  assert.equal(encodeRecentHistory({ ...history(), messages: [{ role: "toolResult", partial: true, toolCallId: "x", content: [] }] }), null);
  assert.equal(decodeRecentHistory('{"messages":[{"role":"assistant","content":"bad"}],"entryIds":["x"]}'), null);
  assert.equal(decodeRecentHistory('{"messages":[{"role":"user","content":"x","running":true}],"entryIds":["x"]}'), null);
  assert.equal(decodeRecentHistory("not json"), null);
  assert.equal(decodeRecentHistory('{"messages":[{"role":"user","content":[{"type":"image","data":"ok","url":42}]}],"entryIds":["x"]}'), null);
  assert.equal(decodeRecentHistory('{"messages":[{"role":"user","timestamp":{},"content":"bad"}],"entryIds":["x"]}'), null);
});

test("missing, blocked, denied, hung and quota-limited storage are bounded optional failures", async () => {
  for (const indexedDB of [() => undefined, () => { throw new Error("denied"); }, () => ({ open() { const req = {}; queueMicrotask(() => req.onblocked?.()); return req; } }), () => ({ open() { return {}; } })]) {
    const cache = createRecentHistoryCache({ indexedDB, timeoutMs: 10 });
    assert.equal(await cache.read("s", view), null);
    await cache.write("s", view, history());
    await cache.clearAll();
  }
  const db = storage();
  const cache = createRecentHistoryCache({ indexedDB: () => db.factory });
  db.fail();
  await cache.write("s", view, history());
  assert.equal(await cache.read("s", view), null);
  assert.ok(db.closeCount > 0);
});

test("cache scopes session and view; authoritative replacement, invalidation and clear fence stale work", async () => {
  const db = storage();
  const cache = createRecentHistoryCache({ indexedDB: () => db.factory });
  await cache.write("s", view, history(3, "old"));
  assert.deepEqual((await cache.read("s", view)).entryIds, ["e0", "e1", "e2"]);
  assert.equal(await cache.read("other", view), null);
  const branch = { leafId: "branch", includePreCompaction: true };
  assert.equal(await cache.read("s", branch), null);
  await cache.write("s", branch, history(1, "replacement"));
  assert.equal(await cache.read("s", view), null, "per-session byte budget covers all views, not each view separately");
  assert.match((await cache.read("s", branch)).messages[0].content, /replacement/);
  const pendingRead = cache.read("s", branch);
  const pendingWrite = cache.write("s", branch, history(2, "must not revive"));
  await cache.invalidate("s");
  assert.equal(await pendingRead, null);
  await pendingWrite;
  assert.equal(await cache.read("s", branch), null);
  await cache.write("s", view, history());
  const oldWrite = cache.write("s", view, history(2));
  await cache.clearAll();
  await oldWrite;
  assert.equal(db.rows.size, 0);
  await cache.write("s", view, history());
  let current = true;
  const staleRead = cache.read("s", view, () => current);
  current = false;
  assert.equal(await staleRead, null);
});

test("corruption and expiry are deleted; read touches LRU without extending TTL", async () => {
  const db = storage();
  let now = 1000;
  const cache = createRecentHistoryCache({ indexedDB: () => db.factory, now: () => now });
  await cache.write("s", view, history());
  const key = [...db.rows.keys()][0];
  db.rows.get(key).payload = "broken";
  assert.equal(await cache.read("s", view), null);
  assert.equal(db.rows.size, 0);
  await cache.write("s", view, history());
  now += RECENT_CACHE_TTL_MS - 1;
  assert.ok(await cache.read("s", view));
  now += 1;
  assert.equal(await cache.read("s", view), null);
  assert.equal(db.rows.size, 0);
  for (let i = 0; i < RECENT_CACHE_MAX_ENTRIES; i++) { now++; await cache.write(`s${i}`, view, history()); }
  now++;
  await cache.read("s0", view);
  now++;
  await cache.write("new", view, history());
  assert.ok(await cache.read("s0", view));
  assert.equal(await cache.read("s1", view), null);
  assert.equal(db.rows.size, RECENT_CACHE_MAX_ENTRIES);
  for (let i = 0; i < 20; i++) { now++; await cache.write(`large${i}`, view, history(1, "x".repeat(240 * 1024))); }
  assert.ok([...db.rows.values()].reduce((sum, row) => sum + row.bytes, 0) <= RECENT_CACHE_TOTAL_BYTES);
  assert.ok(db.rows.size <= RECENT_CACHE_MAX_ENTRIES);
  await cache.write("new", view, history(1, "x".repeat(RECENT_CACHE_SESSION_BYTES)));
  assert.equal(await cache.read("new", view), null, "over-budget latest history cannot leave a stale older cache behind");
});

test("current file-mention messages cache without requiring an optional line count", () => {
  const context = {
    ...history(),
    messages: [{ role: "fileMention", files: [{ path: "/workspace/note.txt", content: "saved file text" }] }],
  };
  assert.deepEqual(decodeRecentHistory(encodeRecentHistory(context)).messages, context.messages);
  context.messages[0].files[0].lineCount = "invalid";
  assert.equal(encodeRecentHistory(context), null);
});

