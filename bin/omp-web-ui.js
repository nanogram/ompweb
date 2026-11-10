#!/usr/bin/env node
"use strict";

const path = module.require("node:path");
const fs = module.require("node:fs");
const net = module.require("node:net");
const os = module.require("node:os");
const { parseArgs } = module.require("node:util");
const { spawn } = module.require("node:child_process");
const { resolveBunBinary } = module.require("./bun-runtime");
const { isPortAvailable } = module.require("./port-availability");
const { terminateChildProcess } = module.require("./process-lifecycle");
const { getBrowserUrl } = module.require("./network-addresses");
const { hashPassword, isPasswordHash } = module.require("./omp-web-password-hash");
const { createCustomizationWorkspace, validateSource, watchCustomizationSource } = module.require("./ui-customization-files");
const { customizationPublicOrigin, startCustomizationProxy } = module.require("./ui-customization-proxy");
const { runChannelLauncher } = module.require("./omp-web-channel");
const CHANNEL_ENV = ["OMP_WEB_CHANNEL_CHILD", "OMP_WEB_CHANNEL_CONTROL_URL", "OMP_WEB_CHANNEL_CONTROL_TOKEN", "OMP_WEB_CHANNEL_CURRENT", "OMP_WEB_CHANNEL_MANAGER_ROOT"];

const HELP = `Usage: node bin/omp-web-ui.js [options]

  --source <directory>     Source checkout with installed frontend dependencies
  -H, --hostname <host>    Loopback only (default 127.0.0.1)
  -p, --port <port>        Unoccupied preview port (default 30178)
  --public-url <origin>   Trusted HTTPS VPN/proxy origin for remote browser HMR
  --proxy-port <port>     Loopback ingress for that proxy (default preview port + 1)
  --primary               Reuse the existing matching primary host link read-only
  --service-root <dir>    Stable installed service package (required with --primary)
  -h, --help               Show this help

Snapshots source into a private temporary workspace and synchronizes only the
explicit display/style allowlist. Other changes require a web-only restart.
Default preview mode attaches a secondary host link; --primary preserves the
existing primary link and token. No daemon is started or stopped.
Bun --hot/--watch and non-loopback binds are deliberately unsupported.
`;

