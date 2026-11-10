// Request/transaction boundary double, not a cache replacement: exercise the
// actual IDB adapter, serialization, eviction and cancellation implementation.
export function recentHistoryStorage() {
  const rows = new Map();
  let failure = false;
  let closeCount = 0;
  let holdingOpens = false;
  const pendingOpens = [];
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
      const complete = () => open.onsuccess?.();
      if (holdingOpens) pendingOpens.push(complete);
      else complete();
    });
    return open;
  } };
  return {
    rows, factory,
    holdOpens() { holdingOpens = true; },
    releaseOpens() { holdingOpens = false; for (const complete of pendingOpens.splice(0)) complete(); },
    fail() { failure = true; },
    get closeCount() { return closeCount; },
  };
}
