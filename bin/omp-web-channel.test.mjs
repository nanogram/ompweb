import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
const { createChannelManager } = createRequire(import.meta.url)("./omp-web-channel.js");

async function until(check) {
  for (const deadline = Date.now() + 20_000; ; ) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, "version transition did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function fixturePackage(root, channel, exits = false) {
  for (const dir of ["bin", "server", "dist", "lib/hosts"]) mkdirSync(join(root, dir), { recursive: true });
  const version = channel === "fork" ? "1.0.0-fork" : "0.6.0";
  writeFileSync(join(root, "package.json"), JSON.stringify({ version, repository: { url: `git+https://github.com/${channel === "fork" ? "nanogram" : "kahme247"}/ompweb.git` } }));
  writeFileSync(join(root, "server/main.ts"), "// fixture server lives in bin/omp-web.js\n");
  writeFileSync(join(root, "dist/index.html"), "fixture");
  writeFileSync(join(root, "lib/hosts/link-protocol.ts"), "export const LINK_PROTOCOL_VERSION = 7;\nexport const MIN_LINK_PROTOCOL_VERSION = 4;\n");
  writeFileSync(join(root, "bin/omp-web.js"), exits ? "process.exit(4);\n" : `const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('-p')+1]);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:${JSON.stringify(version)},pid:process.pid}));}).listen(port,'127.0.0.1',()=>console.log('Ready on '+port));\n`);
  return { channel, version, packageDir: root, revision: channel === "main" ? "a".repeat(40) : null };
}
async function fixture(t, prepare) {
  const root = mkdtempSync(join(tmpdir(), "ompweb-channels-"));
  const managerRoot = join(root, "fork");
  const channelsRoot = join(root, "channels");
  fixturePackage(managerRoot, "fork");
  const main = fixturePackage(join(channelsRoot, "main"), "main");
  const net = createServer();
  await new Promise(resolve => net.listen(0, "127.0.0.1", resolve));
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const managers = [];
  const options = { managerRoot, channelsRoot, port, hostname: "127.0.0.1", args: ["-p", String(port)], preparePackage: prepare ? (...args) => prepare(main, ...args) : async ({ channel }) => channel === "main" ? main : { channel, packageDir: managerRoot, revision: null } };
  const make = async () => { const manager = await createChannelManager(options); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) await manager.close(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  return { root, main, channelsRoot, make, who: () => fetch(`http://127.0.0.1:${port}/who`).then(r => r.json()) };
}

test("selection prepares without replacing the web process, and explicit restart switches both directions", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const manager = await f.make();
  await manager.start();
  const before = await f.who();
  manager.select("main");
  assert.throws(() => manager.restart(), /preparation/);
  await until(() => !manager.status().preparing);
  assert.equal(manager.status().active.channel, "fork");
  assert.equal(manager.status().selected.channel, "main");
  assert.equal((await f.who()).pid, before.pid, "choosing a version must not stop the server");
  manager.restart();
  await until(() => !manager.status().restarting && manager.status().active.channel === "main");
  assert.equal((await f.who()).version, "0.6.0");
  manager.select("fork");
  await until(() => !manager.status().preparing);
  manager.restart();
  await until(() => !manager.status().restarting && manager.status().active.channel === "fork");
  assert.equal((await f.who()).version, before.version);
});

test("preparation errors leave the running server alone and a broken selected web build rolls back", { timeout: 60_000 }, async t => {
  let offline = true;
  const f = await fixture(t, async (main) => { if (offline) throw new Error("source unavailable"); return main; });
  const manager = await f.make();
  await manager.start();
  const before = await f.who();
  manager.select("main");
  await until(() => !manager.status().preparing);
  assert.match(manager.status().error, /source unavailable/);
  assert.equal((await f.who()).pid, before.pid);
  assert.equal(manager.status().selected.channel, "fork");
  offline = false;
  fixturePackage(f.main.packageDir, "main", true);
  manager.select("main");
  await until(() => !manager.status().preparing);
  manager.restart();
  await until(() => !manager.status().restarting && manager.status().error);
  assert.equal(manager.status().active.channel, "fork");
  assert.equal(manager.status().selected.channel, "fork");
  assert.match(manager.status().error, /exited before readiness/);
  assert.equal((await f.who()).version, before.version);
});

test("a ready selection survives external launcher restart and control/state boundaries reject outsiders", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const first = await f.make();
  await first.start();
  first.select("main");
  await until(() => !first.status().preparing);
  await first.close();
  const next = await f.make();
  await next.start();
  assert.equal(next.status().active.channel, "main");
  assert.equal((await f.who()).version, "0.6.0");
  const refused = await fetch(next.controlUrl + "/state");
  assert.equal(refused.status, 403);
  const headers = { authorization: "Bearer " + next.controlToken, "content-type": "application/json" };
  const state = await fetch(next.controlUrl + "/state", { headers }).then(r => r.json());
  assert.equal(JSON.stringify(state).includes(next.controlToken), false);
  const invalid = await fetch(next.controlUrl + "/select", { method: "POST", headers, body: JSON.stringify({ channel: "https://untrusted.example/app" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await f.who()).version, "0.6.0");
  await next.close();
  const original = join(f.channelsRoot, "selection.json");
  const alias = join(f.channelsRoot, "linked-state.json");
  renameSync(original, alias);
  linkSync(alias, original);
  await assert.rejects(f.make(), /Unsafe application-channel state file/);
});