function loopbackHostname(value) {
  const hostname = value.trim().toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
  if (hostname === "localhost") return "127.0.0.1"; // Never resolve a configurable DNS name.
  if (net.isIP(hostname) === 4 && hostname.split(".")[0] === "127") return hostname;
  if (net.isIP(hostname) === 6 && new URL(`http://[${hostname}]`).hostname === "[::1]") return "::1";
  throw new Error("UI customization only supports a loopback hostname (127.0.0.1, localhost or ::1)");
}
function parseUiOptions(args = process.argv.slice(2)) {
  if (args.some((arg) => /^--(?:hot|watch)(?:=|$)/.test(arg))) throw new Error("UI customization must not use --hot or --watch; only browser HMR is enabled");
  const { values } = parseArgs({ args, options: {
    source: { type: "string" }, hostname: { type: "string", short: "H" }, port: { type: "string", short: "p" }, help: { type: "boolean", short: "h" },
    "public-url": { type: "string" }, "proxy-port": { type: "string" },
    primary: { type: "boolean" }, "service-root": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (values.help) return { help: true };
  const port = values.port ?? "30178";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Preview port must be an integer from 1 to 65535");
  const publicUrl = values["public-url"] === undefined ? undefined : customizationPublicOrigin(values["public-url"]);
  const proxyPort = values["proxy-port"];
  if (proxyPort !== undefined && (!publicUrl || !/^\d{1,5}$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535 || Number(proxyPort) === Number(port))) {
    throw new Error("Proxy port requires --public-url and a different port from 1 to 65535");
  }
  if (Boolean(values.primary) !== Boolean(values["service-root"])) throw new Error("--primary and --service-root must be supplied together");
  return { source: path.resolve(values.source ?? path.join(__dirname, "..")), hostname: loopbackHostname(values.hostname ?? "127.0.0.1"), port: Number(port),
    ...(publicUrl ? { publicUrl, ...(proxyPort === undefined ? {} : { proxyPort: Number(proxyPort) }) } : {}),
    ...(values.primary ? { primary: true, serviceRoot: path.resolve(values["service-root"]) } : {}) };
}

/** Keep the existing HOME/PI profile, but never inherit an agent's supervisor/IPC launch identity. */
function uiEnvironment(base, sourceRoot, snapshotRoot, hostname, port, { primary = false, serviceRoot, channelControl } = {}) {
  const env = {};
  let plaintext;
  let passwordHash;
  for (const [name, value] of Object.entries(base)) {
    const upper = name.toUpperCase();
    if (upper === "OMP_WEB_PASSWORD") { plaintext = value; continue; }
    if (upper === "OMP_WEB_PASSWORD_HASH") { passwordHash = value?.trim(); continue; }
    if (upper.startsWith("OMP_WEB_CHANNEL_") || upper.startsWith("OMP_WEB_PUBLIC_") || upper.startsWith("OMP_WEB_UPDATE_")
      || ["OMP_WEB_PACKAGE_DIR", "OMP_WEB_LAUNCHER_PID", "OMP_WEB_NODE_BIN", "OMP_WEB_RESTART_DESCRIPTOR", "OMP_WEB_UI_CUSTOMIZATION", "OMP_WEB_UI_SOURCE_ROOT",
        "OMP_WEB_UI_PRIMARY_LINK", "OMP_WEB_SERVICE_ROOT", "OMP_WEB_SERVICE_CONFIG_PATH", "OMP_WEB_DISABLE_AUTOUPDATE", "OMP_WEB_PORT", "OMP_WEB_HOSTNAME", "NODE_ENV", "PORT", "NODE_OPTIONS", "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_NOTIFY",
        "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"].includes(upper)) continue;
    env[name] = value;
  }
  if (plaintext && passwordHash) throw new Error("OMP_WEB_PASSWORD_HASH and plaintext OMP_WEB_PASSWORD are both set; remove OMP_WEB_PASSWORD");
  if (plaintext) passwordHash = hashPassword(plaintext);
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) throw new Error("OMP_WEB_PASSWORD_HASH is invalid; generate one with ompweb hash-password");
  if (passwordHash) env.OMP_WEB_PASSWORD_HASH = passwordHash;
  const serviceConfig = primary ? base.OMP_WEB_SERVICE_CONFIG_PATH : undefined;
  if (serviceConfig && !path.isAbsolute(serviceConfig)) throw new Error("Primary UI service configuration must be an absolute path");
  if (serviceConfig) env.OMP_WEB_SERVICE_CONFIG_PATH = serviceConfig;
  if (primary && channelControl) {
    for (const name of CHANNEL_ENV) if (typeof channelControl[name] === "string") env[name] = channelControl[name];
  }
  return { ...env, NODE_ENV: "development", OMP_WEB_PACKAGE_DIR: snapshotRoot, OMP_WEB_UI_CUSTOMIZATION: "1", OMP_WEB_UI_SOURCE_ROOT: sourceRoot,
    OMP_WEB_DISABLE_AUTOUPDATE: "1", OMP_WEB_HOSTNAME: hostname, OMP_WEB_PORT: String(port), PORT: String(port),
    ...(primary ? { OMP_WEB_UI_PRIMARY_LINK: "1", OMP_WEB_SERVICE_ROOT: serviceRoot } : {}) };
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("UI preview did not become ready before the startup deadline")), timeoutMs);
    const onData = (data) => { output = (output + data.toString()).slice(-8192); if (/\bReady on\b/.test(output)) finish(); };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`UI preview exited before readiness (${code ?? signal})`));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function removePreviewLink(bun, workspace, origin, env, stderr) {
  const child = spawn(bun, [path.join(workspace.snapshotRoot, "server", "ui-link.ts"), "--remove", origin], {
    cwd: workspace.snapshotRoot, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.pipe(stderr, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminateChildProcess(child).then(() => reject(new Error("UI preview link cleanup timed out")), reject);
    }, 10_000);
    function finish(error) { clearTimeout(timer); if (error) reject(error); else resolve(); }
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`UI preview link cleanup exited (${code ?? signal})`)));
  });
}

