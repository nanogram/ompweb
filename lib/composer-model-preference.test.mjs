import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createComposerModelPreferenceStore } from "./composer-model-preference.ts";
import { COMPOSER_MODELS_STORAGE_KEY } from "./composer-model-visibility.ts";
import { GET, PUT } from "../app/api/web-settings/route.ts";

function settingsServer(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-composer-preference-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete globalThis.__ompWebSettingsCache;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  });
  const writes = [];
  const request = async (_url, init) => {
    if (init?.method !== "PUT") return GET();
    writes.push(JSON.parse(init.body));
    return PUT(new Request("http://localhost/api/web-settings", init));
  };
  const viewer = (cached, override = request) => {
    const cache = new Map(cached === undefined ? [] : [[COMPOSER_MODELS_STORAGE_KEY, JSON.stringify(cached)]]);
    const store = createComposerModelPreferenceStore({
      request: override,
      storage: () => ({ getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) }),
    });
    return { store, cache };
  };
  return { dir, writes, request, viewer };
}

const selected = ["provider-a:shared:model", "provider-b:other"];

test("desktop legacy subset migrates through the composer store, clean mobile and stale browsers use server authority", async (t) => {
  const { viewer, writes } = settingsServer(t);
  const desktop = viewer(selected).store;
  assert.deepEqual(desktop.getSnapshot().keys, selected, "legacy cache is provisional before the load");
  await desktop.refresh();
  assert.equal(desktop.getSnapshot().ready, true);
  assert.deepEqual(writes, [{ composerModelKeys: selected, composerModelKeysIfUnset: true }]);

  for (const cached of [undefined, null, ["stale:model"], []]) {
    const mobile = viewer(cached).store;
    await mobile.refresh();
    assert.deepEqual(mobile.getSnapshot().keys, selected);
    assert.equal(mobile.getSnapshot().error, null);
  }
  assert.equal(writes.length, 1, "startup never republishes stale, empty or show-all caches over an existing preference");
});

test("an unconfigured browser never publishes show-all, so a later old desktop can still migrate", async (t) => {
  const { viewer, writes } = settingsServer(t);
  const mobile = viewer().store;
  await mobile.refresh();
  assert.equal(mobile.getSnapshot().keys, null);
  assert.deepEqual(writes, []);
  await viewer(selected).store.refresh();
  await mobile.refresh();
  assert.deepEqual(mobile.getSnapshot().keys, selected, "a later focus refresh converges on the migrated desktop selection");
});

test("simultaneous legacy migrations are first-authoritative-wins; null/unset clients never compete", async (t) => {
  const { viewer, writes } = settingsServer(t);
  const viewers = [viewer(selected).store, viewer(["stale:model"]).store, viewer(null).store, viewer().store];
  await Promise.all(viewers.map((store) => store.refresh()));
  const saved = (await (await GET()).json()).composerModelKeys;
  assert.deepEqual(saved, writes[0].composerModelKeys);
  assert.ok(writes.every((write) => Array.isArray(write.composerModelKeys) && write.composerModelKeysIfUnset === true));
  await Promise.all(viewers.map((store) => store.refresh()));
  for (const store of viewers) assert.deepEqual(store.getSnapshot().keys, saved);
});

test("legacy none, explicit show-all and none remain distinct after restart and unrelated scoped saves", async (t) => {
  const { viewer, request, dir } = settingsServer(t);
  const desktop = viewer([]).store;
  await desktop.refresh();
  assert.deepEqual(desktop.getSnapshot().keys, []);
  for (const keys of [null, [], selected]) {
    await desktop.save(keys);
    await request("/api/web-settings", { method: "PUT", body: JSON.stringify({ agentToolsEnabled: true }) });
    delete globalThis.__ompWebSettingsCache;
    const mobile = viewer(["stale:model"]).store;
    await mobile.refresh();
    assert.deepEqual(mobile.getSnapshot().keys, keys);
    const disk = JSON.parse(readFileSync(join(dir, "omp-web-settings.json"), "utf8"));
    assert.deepEqual(disk.composerModelKeys, keys);
    assert.equal(disk.agentToolsEnabled, true);
  }
  await desktop.save(null);
  const migration = await request("/api/web-settings", {
    method: "PUT", body: JSON.stringify({ composerModelKeys: selected, composerModelKeysIfUnset: true }),
  });
  assert.equal((await migration.json()).composerModelKeys, null, "an explicitly saved all cannot be mistaken for unset");
});

