import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { HOST_LABEL, LABEL, buildHostEnv, buildPlist, launchArguments } = require("./omp-web-launchd.js");

const env = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/Users/u/agent" };

test("the host daemon plist runs `ompweb host`, restarts with KeepAlive, and is throttled", () => {
  const plist = buildPlist({
    label: HOST_LABEL,
    args: ["/usr/local/bin/npx", "--yes", "@kahme247/ompweb@latest", "host"],
    env,
    logName: "ompweb-host",
    throttleInterval: 10,
  });
  assert.equal(HOST_LABEL, "com.kahme247.ompweb-host");
  assert.match(plist, /<key>Label<\/key><string>com\.kahme247\.ompweb-host<\/string>/);
  assert.match(plist, /<string>@kahme247\/ompweb@latest<\/string>\n    <string>host<\/string>\n  <\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>PI_CODING_AGENT_DIR<\/key><string>\/Users\/u\/agent<\/string>/);
  assert.match(plist, /ompweb-host\.log<\/string>/);
});

test("the web plist keeps its arguments and has no throttle", () => {
  const plist = buildPlist({ label: LABEL, args: ["/usr/local/bin/npx", "--yes", "pkg & co"], env, logName: "ompweb" });
  assert.match(plist, /<string>pkg &amp; co<\/string>\n  <\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /ThrottleInterval/);
  assert.doesNotMatch(plist, /<string>host<\/string>/);
});

test("the host env carries PATH, the omp binary and the agent dir, but no web settings", () => {
  const all = buildHostEnv({ svcPath: "/usr/bin", ompBin: "/opt/omp/bin/omp", agentDir: "/Users/u/agent" });
  assert.deepEqual(all, { PATH: "/usr/bin", OMP_WEB_OMP_BIN: "/opt/omp/bin/omp", PI_CODING_AGENT_DIR: "/Users/u/agent" });
  assert.deepEqual(buildHostEnv({ svcPath: "/usr/bin" }), { PATH: "/usr/bin" });
});

function localPackage(t, metadata) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-launchd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "dist"));
  for (const file of ["bin/omp-web.js", "bin/omp-web-host.js", "dist/index.html"]) writeFileSync(join(dir, file), "fixture");
  if (metadata !== null) writeFileSync(join(dir, "package.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  return dir;
}

test("fork launch agents stay on the local build with no registry package on next start", (t) => {
  const dir = localPackage(t, { version: "0.6.0-nanogram.1", repository: { url: "git+https://github.com/nanogram/ompweb.git" } });
  const args = launchArguments(dir, undefined, {});
  assert.deepEqual(args, [process.execPath, join(dir, "bin", "omp-web.js")]);
  const host = buildPlist({ label: HOST_LABEL, args: [...args, "host"], env, logName: "ompweb-host" });
  assert.ok(!host.includes("@kahme247/ompweb"));
  assert.ok(!host.includes("npx"));
  assert.match(host, /<string>host<\/string>/);
  for (const [pkgArg, vars] of [["@kahme247/ompweb@latest", {}], [undefined, { OMP_WEB_PKG: "@kahme247/ompweb@latest" }]]) {
    assert.throws(() => launchArguments(dir, pkgArg, vars), /use this local build.*https:\/\/github\.com\/nanogram\/ompweb/);
  }
});

test("launch agent planning fails closed without verifiable local repository metadata", (t) => {
  for (const metadata of [null, "{", {}, { repository: "upstream" }]) {
    assert.throws(() => launchArguments(localPackage(t, metadata), undefined, {}), /Cannot verify the local application repository/);
  }
});

test("a verified upstream launch agent preserves its existing npx package selection", (t) => {
  const dir = localPackage(t, { repository: { url: "git+https://github.com/kahme247/ompweb.git" } });
  assert.deepEqual(launchArguments(dir, "explicit-package@1.0.0", {}).slice(1), ["--yes", "explicit-package@1.0.0"]);
  assert.deepEqual(launchArguments(dir, undefined, {}).slice(1), ["--yes", "@kahme247/ompweb@latest"]);
});