/** Owns its snapshot and Bun web subtree, and removes only a secondary link it attached. */
async function startUiCustomization({ source, hostname = "127.0.0.1", port, publicUrl, proxyPort = port === 65535 ? 65534 : port + 1,
  primary = false, serviceRoot, channelControl, env: baseEnv = process.env, temporaryRoot, pollIntervalMs = 750, readyTimeoutMs = 60_000, stdout = process.stdout, stderr = process.stderr, handleSignals = false }) {
  hostname = loopbackHostname(hostname);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Preview port must be an integer from 1 to 65535");
  if (Boolean(primary) !== Boolean(serviceRoot)) throw new Error("--primary and --service-root must be supplied together");
  if (!await isPortAvailable(port, hostname)) throw new Error(`Port ${port} on ${hostname} is already in use; no process was stopped`);
  const publicOrigin = publicUrl === undefined ? undefined : customizationPublicOrigin(publicUrl);
  if (publicOrigin && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535 || proxyPort === port || !await isPortAvailable(proxyPort, hostname))) {
    throw new Error("The trusted GUI proxy needs another unoccupied loopback port from 1 to 65535");
  }
  const { sourceRoot } = validateSource(source);
  if (serviceRoot !== undefined) {
    serviceRoot = fs.realpathSync(serviceRoot);
    if (!fs.existsSync(path.join(serviceRoot, "package.json")) || !fs.existsSync(path.join(serviceRoot, "bin", "omp-web.js"))) {
      throw new Error("UI service root must be a stable installed OMPweb package");
    }
  }
  const launchContext = { primary, serviceRoot, channelControl };
  const initialEnv = uiEnvironment(baseEnv, sourceRoot, sourceRoot, hostname, port, launchContext);
  const bun = resolveBunBinary(sourceRoot, initialEnv);
  const workspace = createCustomizationWorkspace(sourceRoot, { temporaryRoot });
  const env = uiEnvironment(initialEnv, sourceRoot, workspace.snapshotRoot, hostname, port, launchContext);
  const origin = getBrowserUrl(hostname, port);
  let child;
  let ingress;
  try {
    child = spawn(bun, [path.join(workspace.snapshotRoot, "server", "ui.ts"), "-H", hostname, "-p", String(port)], {
      cwd: workspace.snapshotRoot, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) { workspace.cleanup(); throw error; }
  child.stdout.pipe(stdout, { end: false });
  child.stderr.pipe(stderr, { end: false });
  let closing;
  let interval;
  let stopWatching;
  let rescan = false;
  const dirty = new Set();
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const signals = new Map();
  function close(exitCode = 0) {
    if (closing) return closing;
    clearInterval(interval);
    closing = (async () => {
      const errors = [];
      try { stopWatching?.(); } catch (error) { errors.push(error.message); }
      // Keep our listening port reserved until our own secondary link is removed.
      if (child.pid && !primary) {
        try { await removePreviewLink(bun, workspace, origin, env, stderr); } catch (error) { errors.push(error.message); }
      }
      let stopped = true;
      try { if (child.pid) stopped = await terminateChildProcess(child); } catch (error) { stopped = false; errors.push(error.message); }
      try { await ingress?.close(); } catch (error) { errors.push(error.message); }
      if (stopped) {
        try { workspace.cleanup(); } catch (error) { errors.push(error.message); }
      } else errors.push(`Owned UI web child did not stop; snapshot retained at ${workspace.snapshotRoot}`);
      for (const [signal, handler] of signals) process.removeListener(signal, handler);
      finish(errors.length ? 1 : exitCode);
      if (errors.length) throw new Error(errors.join("; "));
    })();
    return closing;
  }
  const unexpected = (code) => { close(code).catch((error) => stderr.write(`UI preview cleanup failed: ${error.message}\n`)); };
  child.once("exit", (code, signal) => {
    if (!closing) unexpected(code ?? (128 + (os.constants.signals[signal] ?? 1)));
  });
  child.once("error", () => { if (!closing) unexpected(1); });
  if (handleSignals) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => { close(128 + (os.constants.signals[signal] ?? 1)).catch((error) => stderr.write(`UI preview cleanup failed: ${error.message}\n`)); };
      signals.set(signal, handler);
      process.on(signal, handler);
    }
  }
  try {
    stopWatching = watchCustomizationSource(sourceRoot, (relative) => {
      if (relative === null) rescan = true;
      else dirty.add(relative);
    }, (error) => {
      stderr.write(`UI source watcher failed: ${error.message}\n`);
      unexpected(1);
    });
    await waitForReady(child, readyTimeoutMs);
    if (closing) throw new Error("UI preview stopped during startup");
    // Bridge source edits during snapshot/startup once. Idle previews do no
    // recursive filesystem polling, keeping the HTTP/HMR event loop responsive.
    workspace.sync();
    dirty.clear();
    rescan = false;
    if (publicOrigin) ingress = await startCustomizationProxy({ publicUrl: publicOrigin, hostname, port: proxyPort, upstream: origin });
    if (closing) { await ingress?.close(); throw new Error("UI preview stopped during startup"); }
    interval = setInterval(() => {
      if (!rescan && dirty.size === 0) return;
      const changes = rescan ? undefined : [...dirty];
      dirty.clear();
      rescan = false;
      try {
        if (!workspace.sync(changes).lastError) return;
      } catch (error) { stderr.write(`UI preview synchronization failed: ${error.message}\n`); }
      if (changes) for (const relative of changes) dirty.add(relative);
      else rescan = true;
    }, pollIntervalMs);
    stdout.write(`[omp-web-ui] Ready on ${publicOrigin ?? origin}\n[omp-web-ui] Watching display/style source: ${sourceRoot}\n`);
    if (ingress) stdout.write(`[omp-web-ui] Trusted HTTPS proxy target: ${ingress.origin}\n`);
  } catch (error) {
    try { await close(1); } catch (cleanupError) { stderr.write(`UI preview cleanup failed: ${cleanupError.message}\n`); }
    throw error;
  }
  return { child, sourceRoot, snapshotRoot: workspace.snapshotRoot, origin, publicUrl: publicOrigin, proxyOrigin: ingress?.origin,
    status: workspace.status, sync: workspace.sync, close, done };
}

