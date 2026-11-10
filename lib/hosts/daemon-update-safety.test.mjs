import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "ompweb-daemon-update-safety-"));
const env = { ...process.env };
const argv = [...process.argv];
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const root = join(scratch, "agent", "omp-web", "host-update");
mkdirSync(root, { recursive: true, mode: 0o700 });
const binary = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
const script = `if(process.argv.includes('--version')){console.log('18.0.0');process.exit(0)};if(process.argv.includes('--check')){console.log('Current version: 18.0.0');process.exit(0)};setInterval(()=>{},1000);`;
if (process.platform === "win32") {
  writeFileSync(binary + ".cjs", script);
  writeFileSync(binary, `@"${process.execPath}" "${binary}.cjs" %*\r\n`);
} else writeFileSync(binary, `#!${process.execPath}\n${script}`, { mode: 0o755 });
process.env.OMP_WEB_OMP_BIN = binary;
delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
const { runHostDaemon } = await import("./daemon.ts");
const { localHost } = await import("./local-host.ts");
const packageJson = (await import("../../package.json", { with: { type: "json" } })).default;
let listener;
let upSeq;
let downSeq;
let replies;
let welcomed;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response("Upgrade required", { status: 426 }); },
  websocket: {
    open(ws) { listener = ws; },
    message(ws, raw) {
      for (const line of String(raw).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.type === "hello") { welcomed = true; ws.send(JSON.stringify({ type: "welcome", v: 5, hostId: "fixture" }) + "\n"); }
        else if (m.type === "ping") ws.send('{"type":"pong"}\n');
        else if (m.type === "res") replies.set(m.id, m);
        if (typeof m.seq === "number") { upSeq = Math.max(upSeq, m.seq); ws.send(JSON.stringify({ type: "ack", ack: upSeq }) + "\n"); }
      }
    },
  },
});
after(() => { server.stop(true); process.env = env; process.argv = argv; rmSync(scratch, { recursive: true, force: true }); });
const until = async (condition, label) => {
  // A cold OMP version probe has a production deadline of 30 seconds before
  // linking/checkUpdates can settle; keep a transport margin around that budget.
  const end = performance.now() + 35000;
  while (!condition()) { if (performance.now() > end) throw new Error(label); await new Promise((done) => setTimeout(done, 10)); }
};
async function start(t) {
  replies = new Map(); upSeq = downSeq = 0; welcomed = false;
  const daemon = runHostDaemon({ url: `http://127.0.0.1:${server.port}`, token: "fixture", allowHttp: false });
  t.after(async () => { await daemon.stop(); rmSync(join(root, "status.json"), { force: true }); });
  await until(() => welcomed, "daemon did not link");
  // A round trip ensures the daemon processed welcome before a test replaces its update state.
  await request("invalidateSessionLists", {});
  return daemon;
}
async function request(op, args) {
  const id = "req-" + (++downSeq);
  listener.send(JSON.stringify({ type: "req", seq: downSeq, id, op, args }) + "\n");
  await until(() => replies.has(id), "daemon did not answer " + op);
  return replies.get(id);
}
const spawn = (ch) => request("spawn", { ch, cwd: scratch, recordedCwd: null, sessionFile: "", advisor: false });
const state = (id) => ({ operation: { id, target: "ompweb", version: "99.0.0", state: "running" }, daemonPid: process.pid + 100000, workerPid: process.pid, startedAt: Date.now() });

test("daemon refuses new sessions while a persisted daemon update is running", { timeout: 120_000 }, async (t) => {
  await start(t);
  writeFileSync(join(root, "status.json"), JSON.stringify(state("spawn-block")), { mode: 0o600 });
  const answer = await spawn("blocked");
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "host_updating");
});

/** An installed fork host whose application updates require manual source maintenance. */
function installedFork(t) {
  const install = join(scratch, "node_modules", "@kahme247", "ompweb");
  mkdirSync(join(install, "bin"), { recursive: true });
  const launcher = join(install, "bin", "omp-web-host.js");
  writeFileSync(launcher, "");
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: packageJson.version, repository: packageJson.repository }));
  const oldPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const oldFetch = globalThis.fetch;
  process.env.OMP_WEB_PACKAGE_DIR = install;
  process.argv = [process.execPath, launcher];
  globalThis.fetch = async () => { throw new Error("fork checks must not contact upstream"); };
  t.after(() => { globalThis.fetch = oldFetch; process.argv = argv; if (oldPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR; else process.env.OMP_WEB_PACKAGE_DIR = oldPackage; });
}
const checkUpdates = () => request("checkUpdates", { compatibility: { min: 4, max: 5 }, force: true });

test("an owned session stays under a daemon whose fork update is manual-only", { timeout: 120_000 }, async (t) => {
  installedFork(t);
  await start(t);
  assert.equal((await spawn("owned")).ok, true);
  const answer = await checkUpdates();
  assert.equal(answer.ok, true);
  assert.equal(answer.result.ompweb.canUpdate, false);
  assert.match(answer.result.ompweb.blockedReason, /nanogram fork/i);
  const update = await request("updateSoftware", { target: "ompweb", version: "99.0.0", compatibility: { min: 4, max: 5 } });
  assert.equal(update.ok, false);
  assert.equal(update.error.code, "manual_update_required");
});

test("fork update refusal remains stable while a session starts and after it fails", { timeout: 120_000 }, async (t) => {
  installedFork(t);
  await start(t);
  const realSpawn = localHost.spawnRpc;
  const gate = Promise.withResolvers();
  localHost.spawnRpc = async () => { await gate.promise; throw new Error("spawn failed"); };
  t.after(() => { localHost.spawnRpc = realSpawn; });
  const starting = spawn("starting");
  const held = await checkUpdates();
  assert.equal(held.result.ompweb.canUpdate, false, "an in-flight session must not bypass the fork's manual-update policy");
  assert.match(held.result.ompweb.blockedReason, /nanogram fork/i);
  gate.resolve();
  assert.equal((await starting).ok, false);
  assert.match((await checkUpdates()).result.ompweb.blockedReason ?? "", /nanogram fork/i);
});

test("a daemon welcome writes the real updater health acknowledgement", { timeout: 120_000 }, async (t) => {
  const id = "welcome-health";
  const attempt = join(root, id);
  mkdirSync(attempt, { mode: 0o700 });
  writeFileSync(join(root, "status.json"), JSON.stringify(state(id)), { mode: 0o600 });
  writeFileSync(join(attempt, "descriptor.json"), JSON.stringify({ id, version: "99.0.0", fromVersion: packageJson.version }), { mode: 0o600 });
  await start(t);
  await until(() => existsSync(join(attempt, "health.json")), "welcome did not acknowledge updater health");
  const health = JSON.parse(readFileSync(join(attempt, "health.json"), "utf8"));
  assert.equal(health.id, id);
  assert.equal(health.version, packageJson.version);
  assert.equal(health.pid, process.pid);
});

test("a malformed update status does not prevent ordinary host sessions from starting", { timeout: 120_000 }, async (t) => {
  await start(t);
  writeFileSync(join(root, "status.json"), "{broken", { mode: 0o600 });
  assert.equal((await spawn("normal")).ok, true);
});
