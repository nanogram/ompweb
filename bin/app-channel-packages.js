"use strict";

const fs = process.getBuiltinModule("node:fs/promises");
const path = process.getBuiltinModule("node:path");
const { spawn } = process.getBuiltinModule("node:child_process");
const { createHash } = process.getBuiltinModule("node:crypto");
const { terminateChildProcess } = module.require("./process-lifecycle.js");

const UPSTREAM = "https://github.com/kahme247/ompweb.git";
const UPSTREAM_IDENTITY = "git+https://github.com/kahme247/ompweb.git";
const SHARED_FILES = [
  "components/AppChannelSelector.tsx",
  "lib/app-channel.ts",
  "lib/app-channel-update-route.ts",
  "app/api/app-channel/route.ts",
];
const LOCALES = ["en", "ja", "zh-CN", "zh-TW"];
const SETTINGS_IMPORT = 'import { ToggleSwitch } from "@/components/ui/ToggleSwitch";';
const SELECTOR_IMPORT = 'import { AppChannelSelector } from "@/components/AppChannelSelector";';
const CARD_OPEN = '                {/* ompweb app update card */}\n                <section style={{ padding: 14, border: appUpdateIsAvailable ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>';
const CARD_END = '                  {appUpdateMessage && <Alert variant={appUpdateMessage.toLowerCase().includes("fail") || appUpdateMessage.toLowerCase().includes("error") ? "error" : "info"} description={appUpdateMessage} onDismiss={() => setAppUpdateMessage(null)} />}\n                </section>';

function replaceOnce(text, context, replacement, label) {
  const at = text.indexOf(context);
  if (at < 0 || text.indexOf(context, at + context.length) !== -1) {
    throw new Error(`Incompatible upstream ${label}: expected one verified insertion context`);
  }
  return text.slice(0, at) + replacement + text.slice(at + context.length);
}

async function readPackage(root) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (typeof metadata.version !== "string" || !metadata.version.trim()) throw new Error("Package version is missing");
  return metadata;
}

function assertUpstream(metadata) {
  if (metadata.name !== "@kahme247/ompweb" || metadata.repository?.url !== UPSTREAM_IDENTITY) {
    throw new Error("Main source does not have the actual kahme247/ompweb package identity");
  }
}

async function readOverlayInputs(managerRoot) {
  const files = new Map();
  for (const relative of SHARED_FILES) files.set(relative, await fs.readFile(path.join(managerRoot, relative)));
  const locales = new Map();
  for (const locale of LOCALES) {
    const manager = JSON.parse(await fs.readFile(path.join(managerRoot, `lib/i18n/locales/${locale}.json`), "utf8"));
    const entries = Object.entries(manager).filter(([key]) => key.startsWith("appChannel.")).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length || entries.some(([, value]) => typeof value !== "string")) throw new Error(`Missing channel translations for ${locale}`);
    locales.set(locale, entries);
  }
  return { files, locales };
}

function overlayFingerprint(inputs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([SETTINGS_IMPORT, SELECTOR_IMPORT, CARD_OPEN, CARD_END, applyMainOverlay.toString()]));
  for (const [relative, content] of inputs.files) {
    hash.update(JSON.stringify([relative, content.length]));
    hash.update(content);
  }
  for (const [locale, entries] of inputs.locales) hash.update(JSON.stringify([locale, entries]));
  return hash.digest("hex");
}

/** Apply only channel controls to an owned, pristine upstream checkout. Preflight all contexts before writing. */
async function overlayMainSource({ managerRoot, sourceRoot }) {
  return applyMainOverlay({ managerRoot, sourceRoot }, await readOverlayInputs(managerRoot));
}

