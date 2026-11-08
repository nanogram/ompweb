import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsDir } from "./omp/paths.ts";
import { subscribeSessionFileChanges } from "./session-watcher.ts";
import { invalidateSessionListCache } from "./session-reader.ts";

test("external changes under the actual XDG session root notify subscribers", { skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-xdg-watch-"));
  const old = Object.fromEntries(["XDG_DATA_HOME", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_DATA_HOME = root;
  const sessions = join(root, "omp", "sessions");
  mkdirSync(join(sessions, "fixture"), { recursive: true });
  assert.equal(getSessionsDir(), sessions);
  invalidateSessionListCache();
  let stop;
  t.after(() => {
    stop?.();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    invalidateSessionListCache();
    rmSync(root, { recursive: true, force: true });
  });
  const id = "48b0dcf8-b93d-4d9a-a29f-8d076947163e";
  const file = join(sessions, "fixture", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }) + "\n");
  const notified = new Promise(resolve => {
    stop = subscribeSessionFileChanges(ids => { if (ids.includes(id)) resolve(ids); });
  });
  appendFileSync(file, JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Changed externally" }], timestamp: 1767225601000 } }) + "\n");
  let timer;
  try {
    const ids = await Promise.race([notified, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("XDG watcher did not notify")), 5000); })]);
    assert.ok(ids.includes(id));
  } finally { clearTimeout(timer); }
});