test("failed loads fail closed without publishing; failed saves and refreshes retain the last confirmed subset", async (t) => {
  const { viewer, request, writes } = settingsServer(t);
  let unavailable = true;
  const unreliable = (url, init) => unavailable
    ? Promise.resolve(Response.json({ error: "Settings unavailable" }, { status: 503 }))
    : request(url, init);
  const mobile = viewer(undefined, unreliable).store;
  await mobile.refresh();
  assert.deepEqual(mobile.getSnapshot().keys, []);
  assert.equal(mobile.getSnapshot().ready, false);
  assert.match(mobile.getSnapshot().error, /Settings unavailable/);
  assert.deepEqual(writes, []);
  unavailable = false;
  await viewer(selected).store.refresh();
  await mobile.refresh();
  unavailable = true;
  await mobile.save(null);
  assert.deepEqual(mobile.getSnapshot().keys, selected);
  assert.equal(mobile.getSnapshot().saving, false);
  assert.match(mobile.getSnapshot().error, /Settings unavailable/);
  await mobile.refresh();
  assert.deepEqual(mobile.getSnapshot().keys, selected);
  assert.deepEqual((await (await GET()).json()).composerModelKeys, selected);
  unavailable = false;
  await mobile.refresh();
  assert.equal(mobile.getSnapshot().error, null);
  await mobile.save([]);
  assert.deepEqual((await (await GET()).json()).composerModelKeys, []);
});

test("overlapping refreshes join one load and a late refresh cannot overwrite a save", async (t) => {
  const { viewer, request } = settingsServer(t);
  let release;
  let loads = 0;
  const store = viewer(undefined, async (url, init) => {
    if (init?.method === "PUT") {
      await new Promise((resolve) => { release = resolve; });
      return request(url, init);
    }
    loads += 1;
    await new Promise((resolve) => { release = resolve; });
    return request(url, init);
  }).store;
  const first = store.refresh();
  const second = store.refresh();
  assert.equal(loads, 1);
  assert.equal(first, second);
  release();
  await first;
  const save = store.save(selected);
  const focusRefresh = store.refresh();
  assert.equal(save, focusRefresh, "focus during a save joins that save rather than issuing a stale read");
  assert.equal(loads, 1);
  assert.equal(store.getSnapshot().keys, null, "the selected state is not claimed before the server confirms it");
  release();
  await save;
  assert.deepEqual(store.getSnapshot().keys, selected);
});

test("invalid legacy caches cannot migrate or expose models before a successful load", async (t) => {
  const { viewer, writes } = settingsServer(t);
  for (const cached of [["not-qualified"], ["provider:"], [":model"], ["p:m", 42], {}, "all"]) {
    const store = viewer(cached).store;
    assert.deepEqual(store.getSnapshot().keys, []);
    await store.refresh();
    assert.equal(store.getSnapshot().keys, null);
  }
  assert.deepEqual(writes, []);
});

test("the API refuses null migration and malformed keys, and unreadable settings cannot become show-all or be overwritten", async (t) => {
  const { request, dir } = settingsServer(t);
  for (const body of [
    { composerModelKeys: ["bare-model"] },
    { composerModelKeys: ["p:m", null] },
    { composerModelKeys: null, composerModelKeysIfUnset: true },
    { composerModelKeysIfUnset: true },
    { composerModelKeys: [], composerModelKeysIfUnset: true, agentToolsEnabled: true },
  ]) {
    assert.equal((await request("/api/web-settings", { method: "PUT", body: JSON.stringify(body) })).status, 400);
  }
  for (const source of ["{ invalid json", JSON.stringify({ composerModelKeys: ["invalid-key"] })]) {
    writeFileSync(join(dir, "omp-web-settings.json"), source, "utf8");
    delete globalThis.__ompWebSettingsCache;
    assert.equal((await GET()).status, 503);
    assert.equal((await request("/api/web-settings", { method: "PUT", body: JSON.stringify({ composerModelKeys: [] }) })).status, 500);
    assert.equal(readFileSync(join(dir, "omp-web-settings.json"), "utf8"), source);
  }
});