async function applyMainOverlay({ managerRoot, sourceRoot }, inputs) {
  if (await fs.realpath(managerRoot) === await fs.realpath(sourceRoot)) throw new Error("Main source must be separate from the manager package");
  assertUpstream(await readPackage(sourceRoot));
  const writes = new Map(inputs.files);

  let settings = (await fs.readFile(path.join(sourceRoot, "components/SettingsConfig.tsx"), "utf8")).replace(/\r\n/g, "\n");
  if (settings.includes("AppChannelSelector")) throw new Error("Incompatible upstream SettingsConfig: channel controls already exist");
  const start = settings.indexOf(CARD_OPEN);
  const end = settings.indexOf(CARD_END);
  if (start < 0 || end < start || settings.slice(start, end).includes("</section>") || !settings.slice(start, end).includes('t("settingsConfig.appLabel")')) {
    throw new Error("Incompatible upstream SettingsConfig: application update card cannot be verified");
  }
  settings = replaceOnce(settings, SETTINGS_IMPORT, `${SETTINGS_IMPORT}\n${SELECTOR_IMPORT}`, "SettingsConfig import");
  replaceOnce(settings, CARD_OPEN, CARD_OPEN, "application update card");
  settings = replaceOnce(settings, CARD_END, `                  <AppChannelSelector />\n${CARD_END}`, "application update card end");
  settings = replaceOnce(settings, 'appUpdatesDisabled ? t("settingsConfig.updatesDisabled")',
    'appUpdatesDisabled ? (appUpdate?.currentVersion ?? t("settingsConfig.versionUnavailable"))', "managed application version label");
  writes.set("components/SettingsConfig.tsx", settings);

  let routes = await fs.readFile(path.join(sourceRoot, "server/routes.ts"), "utf8");
  if (routes.includes("app-channel") || /\bappChannel\b/.test(routes)) throw new Error("Incompatible upstream routes: channel route already exists");
  const routeImport = 'import * as appUpdate from "@/app/api/app-update/route";';
  routes = replaceOnce(routes, routeImport, `${routeImport}\nimport * as appChannel from "@/app/api/app-channel/route";`, "route import");
  const routeEntry = '  "app-update": appUpdate,';
  routes = replaceOnce(routes, routeEntry, `${routeEntry}\n  "app-channel": appChannel,`, "route table");
  writes.set("server/routes.ts", routes);
  // Refuse an incompatible checkout missing the existing updater rather than silently adding a dead route.
  await fs.access(path.join(sourceRoot, "app/api/app-update/route.ts"));
  writes.set("app/api/app-update/route.ts", 'export { GET, POST } from "@/lib/app-channel-update-route";\n');

  const secretsPath = "lib/project-command-env.ts";
  const secrets = await fs.readFile(path.join(sourceRoot, secretsPath), "utf8");
  writes.set(secretsPath, replaceOnce(secrets,
    "export const OMP_WEB_SECRET_ENV_VARS: readonly string[] = [",
    'export const OMP_WEB_SECRET_ENV_VARS: readonly string[] = [\n  "OMP_WEB_CHANNEL_CONTROL_TOKEN",',
    "child credential boundary"));

  const servicePath = "lib/windows-service.ts";
  const service = await fs.readFile(path.join(sourceRoot, servicePath), "utf8");
  writes.set(servicePath, replaceOnce(service,
    "export function getRepoRoot(): string {",
    'export function getRepoRoot(): string {\n  if (process.env.OMP_WEB_CHANNEL_MANAGER_ROOT && existsSync(process.env.OMP_WEB_CHANNEL_MANAGER_ROOT)) {\n    return process.env.OMP_WEB_CHANNEL_MANAGER_ROOT;\n  }',
    "stable service manager root"));

  for (const locale of LOCALES) {
    const relative = `lib/i18n/locales/${locale}.json`;
    let source;
    try { source = await fs.readFile(path.join(sourceRoot, relative), "utf8"); }
    catch (error) {
      // Traditional Chinese is a fork feature, not a prerequisite for upstream Main.
      if (locale === "zh-TW" && error.code === "ENOENT") continue;
      throw error;
    }
    const upstream = JSON.parse(source);
    const entries = inputs.locales.get(locale);
    for (const [key, value] of entries) upstream[key] = value;
    writes.set(relative, `${JSON.stringify(upstream, null, 2)}\n`);
  }

  for (const [relative, content] of writes) {
    const target = path.join(sourceRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function readyPackage(packageDir, revision, fingerprint) {
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(packageDir, ".omp-web-channel.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      try { await fs.access(packageDir); } catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    }
    throw new Error("Existing main cache is incomplete; refusing to overwrite it", { cause: error });
  }
  if (marker.channel !== "main" || marker.repository !== UPSTREAM || marker.revision !== revision || marker.overlayFingerprint !== fingerprint) {
    throw new Error("Existing main cache identity does not match its revision and overlay");
  }
  const metadata = await readPackage(packageDir);
  assertUpstream(metadata);
  if (metadata.version !== marker.version) throw new Error("Existing main cache version does not match its package");
  await assertReadyFiles(packageDir);
  return { channel: "main", packageDir, version: metadata.version, revision };
}

async function assertReadyFiles(packageDir) {
  for (const relative of ["dist/index.html", "dist/event-stream-worker.js", "bin/omp-web.js", "server/main.ts"]) {
    const stat = await fs.stat(path.join(packageDir, relative));
    if (!stat.isFile() || !stat.size) throw new Error(`Main build is missing ${relative}`);
  }
}

/** Only OS executable-discovery/locale variables survive. No provider, control, npm or Git credentials are inherited. */
async function buildEnvironment(work) {
  const env = {};
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) env[key] = value;
  const home = path.join(work, "home");
  const temporary = path.join(work, "tmp");
  const config = path.join(home, "config");
  const hooks = path.join(work, "hooks");
  for (const dir of [home, temporary, config, hooks, path.join(home, "agent"), path.join(home, "appdata"), path.join(home, "localappdata")]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const userConfig = path.join(config, "npm-user.conf");
  const globalConfig = path.join(config, "npm-global.conf");
  const gitConfig = path.join(config, "gitconfig");
  for (const file of [userConfig, globalConfig, gitConfig]) await fs.writeFile(file, "", { mode: 0o600 });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: path.join(home, "agent"),
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: path.join(home, "npm-cache"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
    CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
  });
  return { env, hooks };
}

function run(file, args, options, label) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    signal?.throwIfAborted();
    // A separate POSIX process group lets cancellation reap npm/build descendants too.
    // Do not pass Node's signal option: it kills cmd.exe before its Windows tree can be reaped.
    const child = spawn(file, args, { ...spawnOptions, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let spawnError;
    const abort = () => { void terminateChildProcess(child); };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, exitSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (spawnError) reject(new Error(`${label} failed: ${spawnError.message}`));
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${label} failed (${exitSignal || code}): ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

/** Build an immutable package beside (never over) existing installations. Only the supervisor commits selection. */
async function prepareChannelPackage({ channel, managerRoot, channelsRoot, onProgress = () => {}, signal }) {
  signal?.throwIfAborted();
  if (channel !== "main" && channel !== "fork") throw new Error("Unknown application channel");
  managerRoot = await fs.realpath(managerRoot);
  if (channel === "fork") return { channel, packageDir: managerRoot, version: (await readPackage(managerRoot)).version, revision: null };
  await fs.mkdir(channelsRoot, { recursive: true, mode: 0o700 });
  channelsRoot = await fs.realpath(channelsRoot);
  const work = await fs.mkdtemp(path.join(channelsRoot, ".prepare-main-"));
  try {
    const { env, hooks } = await buildEnvironment(work);
    const git = (args, cwd = work) => run("git", ["-c", "credential.helper=", "-c", `core.hooksPath=${hooks}`, ...args], { cwd, env, signal }, "Upstream source preparation");
    onProgress("resolving");
    const remote = await git(["ls-remote", "--exit-code", UPSTREAM, "refs/heads/main"]);
    const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(remote);
    if (!match) throw new Error("Could not resolve upstream main to one exact revision");
    const revision = match[1];
    const inputs = await readOverlayInputs(managerRoot);
    const fingerprint = overlayFingerprint(inputs);
    // Keep the nested Windows runtime executable below the loader's path limit.
    // Full revision/fingerprint identities are still verified in the ready marker.
    const packageDir = path.join(channelsRoot, `main-${revision.slice(0, 12)}-${fingerprint.slice(0, 12)}`);
    const cached = await readyPackage(packageDir, revision, fingerprint);
    if (cached) {
      signal?.throwIfAborted();
      return cached;
    }
    const sourceRoot = path.join(work, "package");
    await fs.mkdir(sourceRoot);
    onProgress("downloading");
    await git(["init", "--template=", "."], sourceRoot);
    await git(["remote", "add", "origin", UPSTREAM], sourceRoot);
    await git(["fetch", "--depth=1", "origin", revision], sourceRoot);
    await git(["checkout", "--detach", "FETCH_HEAD"], sourceRoot);
    if (await git(["rev-parse", "HEAD"], sourceRoot) !== revision) throw new Error("Downloaded main revision does not match resolved upstream commit");
    const metadata = await readPackage(sourceRoot);
    assertUpstream(metadata);
    if (metadata.scripts?.build !== "bun scripts/build-client.ts") throw new Error("Incompatible upstream build command");
    onProgress("overlaying");
    await applyMainOverlay({ managerRoot, sourceRoot }, inputs);
    onProgress("installing");
    const options = { cwd: sourceRoot, env, signal };
    if (process.platform === "win32") {
      // Only this constant command enters cmd.exe; paths and revisions never enter shell text.
      await run(env.ComSpec || env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", "npm ci --ignore-scripts --no-audit --no-fund"], options, "Main dependency installation");
    } else {
      await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], options, "Main dependency installation");
    }
    onProgress("building");
    const { resolveBunBinary } = module.require(path.join(managerRoot, "bin/bun-runtime.js"));
    const bun = resolveBunBinary(managerRoot, env);
    await run(bun, ["scripts/build-client.ts"], options, "Main build");
    await assertReadyFiles(sourceRoot);
    const release = { channel, version: metadata.version, revision };
    await fs.writeFile(path.join(sourceRoot, ".omp-web-channel.json"), `${JSON.stringify({ ...release, repository: UPSTREAM, overlayFingerprint: fingerprint }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // Clean isolated credentials/config/cache before publication; never remove a ready package.
    await fs.rm(path.join(work, "home"), { recursive: true, force: true });
    await fs.rm(path.join(work, "tmp"), { recursive: true, force: true });
    onProgress("ready");
    signal?.throwIfAborted();
    try {
      // The destination is never created until it contains a complete package. Concurrent
      // publishers cannot replace its nonempty directory; the loser reuses the winner.
      await fs.rename(sourceRoot, packageDir);
    } catch (error) {
      const winner = await readyPackage(packageDir, revision, fingerprint);
      signal?.throwIfAborted();
      if (winner) return winner;
      throw error;
    }
    signal?.throwIfAborted();
    return { ...release, packageDir };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { prepareChannelPackage, overlayMainSource };
