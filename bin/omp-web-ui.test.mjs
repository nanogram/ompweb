import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseUiOptions, startUiCustomization, uiEnvironment } = require("./omp-web-ui.js");
const { SNAPSHOT_DIRECTORIES, SNAPSHOT_FILES } = require("./ui-customization-files.js");
const { verifyPassword } = require("./omp-web-password-hash.js");
const dependencies = fileURLToPath(new URL("../node_modules", import.meta.url));
const launcher = fileURLToPath(new URL("./omp-web-ui.js", import.meta.url));

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function capture() {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (data) => { output += data.toString(); });
  return { stream, text: () => output };
}
async function until(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(typeof message === "function" ? message() : message);
}
async function freePort() {
  const server = net.createServer();
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function fixture(t) {
  const work = mkdtempSync(path.join(tmpdir(), "owui-launch-"));
  const source = path.join(work, "source");
  const home = path.join(work, "home");
  const agent = path.join(home, "agent");
  mkdirSync(source);
  mkdirSync(agent, { recursive: true });
  for (const name of SNAPSHOT_DIRECTORIES) mkdirSync(path.join(source, name));
  for (const name of SNAPSHOT_FILES) writeFileSync(path.join(source, name), name === "bunfig.toml" ? "" : "{}\n");
  function put(relative, content) {
    mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    writeFileSync(path.join(source, relative), content);
  }
  put("app/index.html", "<!doctype html>");
  put("app/client.tsx", "initial client");
  put("app/globals.css", "old css");
  put("server/ui.ts", `
    import { readFileSync } from "node:fs";
    import path from "node:path";
    const args = Bun.argv.slice(2);
    const hostname = args[args.indexOf("-H") + 1];
    const port = Number(args[args.indexOf("-p") + 1]);
    const names = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "OMP_WEB_UI_CUSTOMIZATION", "OMP_WEB_UI_SOURCE_ROOT", "OMP_WEB_DISABLE_AUTOUPDATE", "OMP_WEB_PACKAGE_DIR", "OMP_WEB_CHANNEL_CHILD", "OMP_WEB_CHANNEL_CONTROL_TOKEN", "OMP_WEB_RESTART_DESCRIPTOR", "OMP_WEB_PUBLIC_STALE", "NODE_OPTIONS", "BUN_OPTIONS", "NODE_CHANNEL_FD"];
    const server = Bun.serve({ hostname, port, reusePort: false, fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/release") return new Response("still listening");
      if (pathname === "/css") return new Response(readFileSync(path.join(process.cwd(), "app/globals.css")));
      if (pathname === "/ui-customization.json") return new Response(readFileSync(path.join(process.cwd(), "public/ui-customization.json")), { headers: { "Content-Type": "application/json" } });
      return Response.json({ pid: process.pid, root: process.cwd(), argv: Bun.argv, env: Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
    }});
    console.log("[omp-web] Ready on " + server.url.origin);
  `);
  put("server/ui-link.ts", `
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    const [flag, origin] = Bun.argv.slice(2);
    if (flag !== "--remove") throw new Error("Expected explicit secondary link removal");
    const held = await (await fetch(origin + "/release")).text();
    writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "removed.json"), JSON.stringify({ origin, held, home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, source: process.env.OMP_WEB_UI_SOURCE_ROOT }));
  `);
  symlinkSync(dependencies, path.join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("OMP_WEB_") && !["NODE_OPTIONS", "BUN_OPTIONS", "NODE_CHANNEL_FD"].includes(name.toUpperCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent });
  const resources = [];
  t.after(async () => {
    for (const cleanup of resources.reverse()) await cleanup();
    rmSync(work, { recursive: true, force: true });
  });
  return { work, source, home, agent, env, put, resources };
}

test("CLI accepts explicit source and numeric loopback bindings, rejecting hot/watch, remote binds and invalid ports", () => {
  const options = parseUiOptions(["--source", ".", "-H", "localhost", "-p", "32189"]);
  assert.equal(options.source, path.resolve("."));
  assert.equal(options.hostname, "127.0.0.1");
  assert.equal(options.port, 32189);
  assert.equal(parseUiOptions(["-H", "[::1]", "-p", "32189"]).hostname, "::1");
  assert.deepEqual(parseUiOptions(["--help"]), { help: true });
  const remote = parseUiOptions(["--public-url", "https://preview.example.test:8446/", "--proxy-port", "32190"]);
  assert.equal(remote.publicUrl, "https://preview.example.test:8446");
  assert.equal(remote.proxyPort, 32190);
  for (const args of [["--hot"], ["--watch"], ["--hot=true"], ["-H", "0.0.0.0"], ["-H", "127.attacker.example"], ["-H", "::"], ["-p", "0"], ["-p", "65536"], ["-p", "3.5"], ["--unexpected"], ["--public-url", "http://preview.example.test"], ["--proxy-port", "32190"], ["--public-url", "https://preview.example.test", "--proxy-port", "30178"], ["--primary"], ["--service-root", "."]]) assert.throws(() => parseUiOptions(args), undefined, args.join(" "));
});

test("preview environment preserves profile and normal authentication but strips inherited control and launch flags", () => {
  const base = { HOME: "/same/home", PI_CODING_AGENT_DIR: "/same/agent", PATH: "/bin", OMP_WEB_PASSWORD: "private password", OMP_WEB_CHANNEL_CHILD: "1", omp_web_channel_control_token: "must-not-leak", OMP_WEB_CHANNEL_CONTROL_URL: "http://localhost/control", OMP_WEB_LAUNCHER_PID: "42", OMP_WEB_RESTART_DESCRIPTOR: "restart production", OMP_WEB_PACKAGE_DIR: "/production", OMP_WEB_UPDATE_ATTEMPT: "old", OMP_WEB_PUBLIC_STALE: "old", NODE_OPTIONS: "--require bad", BUN_OPTIONS: "--hot", NODE_CHANNEL_FD: "3", NODE_UNIQUE_ID: "1" };
  Object.assign(base, { OMP_WEB_UI_PRIMARY_LINK: "1", OMP_WEB_SERVICE_ROOT: "/untrusted-service", OMP_WEB_SERVICE_CONFIG_PATH: "/untrusted-config" });
  const env = uiEnvironment(base, "/source", "/snapshot", "127.0.0.1", 32189);
  assert.equal(env.HOME, base.HOME);
  assert.equal(env.PI_CODING_AGENT_DIR, base.PI_CODING_AGENT_DIR);
  assert.equal(env.PATH, base.PATH);
  assert.equal(env.OMP_WEB_PASSWORD, undefined);
  assert.equal(verifyPassword("private password", env.OMP_WEB_PASSWORD_HASH), true);
  for (const name of ["OMP_WEB_CHANNEL_CHILD", "omp_web_channel_control_token", "OMP_WEB_CHANNEL_CONTROL_URL", "OMP_WEB_LAUNCHER_PID", "OMP_WEB_RESTART_DESCRIPTOR", "OMP_WEB_UPDATE_ATTEMPT", "OMP_WEB_PUBLIC_STALE", "OMP_WEB_UI_PRIMARY_LINK", "OMP_WEB_SERVICE_ROOT", "OMP_WEB_SERVICE_CONFIG_PATH", "NODE_OPTIONS", "BUN_OPTIONS", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID"]) assert.equal(env[name], undefined, name);
  assert.equal(env.OMP_WEB_PACKAGE_DIR, "/snapshot");
  assert.equal(env.OMP_WEB_UI_SOURCE_ROOT, "/source");
  assert.equal(env.OMP_WEB_UI_CUSTOMIZATION, "1");
  assert.equal(env.OMP_WEB_DISABLE_AUTOUPDATE, "1");
  assert.equal(base.OMP_WEB_CHANNEL_CHILD, "1", "the caller's environment is untouched");
  assert.throws(() => uiEnvironment({ OMP_WEB_PASSWORD_HASH: "invalid" }, "/s", "/p", "127.0.0.1", 32189), /invalid/);
  assert.throws(() => uiEnvironment({ OMP_WEB_PASSWORD: "plaintext", OMP_WEB_PASSWORD_HASH: env.OMP_WEB_PASSWORD_HASH }, "/s", "/p", "127.0.0.1", 32189), /both set/);
});

test("real Bun preview polls allowed CSS, defers client code and removes its link before releasing its owned port", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  f.resources.push(async () => {
    if (unrelated.exitCode !== null || unrelated.signalCode !== null) return;
    const exited = once(unrelated, "exit");
    unrelated.kill("SIGKILL");
    await exited;
  });
  const logs = capture();
  const errors = capture();
  const preview = await startUiCustomization({ source: f.source, port: await freePort(), temporaryRoot: f.work, env: { ...f.env, OMP_WEB_CHANNEL_CHILD: "1", OMP_WEB_CHANNEL_CONTROL_TOKEN: "production token", OMP_WEB_PUBLIC_STALE: "1", NODE_OPTIONS: "--require nonexistent", BUN_OPTIONS: "--hot" }, pollIntervalMs: 30, stdout: logs.stream, stderr: errors.stream });
  f.resources.push(async () => { await preview.close(); });
  const context = await (await fetch(preview.origin)).json();
  assert.equal(context.pid, preview.child.pid);
  assert.equal(realpathSync(context.root), preview.snapshotRoot);
  assert.equal(context.env.HOME, f.home);
  assert.equal(context.env.PI_CODING_AGENT_DIR, f.agent);
  assert.equal(context.env.OMP_WEB_UI_SOURCE_ROOT, realpathSync(f.source));
  assert.equal(context.env.OMP_WEB_UI_CUSTOMIZATION, "1");
  assert.equal(context.env.OMP_WEB_DISABLE_AUTOUPDATE, "1");
  assert.equal(context.env.OMP_WEB_PACKAGE_DIR, preview.snapshotRoot);
  for (const name of ["OMP_WEB_CHANNEL_CHILD", "OMP_WEB_CHANNEL_CONTROL_TOKEN", "OMP_WEB_PUBLIC_STALE", "NODE_OPTIONS", "BUN_OPTIONS", "NODE_CHANNEL_FD"]) assert.equal(context.env[name], undefined, name);
  assert.equal(context.argv.includes("--hot"), false);
  assert.equal(context.argv.includes("--watch"), false);
  assert.ok(logs.text().includes(preview.origin));
  assert.ok(logs.text().includes(realpathSync(f.source)));
  f.put("app/globals.css", "new css from source");
  f.put("app/client.tsx", "deferred session/bootstrap change");
  await until(async () => (await (await fetch(preview.origin + "/css")).text()) === "new css from source", () => logs.text() + errors.text());
  const state = await until(async () => {
    const value = await (await fetch(preview.origin + "/ui-customization.json")).json();
    return value.deferredFiles.includes("app/client.tsx") && value;
  }, "deferred client edit was not published");
  assert.equal(state.lastError, null);
  assert.ok(state.appliedRevision >= 1);
  assert.ok(state.appliedFiles.includes("app/globals.css"));
  assert.equal(readFileSync(path.join(preview.snapshotRoot, "app/client.tsx"), "utf8"), "initial client");
  await preview.close();
  assert.equal(await preview.done, 0);
  const removed = JSON.parse(readFileSync(path.join(f.agent, "removed.json"), "utf8"));
  assert.deepEqual(removed, { origin: preview.origin, held: "still listening", home: f.home, agent: f.agent, source: realpathSync(f.source) });
  assert.equal(alive(preview.child.pid), false);
  assert.equal(alive(unrelated.pid), true, "an unrelated host/native process must remain alive");
  assert.equal(existsSync(preview.snapshotRoot), false);
  assert.equal(readFileSync(path.join(f.source, "app/globals.css"), "utf8"), "new css from source");
  assert.equal(existsSync(dependencies), true);
});

test("occupied preview port is refused without stopping its listener or creating a snapshot", async (t) => {
  const f = fixture(t);
  const listener = net.createServer((socket) => socket.end("still owned"));
  listener.listen({ host: "127.0.0.1", port: 0 });
  await once(listener, "listening");
  f.resources.push(() => new Promise((resolve) => listener.close(resolve)));
  await assert.rejects(startUiCustomization({ source: f.source, port: listener.address().port, env: f.env, temporaryRoot: f.work }), /already in use/);
  assert.equal(listener.listening, true);
  assert.equal(readdirSync(f.work).some((name) => name.startsWith("owui-")), false);
});

test("startup failure removes only its private snapshot", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  f.put("server/ui.ts", "process.exit(17);\n");
  const errors = capture();
  await assert.rejects(startUiCustomization({ source: f.source, port: await freePort(), env: f.env, temporaryRoot: f.work, stdout: capture().stream, stderr: errors.stream }), /before readiness/);
  assert.equal(readdirSync(f.work).some((name) => name.startsWith("owui-")), false);
  assert.equal(existsSync(path.join(f.source, "server/ui.ts")), true);
  assert.equal(existsSync(dependencies), true);
});

test("SIGHUP to the Node CLI cleans its owned web child and secondary link", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const port = await freePort();
  const cli = spawn("node", [launcher, "--source", f.source, "-p", String(port)], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  cli.stdout.on("data", (data) => { output += data.toString(); });
  cli.stderr.on("data", (data) => { output += data.toString(); });
  const exited = once(cli, "exit");
  f.resources.push(async () => { if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL"); await exited; });
  await until(() => output.includes("Watching display/style source:"), () => output);
  const origin = `http://127.0.0.1:${port}`;
  const context = await (await fetch(origin)).json();
  cli.kill("SIGHUP");
  await exited;
  assert.equal(alive(context.pid), false);
  assert.equal(existsSync(context.root), false);
  assert.equal(JSON.parse(readFileSync(path.join(f.agent, "removed.json"), "utf8")).held, "still listening");
  assert.equal(existsSync(dependencies), true);
});
