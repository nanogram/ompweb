import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const {
  sanitizePort,
  sanitizeHostname,
  sanitizeMode,
  DEFAULT_WEB_SERVICE_CONFIG,
  loadWebServiceConfig,
  saveWebServiceConfig,
  getWebServiceConfigPath,
  getWebServiceLogPath,
  getWindowsShortcutPaths,
  getWebServiceStatus,
  getHostDaemonStatus,
  getAppVersion,
  getRepoRoot,
  getWindowsServiceDefinitions,
  getSystemRoot,
  resolvePowerShellBin,
  resolveWscriptBin,
  resolveTaskkillBin,
  getWindowsExecutionEnv,
  isTrayProcessRunning,
  invalidateTrayRunningCache,
} = await import("./windows-service.ts");
const { GET, POST } = await import("../app/api/windows-service/route.ts");

function isolatedConfig(t, config) {
  const root = mkdtempSync(path.join(tmpdir(), "ompweb-service-config-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  });
  const configPath = getWebServiceConfigPath();
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}


test("sanitizePort validates numeric and string port values", () => {
  assert.equal(sanitizePort(30177), 30177);
  assert.equal(sanitizePort("30178"), 30178);
  assert.equal(sanitizePort(80), 80);
  assert.equal(sanitizePort(65535), 65535);

  // Invalid values fallback to default or provided fallback
  assert.equal(sanitizePort(0), 30177);
  assert.equal(sanitizePort(-1), 30177);
  assert.equal(sanitizePort(70000), 30177);
  assert.equal(sanitizePort("invalid"), 30177);
  assert.equal(sanitizePort(null, 8080), 8080);
  assert.equal(sanitizePort(undefined, 8080), 8080);
});

test("sanitizeHostname validates and trims hostname strings", () => {
  assert.equal(sanitizeHostname("127.0.0.1"), "127.0.0.1");
  assert.equal(sanitizeHostname("  0.0.0.0  "), "0.0.0.0");
  assert.equal(sanitizeHostname("localhost"), "localhost");
  assert.equal(sanitizeHostname("192.168.1.100"), "192.168.1.100");

  // Invalid values fallback
  assert.equal(sanitizeHostname(""), "127.0.0.1");
  assert.equal(sanitizeHostname("   "), "127.0.0.1");
  assert.equal(sanitizeHostname(null, "fallback.host"), "fallback.host");
  assert.equal(sanitizeHostname(undefined, "fallback.host"), "fallback.host");
});

test("sanitizeMode accepts start, dev, and ui without falling back from ui", () => {
  assert.equal(sanitizeMode("start"), "start");
  assert.equal(sanitizeMode("dev"), "dev");
  assert.equal(sanitizeMode("ui"), "ui");
  assert.equal(sanitizeMode("other", "ui"), "ui");
  assert.equal(sanitizeMode("other"), "start");
  assert.equal(sanitizeMode(null, "dev"), "dev");
  assert.equal(sanitizeMode(undefined), "start");
});

test("GUI config survives unrelated settings saves and legacy mode round trips", async (t) => {
  const config = {
    ...DEFAULT_WEB_SERVICE_CONFIG,
    mode: "ui",
    uiSource: path.resolve("fixture source checkout"),
    uiPublicUrl: "https://desktop.example.test:8445",
    uiProxyPort: 30179,
    autostart: false,
    autoRestart: false,
  };
  const configPath = isolatedConfig(t, config);
  assert.deepEqual(await loadWebServiceConfig(), config);
  const expected = { ...config, autostart: true, port: 31234, hostname: "localhost", openBrowserOnLaunch: true };
  assert.deepEqual(await saveWebServiceConfig({ autostart: true }), { ...config, autostart: true });
  assert.deepEqual(await saveWebServiceConfig({ port: 31234, hostname: "localhost", openBrowserOnLaunch: true }), expected);
  for (const mode of ["start", "dev", "ui"]) {
    assert.deepEqual(await saveWebServiceConfig({ mode }), { ...expected, mode });
    assert.deepEqual(await loadWebServiceConfig(), { ...expected, mode });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { ...expected, mode });
  }
});

test("optional GUI config fields can be saved without changing legacy defaults", async (t) => {
  const configPath = isolatedConfig(t);
  assert.deepEqual(await loadWebServiceConfig(), DEFAULT_WEB_SERVICE_CONFIG);
  assert.deepEqual(await saveWebServiceConfig({}), DEFAULT_WEB_SERVICE_CONFIG);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), DEFAULT_WEB_SERVICE_CONFIG);
  const updates = { mode: "ui", uiSource: path.resolve("another checkout"), uiPublicUrl: "https://omp.test:8445", uiProxyPort: 65535 };
  assert.deepEqual(await saveWebServiceConfig(updates), { ...DEFAULT_WEB_SERVICE_CONFIG, ...updates });
  assert.deepEqual(await loadWebServiceConfig(), { ...DEFAULT_WEB_SERVICE_CONFIG, ...updates });
});

