"use strict";

const fs = module.require("node:fs");
const path = module.require("node:path");
const http = module.require("node:http");
const crypto = module.require("node:crypto");
const { spawn } = module.require("node:child_process");
const { terminateChildProcess } = module.require("./process-lifecycle");
const { isPortAvailable } = module.require("./port-availability");
const { prepareChannelPackage } = module.require("./app-channel-packages");

function owned(info) {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}
function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Error("Unsafe application-channel directory");
}
function safeFile(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info)) throw new Error("Unsafe application-channel state file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function writeState(file, value) {
  safeFile(file);
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function failure(message, status = 409) { return Object.assign(new Error(message), { status }); }
function release(record) { return { channel: record.channel, version: record.version, revision: record.revision }; }
function sameInstall(a, b) { return a.channel === b.channel && a.packageDir === b.packageDir && a.revision === b.revision && a.version === b.version; }

/** Owns only the web child. Host daemons and their OMP processes are never children of this supervisor. */
async function createChannelManager({ managerRoot, args, port, hostname, channelsRoot, preparePackage = prepareChannelPackage, readyTimeoutMs = 60_000, onUnexpectedExit }) {
  managerRoot = fs.realpathSync(managerRoot);
  if (!channelsRoot) {
    const { getAgentDir } = await module.require("jiti").createJiti(__filename).import(path.join(managerRoot, "lib", "omp", "paths.ts"));
    const identity = crypto.createHash("sha256").update(`${managerRoot}\0${hostname}\0${port}`).digest("hex").slice(0, 20);
    channelsRoot = path.join(getAgentDir(), "omp-web", "app-channels", identity);
  }
  safeDirectory(channelsRoot);
  channelsRoot = fs.realpathSync(channelsRoot);
  const file = path.join(channelsRoot, "selection.json");
  const token = crypto.randomBytes(32).toString("hex");
  const preparationAbort = new AbortController();
  let child;
  let closing = false;
  let switching = false;
  let controlUrl;
  let prepareTask;
  let closeTask;

  function validate(record) {
    if (!record || !["fork", "main"].includes(record.channel) || typeof record.packageDir !== "string") throw new Error("Invalid application-channel installation");
    const directory = fs.realpathSync(record.packageDir);
    const relative = path.relative(channelsRoot, directory);
    if (record.channel === "fork" ? directory !== managerRoot : relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Application-channel installation is outside its managed directory");
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const repository = record.channel === "fork" ? "nanogram" : "kahme247";
    if (metadata.repository?.url !== `git+https://github.com/${repository}/ompweb.git` || typeof metadata.version !== "string") throw new Error("Application-channel repository identity does not match its selection");
    for (const needed of ["bin/omp-web.js", "server/main.ts", "dist/index.html"]) if (!fs.statSync(path.join(directory, needed)).isFile()) throw new Error("Application-channel build is incomplete");
    const protocol = fs.readFileSync(path.join(directory, "lib/hosts/link-protocol.ts"), "utf8");
    const minimum = Number(/export const MIN_LINK_PROTOCOL_VERSION = (\d+)/.exec(protocol)?.[1]);
    const maximum = Number(/export const LINK_PROTOCOL_VERSION = (\d+)/.exec(protocol)?.[1]);
    const hostProtocol = Number(/export const LINK_PROTOCOL_VERSION = (\d+)/.exec(fs.readFileSync(path.join(managerRoot, "lib/hosts/link-protocol.ts"), "utf8"))?.[1]);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || !Number.isSafeInteger(hostProtocol) || hostProtocol < minimum || hostProtocol > maximum) throw new Error("This web version cannot use the existing host daemon protocol; no daemon or OMP process was restarted");
    return { channel: record.channel, packageDir: directory, version: metadata.version, revision: typeof record.revision === "string" ? record.revision : null };
  }
  const fork = validate({ channel: "fork", packageDir: managerRoot, revision: null });
  let saved;
  if (safeFile(file)) saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (saved && saved.schema !== 1) throw new Error("Unsupported application-channel state format");
  let active = saved ? validate(saved.active) : fork;
  let selected = saved ? validate(saved.selected) : fork;
  let preparing = null;
  let error = saved?.error || null;
  if (saved?.preparing) error = "Version preparation was interrupted. Select the version again to retry.";
  function persist() { writeState(file, { schema: 1, active, selected, preparing, error }); }
  function status() {
    return { supported: true, active: release(active), selected: release(selected), preparing, restartRequired: !sameInstall(active, selected), restarting: switching, error };
  }
  function select(channel) {
    if (!["main", "fork"].includes(channel)) throw failure("Choose main or fork", 400);
    if (preparing || switching || closing) throw failure("A version change is already in progress");
    preparing = { channel, stage: "Preparing version" };
    error = null;
    persist();
    prepareTask = Promise.resolve().then(() => preparePackage({ channel, managerRoot, channelsRoot, signal: preparationAbort.signal, onProgress(stage) { if (preparing) preparing = { channel, stage }; } })).then((candidate) => {
      if (closing) return;
      selected = validate(candidate);
      preparing = null;
      persist();
    }).catch((problem) => {
      if (closing) return;
      preparing = null;
      error = problem instanceof Error ? problem.message : String(problem);
      persist();
    });
    return status();
  }
  async function stopChild() {
    const previous = child;
    child = undefined;
    if (previous && !await terminateChildProcess(previous)) throw new Error("The previous web process did not stop; no replacement was launched");
  }
  async function startChild(installation) {
    const env = { ...process.env, OMP_WEB_CHANNEL_CHILD: "1", OMP_WEB_CHANNEL_CONTROL_URL: controlUrl, OMP_WEB_CHANNEL_CONTROL_TOKEN: token, OMP_WEB_CHANNEL_CURRENT: installation.channel, OMP_WEB_CHANNEL_MANAGER_ROOT: managerRoot, OMP_WEB_PACKAGE_DIR: installation.packageDir };
    const started = spawn(process.execPath, [path.join(installation.packageDir, "bin", "omp-web.js"), ...args], { cwd: installation.packageDir, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child = started;
    started.stderr.pipe(process.stderr, { end: false });
    started.stdout.pipe(process.stdout, { end: false });
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Selected web version did not become ready within 60 seconds")), readyTimeoutMs);
      const onError = (problem) => finish(problem);
      const onExit = (code) => finish(new Error(`Selected web version exited before readiness (${code})`));
      const onData = (data) => { output = (output + data.toString()).slice(-8192); if (/Ready on\b/.test(output)) finish(); };
      function finish(problem) {
        clearTimeout(timer);
        started.stdout.removeListener("data", onData);
        started.removeListener("error", onError);
        started.removeListener("exit", onExit);
        if (problem) reject(problem); else resolve();
      }
      started.once("error", onError);
      started.once("exit", onExit);
      started.stdout.on("data", onData);
    });
    started.once("exit", (code, signal) => {
      if (child !== started || switching || closing) return;
      child = undefined;
      error = `Web process exited (${code ?? signal})`;
      persist();
      onUnexpectedExit?.(code ?? 1);
    });
  }
  async function activate() {
    switching = true;
    const previous = active;
    const next = validate(selected);
    try {
      await stopChild();
      await startChild(next);
      active = next;
      error = null;
    } catch (problem) {
      error = `Could not start selected version: ${problem instanceof Error ? problem.message : String(problem)}`;
      await stopChild();
      if (sameInstall(next, previous)) throw problem;
      selected = previous;
      await startChild(previous);
      active = previous;
    } finally {
      switching = false;
      persist();
    }
  }
  function restart() {
    if (preparing || switching || closing) throw failure("Wait until version preparation has finished");
    // Validate before returning acceptance or touching the running web child.
    selected = validate(selected);
    switching = true;
    setTimeout(() => { activate().catch((problem) => { error = problem.message; onUnexpectedExit?.(1); }); }, 100);
    return status();
  }
  const control = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const provided = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from("Bearer " + token);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) { response.writeHead(403).end(JSON.stringify({ error: "Forbidden" })); return; }
    try {
      if (request.method === "GET" && request.url === "/state") { response.end(JSON.stringify(status())); return; }
      if (request.method !== "POST" || !["/select", "/restart"].includes(request.url)) throw failure("Unknown channel action", 404);
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw failure("Channel request is too large", 413); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("Invalid JSON", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("Invalid channel request", 400);
      const keys = Object.keys(body);
      const result = request.url === "/select" && keys.length === 1 && keys[0] === "channel" ? select(body.channel)
        : request.url === "/restart" && keys.length === 0 ? restart() : (() => { throw failure("Invalid channel request", 400); })();
      response.writeHead(202).end(JSON.stringify(result));
    } catch (problem) { response.writeHead(problem.status || 500).end(JSON.stringify({ error: problem.message })); }
  });
  async function close() {
    if (closeTask) return closeTask;
    closing = true;
    preparationAbort.abort();
    closeTask = (async () => {
      await stopChild();
      await prepareTask;
      control.closeAllConnections();
      if (control.listening) await new Promise((resolve) => control.close(resolve));
    })();
    return closeTask;
  }
  return {
    status, select, restart, close,
    get controlUrl() { return controlUrl; },
    get controlToken() { return token; },
    async start() {
      if (!await isPortAvailable(port, hostname)) throw new Error(`Port ${port} on ${hostname} is already in use`);
      await new Promise((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
      controlUrl = `http://127.0.0.1:${control.address().port}`;
      await activate();
    },
  };
}

async function runChannelLauncher(options) {
  let manager;
  const stop = (code) => { manager.close().finally(() => process.exit(code)); };
  manager = await createChannelManager({ ...options, onUnexpectedExit: (code) => stop(code) });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(signal, () => stop(code));
  try { await manager.start(); }
  catch (error) { await manager.close(); throw error; }
}

module.exports = { createChannelManager, runChannelLauncher };
