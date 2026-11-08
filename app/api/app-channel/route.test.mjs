import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "./route.ts";
import { GET as managedGET, POST as managedPOST } from "../../../lib/app-channel-update-route.ts";

const active = { channel: "fork", version: "0.6.0-n1", revision: null };
const selected = { channel: "main", version: "0.6.0", revision: "a".repeat(40) };
const state = { supported: true, active, selected, preparing: null, restartRequired: true, restarting: false, error: null };
function request(body, options = {}) {
  return new Request("https://omp.test/api/app-channel", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://omp.test", ...options.headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function harness(t) {
  const names = ["OMP_WEB_CHANNEL_CONTROL_URL", "OMP_WEB_CHANNEL_CONTROL_TOKEN", "OMP_WEB_CHANNEL_CURRENT"];
  const saved = names.map((name) => process.env[name]);
  const originalFetch = globalThis.fetch;
  process.env.OMP_WEB_CHANNEL_CONTROL_URL = "http://127.0.0.1:31337";
  process.env.OMP_WEB_CHANNEL_CONTROL_TOKEN = "fixture-control-secret";
  process.env.OMP_WEB_CHANNEL_CURRENT = "fork";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), ...init });
    return Response.json({ ...state, token: "fixture-control-secret", controlUrl: "private", packageDir: "private", active: { ...active, packageDir: "private" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  });
  return calls;
}

test("GET proxies authenticated public state without forwarding private control fields", async (t) => {
  harness(t);
  const response = await GET(new Request("https://omp.test/api/app-channel"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), state);
});


test("origin, media type, bounded JSON, and exact action allowlist fail before control access", async (t) => {
  const calls = harness(t);
  assert.equal((await POST(request({ action: "restart" }, { headers: { Origin: "https://evil.test" } }))).status, 403);
  assert.equal((await POST(request({ action: "restart" }, { headers: { Origin: "https://omp.test:9999" } }))).status, 403);
  assert.equal((await GET(new Request("https://omp.test/api/app-channel", { headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal((await POST(request("{}", { headers: { "Content-Type": "text/plain" } }))).status, 415);
  assert.equal((await POST(request("{"))).status, 400);
  assert.equal((await POST(request(" ".repeat(4097)))).status, 413);
  for (const body of [null, [], {}, { action: "stop" }, { action: "select", channel: "other" }, { action: "select", channel: "main", token: "injected" }, { action: "restart", channel: "fork" }, { action: "select" }]) {
    assert.equal((await POST(request(body))).status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test("unmanaged launches expose their installed version and refuse mutations", async (t) => {
  const calls = harness(t);
  delete process.env.OMP_WEB_CHANNEL_CONTROL_TOKEN;
  const response = await GET(new Request("https://omp.test/api/app-channel"));
  const status = await response.json();
  assert.equal(status.supported, false);
  assert.equal(status.active.channel, "fork");
  assert.deepEqual(status.active, status.selected);
  assert.match(status.reason, /Node launcher/);
  assert.equal((await POST(request({ action: "select", channel: "main" }))).status, 409);
  assert.equal(calls.length, 0);
});

test("upstream conflicts remain actionable and connection failures never reveal secrets", async (t) => {
  harness(t);
  globalThis.fetch = async () => Response.json({ error: "Preparation is in progress" }, { status: 409 });
  const conflict = await POST(request({ action: "restart" }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "Preparation is in progress" });
  globalThis.fetch = async () => { throw new Error(process.env.OMP_WEB_CHANNEL_CONTROL_TOKEN); };
  const unavailable = await GET(new Request("https://omp.test/api/app-channel"));
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("fixture-control-secret"));
  globalThis.fetch = async () => Response.json({ token: "fixture-control-secret" });
  assert.equal((await GET(new Request("https://omp.test/api/app-channel"))).status, 502);
});

test("managed source updates cannot invoke package replacement", async (t) => {
  const calls = harness(t);
  const status = await (await managedGET()).json();
  assert.equal(status.updatesDisabled, true);
  assert.equal(status.selfUpdateSupported, false);
  assert.equal(status.availableVersion, null);
  assert.equal(status.updateAvailable, false);
  assert.equal((await managedPOST(request({ action: "prepare" }))).status, 409);
  assert.equal((await managedPOST(request({ action: "commit" }))).status, 409);
  assert.equal((await managedPOST(request({}, { headers: { Origin: "https://evil.test" } }))).status, 403);
  assert.equal(calls.length, 0);
});

test("a misconfigured remote control URL is never contacted", async (t) => {
  const calls = harness(t);
  process.env.OMP_WEB_CHANNEL_CONTROL_URL = "https://outside.test/";
  const response = await GET(new Request("https://omp.test/api/app-channel"));
  assert.equal((await response.json()).supported, false);
  assert.equal(calls.length, 0);
});

test("control credentials cannot escape through supervisor error or status strings", async (t) => {
  harness(t);
  globalThis.fetch = async () => Response.json({ error: "Unexpected fixture-control-secret" }, { status: 409 });
  const response = await POST(request({ action: "restart" }));
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes("fixture-control-secret"));
  globalThis.fetch = async () => Response.json({ ...state, error: "Unexpected fixture-control-secret" });
  const status = await GET(new Request("https://omp.test/api/app-channel"));
  assert.equal(status.status, 502);
  assert.ok(!(await status.text()).includes("fixture-control-secret"));
});