test("ui mode with missing source remains ui for the launcher to fail explicitly", async (t) => {
  isolatedConfig(t, { mode: "ui" });
  assert.deepEqual(await saveWebServiceConfig({ autostart: false }), { ...DEFAULT_WEB_SERVICE_CONFIG, mode: "ui", autostart: false });
});

test("Windows service API rejects invalid GUI install fields before saving", async (t) => {
  const config = { ...DEFAULT_WEB_SERVICE_CONFIG, mode: "ui", uiSource: path.resolve("source"), uiPublicUrl: "https://omp.test", uiProxyPort: 30179 };
  const configPath = isolatedConfig(t, config);
  const before = readFileSync(configPath, "utf8");
  const cases = [
    [{ mode: "other" }, "invalid_mode"],
    [{ mode: "ui", uiSource: "relative/source" }, "invalid_ui_source"],
    [{ mode: "ui", uiSource: 123 }, "invalid_ui_source"],
    ...["http://omp.test", "https://omp.test/path", "https://user:secret@omp.test", "https://omp.test?query=1", "https://omp.test#hash", "invalid", 123].map((uiPublicUrl) => [{ mode: "ui", uiPublicUrl }, "invalid_ui_public_url"]),
    ...[0, 65536, 1.5, "30179", null].map((uiProxyPort) => [{ mode: "ui", uiProxyPort }, "invalid_ui_proxy_port"]),
  ];
  for (const [fields, code] of cases) {
    const response = await POST(new Request("http://localhost/api/windows-service", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install", ...fields }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
    assert.equal(readFileSync(configPath, "utf8"), before);
  }
});

test("Windows service status API reports persisted ui mode without rewriting config", async (t) => {
  const config = { ...DEFAULT_WEB_SERVICE_CONFIG, mode: "ui", uiSource: path.resolve("source"), uiPublicUrl: "https://omp.test:8445", uiProxyPort: 30179 };
  const configPath = isolatedConfig(t, config);
  const before = readFileSync(configPath, "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await GET();
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.mode, "ui");
  assert.equal(status.port, config.port);
  assert.equal(status.hostname, config.hostname);
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("getWebServiceConfigPath returns expected web-service.json path", () => {
  const configPath = getWebServiceConfigPath();
  assert.ok(configPath.endsWith(path.join(".omp", "agent", "web-service.json")) || configPath.endsWith("web-service.json"));
});

test("getWebServiceLogPath returns expected log path", () => {
  const logPath = getWebServiceLogPath();
  assert.ok(logPath.endsWith(path.join("logs", "omp-web-service.log")));
});

test("getWindowsShortcutPaths returns expected .lnk shortcut locations", () => {
  const shortcuts = getWindowsShortcutPaths();
  assert.ok(shortcuts.desktop.endsWith(path.join("Desktop", "omp-web.lnk")));
  assert.ok(shortcuts.startMenu.endsWith(path.join("Programs", "omp-web.lnk")));
  assert.ok(shortcuts.startup.endsWith(path.join("Startup", "omp-web-tray.lnk")));
});

test("getAppVersion returns package version string", () => {
  const ver = getAppVersion();
  assert.match(ver, /^\d+\.\d+\.\d+/);
});

test("getWebServiceStatus returns a complete status object", async () => {
  const status = await getWebServiceStatus();
  assert.equal(typeof status.isWindows, "boolean");
  assert.equal(typeof status.isInstalled, "boolean");
  assert.equal(typeof status.autostart, "boolean");
  assert.equal(typeof status.isRunning, "boolean");
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.hostname, "string");
  assert.ok(["start", "dev", "ui"].includes(status.mode));
  assert.equal(typeof status.desktopShortcutExists, "boolean");
  assert.equal(typeof status.startMenuShortcutExists, "boolean");
  assert.equal(typeof status.startupShortcutExists, "boolean");
  assert.equal(typeof status.logFile, "string");
  assert.equal(typeof status.configFile, "string");
  assert.equal(typeof status.serviceUrl, "string");
  assert.equal(typeof status.version, "string");
  assert.ok(status.serviceUrl.startsWith("http://"));
  assert.equal(typeof status.daemon.isInstalled, "boolean");
  assert.equal(typeof status.daemon.isRunning, "boolean");
});


test("getHostDaemonStatus reports no daemon off Windows", async () => {
  if (process.platform === "win32") return;
  assert.deepEqual(await getHostDaemonStatus(), { isInstalled: false, isRunning: false });
});

test("service actions retain the stable manager root while a different application channel runs", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ompweb-service-channel-"));
  const manager = path.join(root, "manager");
  const upstream = path.join(root, "main");
  mkdirSync(manager);
  mkdirSync(upstream);
  const original = { service: process.env.OMP_WEB_SERVICE_ROOT, manager: process.env.OMP_WEB_CHANNEL_MANAGER_ROOT, package: process.env.OMP_WEB_PACKAGE_DIR };
  t.after(() => {
    for (const [name, value] of [["OMP_WEB_SERVICE_ROOT", original.service], ["OMP_WEB_CHANNEL_MANAGER_ROOT", original.manager], ["OMP_WEB_PACKAGE_DIR", original.package]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.OMP_WEB_SERVICE_ROOT;
  process.env.OMP_WEB_CHANNEL_MANAGER_ROOT = manager;
  process.env.OMP_WEB_PACKAGE_DIR = upstream;
  assert.equal(getRepoRoot(), manager);
  delete process.env.OMP_WEB_CHANNEL_MANAGER_ROOT;
  assert.equal(getRepoRoot(), upstream);
});

test("explicit service root overrides channel and GUI snapshot roots, even when unavailable", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ompweb-service-root-"));
  const stable = path.join(root, "installed package");
  const channel = path.join(root, "channel");
  const snapshot = path.join(root, "gui snapshot");
  for (const dir of [stable, channel, snapshot]) mkdirSync(dir);
  const names = ["OMP_WEB_SERVICE_ROOT", "OMP_WEB_CHANNEL_MANAGER_ROOT", "OMP_WEB_PACKAGE_DIR"];
  const original = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  process.env.OMP_WEB_SERVICE_ROOT = stable;
  process.env.OMP_WEB_CHANNEL_MANAGER_ROOT = channel;
  process.env.OMP_WEB_PACKAGE_DIR = snapshot;
  assert.equal(getRepoRoot(), stable);
  assert.deepEqual(getWindowsServiceDefinitions(), {
    web: { name: "omp-web", script: path.join(stable, "scripts", "windows", "omp-web-service.ps1") },
    host: { name: "omp-web-host", script: path.join(stable, "scripts", "windows", "omp-web-host.ps1") },
  });
  rmSync(stable, { recursive: true, force: true });
  assert.equal(getRepoRoot(), stable);
  delete process.env.OMP_WEB_SERVICE_ROOT;
  assert.equal(getRepoRoot(), channel);
});

test("getSystemRoot returns a valid root path", () => {
  const sysRoot = getSystemRoot();
  assert.equal(typeof sysRoot, "string");
  assert.ok(sysRoot.length > 0);
});

test("binary resolution helpers return valid executable paths on Windows", () => {
  const psBin = resolvePowerShellBin();
  const wscriptBin = resolveWscriptBin();
  const taskkillBin = resolveTaskkillBin();

  assert.equal(typeof psBin, "string");
  assert.equal(typeof wscriptBin, "string");
  assert.equal(typeof taskkillBin, "string");

  if (process.platform === "win32") {
    assert.match(psBin.toLowerCase(), /(powershell|pwsh)(\.exe)?/);
    assert.match(wscriptBin.toLowerCase(), /wscript(\.exe)?/);
    assert.match(taskkillBin.toLowerCase(), /taskkill(\.exe)?/);
  }
});

test("getWindowsExecutionEnv includes System32 and PowerShell paths in PATH on Windows", () => {
  const env = getWindowsExecutionEnv();
  assert.ok(env);
  if (process.platform === "win32") {
    const pathVal = env.PATH || env.Path || "";
    assert.match(pathVal.toLowerCase(), /system32/);
    assert.match(pathVal.toLowerCase(), /windowspowershell/);
    assert.ok(env.SystemRoot);
  }
});

test("isTrayProcessRunning caches status and refreshes on invalidateTrayRunningCache", async () => {
  invalidateTrayRunningCache();
  const running1 = await isTrayProcessRunning();
  assert.equal(typeof running1, "boolean");

  const running2 = await isTrayProcessRunning();
  assert.equal(running1, running2);

  invalidateTrayRunningCache();
  const running3 = await isTrayProcessRunning();
  assert.equal(typeof running3, "boolean");
});