async function main(args = process.argv.slice(2)) {
  const options = parseUiOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  let channelControl;
  if (options.primary) {
    options.serviceRoot = fs.realpathSync(options.serviceRoot);
    options.source = validateSource(options.source).sourceRoot;
    let managed = false;
    try {
      const control = new URL(process.env.OMP_WEB_CHANNEL_CONTROL_URL);
      managed = process.env.OMP_WEB_CHANNEL_CHILD === "1"
        && process.env.OMP_WEB_CHANNEL_CURRENT === "fork"
        && fs.realpathSync(process.env.OMP_WEB_CHANNEL_MANAGER_ROOT) === options.serviceRoot
        && control.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(control.hostname)
        && !control.username && !control.password && control.pathname === "/" && !control.search && !control.hash
        && Boolean(process.env.OMP_WEB_CHANNEL_CONTROL_TOKEN);
    } catch { /* An ordinary launch creates its own private channel manager. */ }
    if (!managed) {
      const forkCommand = [process.execPath, __filename, "--source", options.source, "-H", options.hostname,
        "-p", String(options.port), "--primary", "--service-root", options.serviceRoot];
      // The ingress belongs to the stable supervisor, not its replaceable fork
      // child, so switching to Main keeps the normal HTTPS address working.
      const ingress = options.publicUrl ? await startCustomizationProxy({ publicUrl: options.publicUrl,
        hostname: options.hostname, port: options.proxyPort ?? (options.port === 65535 ? 65534 : options.port + 1),
        upstream: getBrowserUrl(options.hostname, options.port) }) : undefined;
      try {
        await runChannelLauncher({ managerRoot: options.serviceRoot, hostname: options.hostname, port: options.port,
          args: ["-p", String(options.port), "-H", options.hostname, "--no-open"], forkCommand });
      } catch (error) { await ingress?.close(); throw error; }
      if (ingress) process.stdout.write(`[omp-web-ui] Trusted HTTPS proxy target: ${ingress.origin}\n`);
      return;
    }
    channelControl = Object.fromEntries(CHANNEL_ENV.map(name => [name, process.env[name]]));
  }
  const preview = await startUiCustomization({ ...options, channelControl, handleSignals: true });
  process.exitCode = await preview.done;
}

module.exports = { parseUiOptions, uiEnvironment, startUiCustomization, main };
if (require.main === module) main().catch((error) => { console.error(`Could not start UI preview: ${error.message}`); process.exitCode = 1; });
