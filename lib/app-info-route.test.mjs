import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = await import("../app/api/app-info/route.ts");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app-info advertises the implemented notification and heartbeat contracts only", async () => {
  const response = route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.name, "ompweb");
  assert.equal(body.version, pkg.version);
  assert.equal(body.api, 1);
  assert.deepEqual(body.capabilities, { heartbeatParam: true, notificationAnswer: true, notificationDismiss: true, presenceOptional: true });
});
