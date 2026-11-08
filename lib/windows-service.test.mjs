import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const {
  sanitizePort,
  sanitizeHostname,
  sanitizeMode,
  getWebServiceConfigPath,
  getWebServiceLogPath,
  getWindowsShortcutPaths,
  getWebServiceStatus,
  getHostDaemonStatus,
  getAppVersion,
  getRepoRoot,
  getSystemRoot,
  resolvePowerShellBin,
  resolveWscriptBin,
  resolveTaskkillBin,
  getWindowsExecutionEnv,
  isTrayProcessRunning,
  invalidateTrayRunningCache,
} = await import("./windows-service.ts");


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

test("sanitizeMode restricts mode to 'start' or 'dev'", () => {
  assert.equal(sanitizeMode("start"), "start");
  assert.equal(sanitizeMode("dev"), "dev");
  assert.equal(sanitizeMode("other"), "start");
  assert.equal(sanitizeMode(null, "dev"), "dev");
  assert.equal(sanitizeMode(undefined), "start");
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
  assert.ok(status.mode === "start" || status.mode === "dev");
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
  const original = { manager: process.env.OMP_WEB_CHANNEL_MANAGER_ROOT, package: process.env.OMP_WEB_PACKAGE_DIR };
  t.after(() => {
    for (const [name, value] of [["OMP_WEB_CHANNEL_MANAGER_ROOT", original.manager], ["OMP_WEB_PACKAGE_DIR", original.package]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.OMP_WEB_CHANNEL_MANAGER_ROOT = manager;
  process.env.OMP_WEB_PACKAGE_DIR = upstream;
  assert.equal(getRepoRoot(), manager);
  delete process.env.OMP_WEB_CHANNEL_MANAGER_ROOT;
  assert.equal(getRepoRoot(), upstream);
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
