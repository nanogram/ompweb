#!/usr/bin/env node
"use strict";

// Web-only promotion. Never run install-tray.ps1: that installer also owns the host daemon.
const fs = process.getBuiltinModule("node:fs/promises");
const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const { createHash, createHmac, randomBytes } = process.getBuiltinModule("node:crypto");
const { execFile, spawn } = process.getBuiltinModule("node:child_process");
const { promisify, parseArgs } = process.getBuiltinModule("node:util");
const { setTimeout: sleep } = process.getBuiltinModule("node:timers/promises");
const { stageRelease } = module.require("../ui-release.cjs");
const { validateSource } = module.require("../../bin/ui-customization-files.js");
const exec = promisify(execFile);
const DEFAULT_SOURCE = path.resolve(__dirname, "../..");
const PACKAGE_NAME = "@kahme247/ompweb";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const samePath = (a, b) => typeof a === "string" && typeof b === "string"
  && path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
const defaultConfig = () => path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), "web-service.json");

function windowsOnly() {
  if (process.platform !== "win32") throw new Error("Windows UI service automation requires Windows.");
}
function port(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer from 1 to 65535.`);
  return value;
}
function buildUiConfig(existing, options = {}) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("web-service.json must contain an object.");
  const hostname = existing.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) throw new Error("UI service promotion requires the existing hostname to be loopback; bind settings were not changed.");
  const result = { ...existing, port: port(existing.port ?? 30177, "Configured port"), hostname, mode: "ui", uiSource: path.resolve(options.sourceRoot || DEFAULT_SOURCE) };
  const publicUrl = options.publicUrl ?? existing.uiPublicUrl;
  if (publicUrl != null) {
    const url = new URL(publicUrl);
    if (typeof publicUrl !== "string" || /[\s"<>]/.test(publicUrl) || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("--public-url must be one trusted HTTPS origin without credentials, path, query or fragment.");
    }
    result.uiPublicUrl = url.origin;
    result.uiProxyPort = port(options.proxyPort ?? existing.uiProxyPort ?? (result.port === 65535 ? 65534 : result.port + 1), "Proxy port");
    if (result.uiProxyPort === result.port) throw new Error("UI proxy port must differ from the primary web port.");
  } else {
    if (options.proxyPort !== undefined) throw new Error("--proxy-port requires a configured --public-url.");
    delete result.uiPublicUrl;
    delete result.uiProxyPort;
  }
  return result;
}
function parsePrivateJson(bytes, file) {
  try { return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Cannot parse JSON at ${file}; private file contents were not printed.`); }
}
async function readJson(file) {
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch (error) { throw new Error(`Cannot read ${file} (${error.code || "read failure"}).`); }
  return parsePrivateJson(bytes, file);
}
async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

const PS_COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = $env:OMP_UI_SERVICE_INPUT | ConvertFrom-Json
function SamePath([string]$a, [string]$b) {
  if (!$a -or !$b) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($a).TrimEnd('\'), [IO.Path]::GetFullPath($b).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function MatchesConfig([string]$arguments) {
  $matches = [regex]::Matches($arguments, '(?i)(?:^|\s)-ConfigPath(?:\s+|=)(?:"([^"]+)"|([^\s"]+))')
  if ($matches.Count -gt 1) { return $false }
  if ($matches.Count -eq 1) {
    $m = $matches[0]
    $candidate = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
    return [IO.Path]::IsPathRooted($candidate) -and (SamePath $candidate $p.configPath)
  }
  return SamePath $p.configPath (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.omp\agent\web-service.json')
}
function ContainsPath([string]$arguments, [string]$candidate) {
  return [regex]::IsMatch($arguments, '(?i)(?:^|[\s"])' + [regex]::Escape($candidate) + '(?=$|[\s"])')
}
function ExportWebTask {
  $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -ceq 'omp-web' } | Select-Object -First 1
  if (!$task) { return $null }
  return (Export-ScheduledTask -TaskName 'omp-web' -TaskPath '\' -ErrorAction Stop).Trim()
}
`;
async function powershell(script, input = {}) {
  windowsOnly();
  const encoded = Buffer.from("try {\n" + PS_COMMON + "\n" + script + "\n} catch { [Console]::Error.WriteLine('OMP_UI_SERVICE_ERROR:' + $_.Exception.Message); exit 1 }", "utf16le").toString("base64");
  try {
    const { stdout } = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
      env: { ...process.env, OMP_UI_SERVICE_INPUT: JSON.stringify(input) },
    });
    return stdout.replace(/^\uFEFF/, "").trim();
  } catch (error) {
    const diagnostic = /OMP_UI_SERVICE_ERROR:([^\r\n]+)/.exec(String(error.stderr || ""))?.[1];
    throw new Error(`Windows operation failed (exit ${error.code ?? "unknown"}). ${error.killed ? "Operation timed out." : diagnostic || "Private process output was withheld; check Windows permissions and the scoped controller."}`, { cause: error });
  }
}
async function psJson(script, input) {
  const text = await powershell(script, input);
  try { return JSON.parse(text); } catch { throw new Error("Windows operation returned invalid JSON; no success was assumed."); }
}
async function resolveServiceRoot(options = {}) {
  if (options.serviceRoot) return path.resolve(options.serviceRoot);
  const root = await powershell("$r = & npm.cmd root --global; if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve global npm root' }; [Console]::Write(($r | Select-Object -Last 1).Trim())");
  if (!path.isAbsolute(root)) throw new Error("npm did not return an absolute global package directory.");
  return path.join(root, ...PACKAGE_NAME.split("/"));
}
async function inspectJunction(serviceRoot) {
  return psJson(String.raw`
$item = Get-Item -LiteralPath $p.serviceRoot -Force -ErrorAction Stop
if ($item.LinkType -ne 'Junction' -or @($item.Target).Count -ne 1) { throw 'Existing global package must be a directory junction; refusing an ordinary directory or another link type.' }
$target = [IO.Path]::GetFullPath([string]@($item.Target)[0])
if (!(Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf)) { throw 'Global package junction is broken.' }
@{ serviceRoot = $item.FullName; target = $target } | ConvertTo-Json -Compress
`, { serviceRoot });
}
async function savedPackageRoot(configPath, junction) {
  let file;
  try { file = await deploymentFile({}, configPath); }
  catch (error) {
    if (error.message.startsWith("No active deployment receipt exists")) return junction.target;
    throw error;
  }
  const saved = await readJson(file);
  if (saved.schemaVersion !== 1 || !samePath(saved.configPath, configPath) || !samePath(saved.metadataPath, file)) throw new Error("The selected profile's deployment receipt has invalid ownership.");
  if (saved.status !== "active") throw new Error(`This profile has an incomplete deployment (${saved.id}). Roll it back explicitly before deploying or launching again.`);
  const root = await fs.realpath(saved.after.packageRoot);
  if ((await readJson(path.join(root, "package.json"))).name !== PACKAGE_NAME) throw new Error("Saved deployment is no longer an OMPweb package.");
  return root;
}
async function swapJunction(serviceRoot, expected, target, id) {
  const current = await inspectJunction(serviceRoot);
  if (!samePath(current.target, expected)) throw new Error("Global package junction changed since this deployment began; refusing to replace another owner's installation.");
  if (samePath(current.target, target)) return;
  const candidate = `${serviceRoot}.ui-next-${id}`;
  const previous = `${serviceRoot}.ui-previous-${id}`;
  await fs.symlink(target, candidate, "junction");
  let moved = false;
  try {
    await fs.rename(serviceRoot, previous);
    moved = true;
    try { await fs.rename(candidate, serviceRoot); }
    catch (error) { await fs.rename(previous, serviceRoot); moved = false; throw error; }
    await fs.rmdir(previous);
    moved = false;
  } finally {
    await fs.rmdir(candidate).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (moved) throw new Error(`Junction switched but old junction cleanup failed at ${previous}; retain the deployment receipt for rollback.`);
  }
}
async function profileIdentity(configPath, config) {
  const agentDir = path.dirname(configPath);
  const login = await readJson(path.join(agentDir, "omp-web", "host.json"));
  const registry = await readJson(path.join(agentDir, "omp-web", "hosts.json"));
  const hostname = config.hostname === "::1" ? "[::1]" : config.hostname ?? "127.0.0.1";
  const origin = `http://${hostname}:${config.port ?? 30177}`;
  const normalized = (value) => typeof value === "string" ? value.replace(/\/+$/, "") : "";
  if (typeof login.token !== "string" || !login.token || normalized(login.url) !== origin
    || !Array.isArray(registry.hosts) || !registry.hosts.some((host) => host.id === "local" && host.tokenHash === digest(login.token))
    || !(login.links ?? [login]).some((link) => normalized(link.url) === origin && link.token === login.token)) {
    throw new Error("The selected profile has no matching valid primary host link at the configured origin. Nothing will rotate or create a token.");
  }
  // Only identity, not changing lastSeenAt/labels. No token is persisted in receipts.
  return digest(JSON.stringify({ origin, tokenHash: digest(login.token) }));
}
async function assertIdentity(metadata, config) {
  if (await profileIdentity(metadata.configPath, config) !== metadata.primaryIdentity) throw new Error("Primary host link/token changed during deployment; it was not restored or overwritten.");
}

const SNAPSHOT_STARTUP = String.raw`
$links = @()
$wsh = New-Object -ComObject WScript.Shell
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$locations = @(
  @{ path = [Environment]::GetFolderPath('Desktop'); recursive = $false },
  @{ path = [Environment]::GetFolderPath('Programs'); recursive = $true },
  @{ path = [Environment]::GetFolderPath('Startup'); recursive = $false }
)
foreach ($location in $locations) {
  if (!$location.path -or !(Test-Path -LiteralPath $location.path)) { continue }
  $files = if ($location.recursive) { @(Get-ChildItem -LiteralPath $location.path -Filter '*.lnk' -File -Recurse -ErrorAction Stop) } else { @(Get-ChildItem -LiteralPath $location.path -Filter '*.lnk' -File -ErrorAction Stop) }
  foreach ($file in $files) {
    if (!$seen.Add($file.FullName)) { continue }
    $shortcut = $wsh.CreateShortcut($file.FullName)
    $target = [string]$shortcut.TargetPath
    $arguments = [string]$shortcut.Arguments
    $owned = $false
    foreach ($root in @($p.serviceRoot, $p.previousTarget)) {
      foreach ($relative in @('bin\omp-web-tray.exe', 'scripts\windows\launch-tray.vbs', 'scripts\windows\omp-web-tray.ps1', 'scripts\windows\omp-web-service.ps1')) {
        $launcher = Join-Path $root $relative
        if ((SamePath $target $launcher) -or (ContainsPath $arguments $launcher)) { $owned = $true }
      }
    }
    if (!$owned -or !(MatchesConfig $arguments)) { continue }
    $startup = (SamePath $file.DirectoryName ([Environment]::GetFolderPath('Startup'))) -or $arguments -match '(?i)(?:^|\s)-Startup(?:\s|$)'
    $links += @{ path = $file.FullName; bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName)); startup = [bool]$startup; openBrowser = [bool]($arguments -match '(?i)(?:^|\s)-OpenBrowser(?:\s|$)') }
  }
}
$xml = ExportWebTask
$taskSnapshot = $null
if ($xml) {
  [xml]$document = $xml
  $manager = New-Object System.Xml.XmlNamespaceManager($document.NameTable)
  $manager.AddNamespace('t', $document.DocumentElement.NamespaceURI)
  $actions = @($document.SelectNodes('/t:Task/t:Actions/t:Exec', $manager))
  $owned = $actions.Count -eq 1
  if ($owned) {
    $arguments = [string]$actions[0].Arguments
    $owned = (MatchesConfig $arguments)
    $launcherOwned = $false
    foreach ($root in @($p.serviceRoot, $p.previousTarget)) {
      foreach ($relative in @('bin\omp-web-tray.exe', 'scripts\windows\omp-web-service.ps1', 'scripts\windows\omp-web-tray.ps1', 'scripts\windows\launch-tray.vbs')) {
        $launcher = Join-Path $root $relative
        if ((SamePath ([string]$actions[0].Command) $launcher) -or (ContainsPath $arguments $launcher)) { $launcherOwned = $true }
      }
    }
    $owned = $owned -and $launcherOwned
  }
  if ($owned) { $taskSnapshot = @{ xml = $xml; enabled = [bool](Get-ScheduledTask -TaskName 'omp-web' -TaskPath '\').Settings.Enabled } }
}
@{ shortcuts = @($links); task = $taskSnapshot } | ConvertTo-Json -Depth 8 -Compress
`;
async function snapshotStartup(context) { return psJson(SNAPSHOT_STARTUP, context); }
async function pauseTask(metadata) {
  if (!metadata.before.startup.task) return;
  const xml = metadata.after.startup.taskXml || metadata.before.startup.task.xml;
  metadata.after.startup.taskXml = await powershell(String.raw`
$current = ExportWebTask
if ($current -cne $p.xml -and $current -cne $p.originalXml) { throw 'Web scheduled task changed after snapshot.' }
Disable-ScheduledTask -TaskName 'omp-web' -TaskPath '\' -ErrorAction Stop | Out-Null
[Console]::Write((ExportWebTask))
`, { xml, originalXml: metadata.before.startup.task.xml });
  await saveMetadata(metadata);
}
async function applyStartup(metadata) {
  // Persist each observed write independently, including failures partway through registration.
  for (const saved of metadata.before.startup.shortcuts) {
    const updated = await psJson(String.raw`
$bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p.saved.path))
if ($bytes -cne $p.saved.bytes) { throw 'A web shortcut changed after snapshot.' }
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($p.saved.path)
$sc.TargetPath = Join-Path $p.packageRoot 'bin\omp-web-tray.exe'
$prefix = if ($p.saved.startup) { '-Startup ' } elseif ($p.saved.openBrowser) { '-OpenBrowser ' } else { '' }
$sc.Arguments = $prefix + '-ConfigPath "' + $p.configPath + '"'
$sc.WorkingDirectory = $p.packageRoot
$sc.IconLocation = (Join-Path $p.packageRoot 'public\omp-web.ico') + ',0'
$sc.Save()
@{ path = $p.saved.path; bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p.saved.path)) } | ConvertTo-Json -Compress
`, { configPath: metadata.configPath, packageRoot: metadata.after.packageRoot, saved });
    metadata.after.startup.shortcuts.push(updated);
    await saveMetadata(metadata);
  }
  if (metadata.before.startup.task) {
    metadata.after.startup.taskXml = await powershell(String.raw`
if ((ExportWebTask) -cne $p.expectedXml) { throw 'Web task changed after it was paused.' }
$action = New-ScheduledTaskAction -Execute (Join-Path $p.packageRoot 'bin\omp-web-tray.exe') -Argument ('-Startup -ConfigPath "' + $p.configPath + '"') -WorkingDirectory $p.packageRoot
Set-ScheduledTask -TaskName 'omp-web' -TaskPath '\' -Action $action -ErrorAction Stop | Out-Null
[Console]::Write((ExportWebTask))
`, { configPath: metadata.configPath, packageRoot: metadata.after.packageRoot, expectedXml: metadata.after.startup.taskXml });
    await saveMetadata(metadata);
    if (metadata.before.startup.task.enabled) {
      metadata.after.startup.taskXml = await powershell(String.raw`
if ((ExportWebTask) -cne $p.expectedXml) { throw 'Web task changed before re-enabling autostart.' }
Enable-ScheduledTask -TaskName 'omp-web' -TaskPath '\' -ErrorAction Stop | Out-Null
[Console]::Write((ExportWebTask))
`, { expectedXml: metadata.after.startup.taskXml });
      await saveMetadata(metadata);
    }
  }
}
async function restoreStartup(metadata) {
  await powershell(String.raw`
foreach ($saved in @($p.before.shortcuts)) {
  $current = [Convert]::ToBase64String([IO.File]::ReadAllBytes($saved.path))
  $after = @($p.after.shortcuts | Where-Object { $_.path -ceq $saved.path })
  if ($current -ceq $saved.bytes) { continue }
  if ($after.Count -ne 1 -or $current -cne $after[0].bytes) { throw 'Web shortcut changed outside this deployment; refusing rollback overwrite.' }
  [IO.File]::WriteAllBytes($saved.path, [Convert]::FromBase64String($saved.bytes))
}
if ($p.before.task) {
  $current = ExportWebTask
  if ($current -cne $p.before.task.xml) {
    if (!$p.after.taskXml -or $current -cne $p.after.taskXml) { throw 'Web task changed outside this deployment; refusing rollback overwrite.' }
    Register-ScheduledTask -TaskName 'omp-web' -TaskPath '\' -Xml $p.before.task.xml -Force -ErrorAction Stop | Out-Null
  }
}
`, { before: metadata.before.startup, after: metadata.after.startup || { shortcuts: [], taskXml: null } });
}

async function tailscaleStatus() {
  try {
    const { stdout } = await exec("tailscale.exe", ["serve", "status", "--json"], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { throw new Error("Cannot read Tailscale Serve JSON status. No route was changed; ensure tailscale.exe is available and authorized."); }
}
function routeFromStatus(status, publicUrl) {
  const url = new URL(publicUrl);
  const endpoint = `${url.hostname}:${url.port || "443"}`;
  const handler = status.Web?.[endpoint]?.Handlers?.["/"];
  if (!handler || Object.keys(handler).length !== 1 || typeof handler.Proxy !== "string") {
    throw new Error(`The configured Tailscale UI root route ${endpoint}/ is not an existing proxy. Refusing to create or replace an unrelated route.`);
  }
  const target = new URL(handler.Proxy);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Existing Tailscale UI route is not a plain loopback HTTP proxy.");
  if (status.AllowFunnel?.[endpoint]) throw new Error("The configured UI route is publicly funneled; this automation only promotes trusted tailnet Serve routes.");
  const tcp = status.TCP?.[url.port || "443"];
  if (!tcp?.HTTPS || tcp.TCPForward || tcp.TerminateTLS) throw new Error("Configured Tailscale UI port is not an HTTPS web route.");
  return { publicUrl: url.origin, endpoint, port: Number(url.port || 443), target: handler.Proxy };
}
function otherRoutes(status, route) {
  const result = structuredClone(status);
  if (result.Web?.[route.endpoint]?.Handlers) {
    delete result.Web[route.endpoint].Handlers["/"];
    if (!Object.keys(result.Web[route.endpoint].Handlers).length) delete result.Web[route.endpoint];
  }
  return stableJson(result);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function setRoute(route, target, expected) {
  const before = await tailscaleStatus();
  if (routeFromStatus(before, route.publicUrl).target !== expected) throw new Error("Tailscale UI route changed after snapshot; refusing to replace another owner's route.");
  if (target === expected) return;
  try {
    await exec("tailscale.exe", ["serve", "--bg", "--yes", `--https=${route.port}`, "--set-path=/", target], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error("Tailscale UI route update failed; activation cannot be reported as successful."); }
  const after = await tailscaleStatus();
  if (routeFromStatus(after, route.publicUrl).target !== target || otherRoutes(before, route) !== otherRoutes(after, route)) throw new Error("Tailscale route verification failed; retain the private deployment receipt and inspect Serve status.");
}

async function healthHeaders(configPath) {
  const raw = await powershell(String.raw`
$value = [Environment]::GetEnvironmentVariable('OMP_WEB_PASSWORD_HASH', 'User')
if ([string]::IsNullOrWhiteSpace($value)) { $value = [Environment]::GetEnvironmentVariable('OMP_WEB_PASSWORD_HASH', 'Machine') }
if ([string]::IsNullOrWhiteSpace($value)) { $value = $env:OMP_WEB_PASSWORD_HASH }
[Console]::Write([string]$value)
`);
  if (!raw) return {};
  const secret = await readJson(path.join(path.dirname(configPath), "omp-web", "web-auth-secret.json"));
  if (typeof secret.key !== "string" || typeof secret.salt !== "string") throw new Error("Cannot authenticate health check with the existing web session secret.");
  const key = createHmac("sha256", Buffer.from(secret.key, "base64url")).update(`omp-web-session-v1\0${secret.salt}\0${raw.trim()}`).digest("base64url");
  const payload = `v1.${Date.now() + 120_000}.${randomBytes(16).toString("base64url")}`;
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return { cookie: `omp_web_session=${payload}.${signature}` };
}
async function requestJson(origin, resource, headers) {
  const response = await fetch(new URL(resource, origin), { headers, redirect: "error", signal: AbortSignal.timeout(3500), cache: "no-store" });
  if (!response.ok) throw new Error(`Health endpoint ${resource} returned HTTP ${response.status}.`);
  return response.json();
}
function localOrigin(config) { return `http://${config.hostname === "::1" ? "[::1]" : config.hostname}:${config.port}`; }
async function observeHealth(configPath, config, { ui = config.mode === "ui", remote = true, allowMain = false } = {}) {
  const headers = await healthHeaders(configPath);
  const origin = localOrigin(config);
  const hosts = await requestJson(origin, "/api/hosts", headers);
  if (!Array.isArray(hosts.hosts) || !hosts.hosts.some((host) => host.id === "local" && host.status === "online")) throw new Error("The primary local host is not online; the host daemon was not touched.");
  let sourceRoot;
  let channel;
  if (ui && allowMain) {
    const state = await requestJson(origin, "/api/app-channel", headers);
    if (state.supported === true && state.active?.channel === "main" && !state.restarting) channel = "main";
  }
  if (ui && channel !== "main") {
    const customization = await requestJson(origin, "/ui-customization.json", headers);
    if (customization.enabled !== true || !samePath(customization.sourceRoot, config.uiSource) || customization.lastError) throw new Error("Primary service is not serving a healthy UI customization snapshot from the configured source.");
    sourceRoot = customization.sourceRoot;
    channel = "fork";
  }
  if (ui && remote && config.uiPublicUrl) {
    if (channel === "main") {
      const state = await requestJson(config.uiPublicUrl, "/api/app-channel", headers);
      if (state.supported !== true || state.active?.channel !== "main" || state.restarting) throw new Error("Trusted remote origin is not serving the selected Main channel.");
    } else {
      const external = await requestJson(config.uiPublicUrl, "/ui-customization.json", headers);
      if (external.enabled !== true || !samePath(external.sourceRoot, config.uiSource) || external.lastError) throw new Error("Trusted remote origin is not serving this UI source.");
    }
    const externalHosts = await requestJson(config.uiPublicUrl, "/api/hosts", headers);
    if (!externalHosts.hosts?.some((host) => host.id === "local" && host.status === "online")) throw new Error("Trusted remote origin does not report the primary host online.");
  }
  return { healthy: true, origin, hostOnline: true, ...(channel ? { channel } : {}), ...(sourceRoot ? { sourceRoot } : {}), ...(ui && remote && config.uiPublicUrl ? { publicUrl: config.uiPublicUrl } : {}) };
}
async function waitHealthy(configPath, config, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  let last;
  do {
    try { return await observeHealth(configPath, config, options); } catch (error) { last = error; }
    if (Date.now() >= deadline) break;
    await sleep(1000);
  } while (true);
  throw new Error(`Web activation health check failed: ${last?.message || "unknown health failure"}`);
}
async function scopedStop(controllerRoot, serviceRoot, configPath) {
  const controller = path.join(controllerRoot, "scripts", "windows", "control-tray.ps1");
  const source = await fs.readFile(controller, "utf8");
  if (!/\[string\]\s*\$ServiceRoot\b/i.test(source)) throw new Error("Scoped controller is missing its -ServiceRoot extension; refusing to stop the old installation.");
  await powershell(String.raw`
& $p.controller -Action Stop -ConfigPath $p.configPath -ServiceRoot $p.serviceRoot
if (!$?) { throw 'Scoped web controller failed.' }
`, { controller, configPath, serviceRoot });
}
async function startNative(serviceRoot, configPath) {
  const exe = path.join(serviceRoot, "bin", "omp-web-tray.exe");
  await fs.access(exe);
  // No Mode/port override: every launch, shortcut and restart reads the same saved configuration.
  const child = spawn(exe, ["-ConfigPath", configPath], {
    cwd: serviceRoot, detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, PI_CODING_AGENT_DIR: path.dirname(configPath) },
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return child.pid;
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await powershell(String.raw`
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p.directory -AclObject $acl -ErrorAction Stop
`, { directory });
}
async function withLock(serviceRoot, action) {
  const lock = `${serviceRoot}.ui-service.lock`;
  let handle;
  try { handle = await fs.open(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another deployment owns ${lock}. If its process exited, explicitly remove that stale lock before retrying.`); throw error; }
  try { await handle.writeFile(json({ pid: process.pid, createdAt: new Date().toISOString() })); return await action(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
function receipt(metadata, extra = {}) {
  return { command: metadata.command || "deploy", deployment: metadata.id, status: metadata.status, configPath: metadata.configPath, serviceRoot: metadata.serviceRoot,
    packageRoot: metadata.after?.packageRoot, previousPackageRoot: metadata.before?.packageRoot, sourceRoot: metadata.sourceRoot,
    receiptPath: metadata.metadataPath, ...extra };
}
async function saveMetadata(metadata) { await atomicWrite(metadata.metadataPath, json(metadata)); }
async function deploymentFile(options, configPath) {
  const base = path.join(path.dirname(configPath), "omp-web", "ui-deployments");
  if (options.deployment) {
    if (/^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/.test(options.deployment)) return path.join(base, options.deployment, "deployment.json");
    throw new Error("--deployment must be a deployment ID from a receipt (not an arbitrary file path).");
  }
  const entries = await fs.readdir(base, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    if (!/^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/.test(entry.name)) continue;
    const file = path.join(base, entry.name, "deployment.json");
    const saved = await readJson(file);
    if (samePath(saved.configPath, configPath) && ["active", "activating", "rollback-failed"].includes(saved.status)) return file;
  }
  throw new Error("No active deployment receipt exists for this exact web-service configuration. Supply --deployment <id>.");
}
async function restoreDeployment(metadata, { automatic = false, timeoutMs } = {}) {
  if (metadata.status === "rolled-back") return receipt(metadata, { command: "rollback", packageRoot: metadata.before.packageRoot, alreadyRolledBack: true });
  const currentConfig = await fs.readFile(metadata.configPath);
  const oldConfig = Buffer.from(metadata.before.configBytes, "base64");
  const newConfig = Buffer.from(metadata.after.configBytes, "base64");
  if (!currentConfig.equals(oldConfig) && !currentConfig.equals(newConfig)) throw new Error("web-service.json changed outside this deployment; refusing rollback overwrite.");
  const junction = await inspectJunction(metadata.serviceRoot);
  if (!samePath(junction.target, metadata.after.packageRoot) && !samePath(junction.target, metadata.before.junctionTarget)) throw new Error("Global package belongs to another deployment; refusing rollback.");
  await assertIdentity(metadata, parsePrivateJson(oldConfig, metadata.configPath));
  // Check all ownership guards before stopping any currently running web tree.
  await powershell(String.raw`
foreach ($saved in @($p.before.shortcuts)) {
  $current = [Convert]::ToBase64String([IO.File]::ReadAllBytes($saved.path))
  $after = @($p.after.shortcuts | Where-Object { $_.path -ceq $saved.path })
  if ($current -cne $saved.bytes -and ($after.Count -ne 1 -or $current -cne $after[0].bytes)) { throw 'Shortcut is no longer owned by this deployment.' }
}
if ($p.before.task) {
  $current = ExportWebTask
  if ($current -cne $p.before.task.xml -and (!$p.after.taskXml -or $current -cne $p.after.taskXml)) { throw 'Scheduled task is no longer owned by this deployment.' }
}
`, { before: metadata.before.startup, after: metadata.after.startup || { shortcuts: [], taskXml: null } });
  if (metadata.before.route) {
    const target = routeFromStatus(await tailscaleStatus(), metadata.before.route.publicUrl).target;
    if (target !== metadata.before.route.target && target !== metadata.after.routeTarget) throw new Error("Tailscale UI route changed outside this deployment; refusing rollback.");
  }
  await pauseTask(metadata);
  if (metadata.webStopped || !samePath(junction.target, metadata.before.junctionTarget) || !currentConfig.equals(oldConfig)) {
    await scopedStop(metadata.controllerRoot, metadata.after.packageRoot, metadata.configPath);
  }
  if (!samePath(junction.target, metadata.before.junctionTarget)) await swapJunction(metadata.serviceRoot, junction.target, metadata.before.junctionTarget, `${metadata.id}-rollback`);
  if (!currentConfig.equals(oldConfig)) await atomicWrite(metadata.configPath, oldConfig);
  await restoreStartup(metadata);
  if (metadata.before.route) {
    const current = routeFromStatus(await tailscaleStatus(), metadata.before.route.publicUrl).target;
    await setRoute(metadata.before.route, metadata.before.route.target, current);
  }
  await startNative(metadata.before.packageRoot, metadata.configPath);
  const config = parsePrivateJson(oldConfig, metadata.configPath);
  config.hostname ??= "127.0.0.1";
  config.port ??= 30177;
  await waitHealthy(metadata.configPath, config, { timeoutMs, ui: config.mode === "ui", remote: Boolean(config.uiPublicUrl), allowMain: true });
  await assertIdentity(metadata, config);
  metadata.status = "rolled-back";
  metadata.rolledBackAt = new Date().toISOString();
  metadata.automaticRollback = automatic;
  await saveMetadata(metadata);
  return receipt(metadata, { command: "rollback", packageRoot: metadata.before.packageRoot, healthy: true, automatic });
}

async function deployUiService(options = {}) {
  windowsOnly();
  const configPath = path.resolve(options.configPath || defaultConfig());
  if (!samePath(configPath, defaultConfig()) && !options.serviceRoot) throw new Error("Deploying a custom --config requires an explicit --service-root junction; the global installation was not changed.");
  const { sourceRoot } = validateSource(path.resolve(options.sourceRoot || DEFAULT_SOURCE));
  const beforeBytes = await fs.readFile(configPath);
  const existing = parsePrivateJson(beforeBytes, configPath);
  const config = buildUiConfig(existing, { ...options, sourceRoot });
  const primaryIdentity = await profileIdentity(configPath, config);
  const serviceRoot = await resolveServiceRoot(options);
  const junction = await inspectJunction(serviceRoot);
  const previousRoot = await savedPackageRoot(configPath, junction);
  const packageInfo = await readJson(path.join(junction.target, "package.json"));
  if (packageInfo.name !== PACKAGE_NAME) throw new Error("Global junction is not the existing OMPweb package.");
  const controllerRoot = sourceRoot;
  const controller = await fs.readFile(path.join(controllerRoot, "scripts", "windows", "control-tray.ps1"), "utf8");
  if (!/\[string\]\s*\$ServiceRoot\b/i.test(controller)) throw new Error("Scoped controller requires the optional -ServiceRoot extension before promotion.");
  const startup = await snapshotStartup({ configPath, serviceRoot, previousTarget: previousRoot });
  const route = config.uiPublicUrl ? routeFromStatus(await tailscaleStatus(), config.uiPublicUrl) : null;
  const routeTarget = route ? `http://127.0.0.1:${config.uiProxyPort}` : null;
  if (route && config.hostname === "::1") throw new Error("Tailscale Serve requires IPv4 loopback ingress, but this profile binds IPv6-only. Bind settings were not changed.");
  const plan = { command: "deploy", dryRun: true, configPath, sourceRoot, serviceRoot, previousPackageRoot: previousRoot, previousJunctionTarget: junction.target, mode: "ui", hostname: config.hostname, port: config.port,
    ...(route ? { publicUrl: config.uiPublicUrl, proxyPort: config.uiProxyPort, routeTarget } : {}), shortcuts: startup.shortcuts.map((item) => item.path), webTask: Boolean(startup.task), verify: Boolean(options.verify) };
  // Do not stage, create locks/directories/receipts, change ACLs, launch, or alter routes in dry-run.
  if (options.dryRun) return plan;
  return withLock(serviceRoot, async () => {
    const staged = await stageRelease({ sourceRoot, installBase: options.installBase, verify: Boolean(options.verify), logger: options.logger });
    if (!staged?.packageRoot || !samePath(staged.sourceRoot, sourceRoot)) throw new Error("Release staging returned an incompatible source/package receipt.");
    const stagedRoot = await fs.realpath(staged.packageRoot);
    await fs.access(path.join(stagedRoot, "bin", "omp-web-tray.exe"));
    if (!(await fs.readFile(configPath)).equals(beforeBytes)) throw new Error("web-service.json changed while staging; no live settings were replaced.");
    await assertIdentity({ configPath, primaryIdentity }, config);
    const current = await inspectJunction(serviceRoot);
    if (!samePath(current.target, junction.target)) throw new Error("Global junction changed while staging; no live package was replaced.");
    if (samePath(junction.target, stagedRoot) && samePath(previousRoot, stagedRoot) && stableJson(config) === stableJson(existing)) {
      try {
        const health = await observeHealth(configPath, config, { allowMain: true });
        return { command: "deploy", status: "already-active", configPath, serviceRoot, packageRoot: stagedRoot, sourceRoot, ...health };
      } catch {
        // Matching files are not proof of a running service. Explicit deploy still activates them.
      }
    }
    const id = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(6).toString("hex")}`;
    const directory = path.join(path.dirname(configPath), "omp-web", "ui-deployments", id);
    await privateDirectory(directory);
    const metadata = { schemaVersion: 1, id, command: "deploy", status: "activating", createdAt: new Date().toISOString(), configPath, serviceRoot, sourceRoot, controllerRoot, primaryIdentity,
      metadataPath: path.join(directory, "deployment.json"),
      before: { packageRoot: previousRoot, junctionTarget: junction.target, configBytes: beforeBytes.toString("base64"), startup, route },
      after: { packageRoot: stagedRoot, configBytes: Buffer.from(json(config)).toString("base64"), startup: { shortcuts: [], taskXml: null }, routeTarget },
      release: { version: staged.version, artifactHash: staged.artifactHash, manifestPath: staged.manifestPath } };
    await saveMetadata(metadata);
    let liveChanges = false;
    try {
      // Recheck registration ownership after a potentially long build, before touching live state.
      const freshStartup = await snapshotStartup({ configPath, serviceRoot, previousTarget: previousRoot });
      if (stableJson(freshStartup) !== stableJson(startup)) throw new Error("Web startup registration changed while staging; promotion was aborted.");
      liveChanges = true;
      await pauseTask(metadata);
      await scopedStop(controllerRoot, previousRoot, configPath);
      metadata.webStopped = true;
      await saveMetadata(metadata);
      await swapJunction(serviceRoot, junction.target, stagedRoot, id);
      await atomicWrite(configPath, Buffer.from(metadata.after.configBytes, "base64"));
      await applyStartup(metadata);
      await saveMetadata(metadata);
      await startNative(stagedRoot, configPath);
      await waitHealthy(configPath, config, { timeoutMs: options.timeoutMs, remote: false });
      if (route) await setRoute(route, routeTarget, route.target);
      const health = await waitHealthy(configPath, config, { timeoutMs: options.timeoutMs });
      await assertIdentity(metadata, config);
      metadata.status = "active";
      metadata.activatedAt = new Date().toISOString();
      await saveMetadata(metadata);
      return receipt(metadata, { ...health, version: staged.version, artifactHash: staged.artifactHash });
    } catch (error) {
      metadata.failure = "Web activation failed; private process diagnostics are available only to the caller through the error cause.";
      if (!liveChanges) { metadata.status = "aborted"; await saveMetadata(metadata); throw error; }
      try {
        const restored = await restoreDeployment(metadata, { automatic: true, timeoutMs: options.timeoutMs });
        const failure = new Error(`UI activation failed: ${error.message} Previous web deployment was restored. Receipt: ${metadata.metadataPath}`, { cause: error });
        failure.receipt = restored;
        throw failure;
      } catch (rollbackError) {
        if (metadata.status === "rolled-back") throw rollbackError;
        metadata.status = "rollback-failed";
        await saveMetadata(metadata);
        const failure = new Error(`UI activation failed: ${error.message} Automatic rollback also failed: ${rollbackError.message} Use rollback --deployment ${id} after resolving the guard/permission failure. Private receipt: ${metadata.metadataPath}`, { cause: error });
        failure.receipt = receipt(metadata);
        throw failure;
      }
    }
  });
}
async function statusUiService(options = {}) {
  windowsOnly();
  const configPath = path.resolve(options.configPath || defaultConfig());
  const config = await readJson(configPath);
  config.hostname ??= "127.0.0.1";
  config.port ??= 30177;
  const serviceRoot = await resolveServiceRoot(options);
  const junction = await inspectJunction(serviceRoot);
  const packageRoot = await savedPackageRoot(configPath, junction);
  const result = { command: "status", configPath, serviceRoot, packageRoot, junctionTarget: junction.target, mode: config.mode || "start", hostname: config.hostname, port: config.port,
    ...(config.mode === "ui" ? { sourceRoot: config.uiSource, publicUrl: config.uiPublicUrl } : {}) };
  try { return { ...result, status: "running", ...await observeHealth(configPath, config, { allowMain: true }) }; }
  catch (error) { return { ...result, status: "not-healthy", healthy: false, error: error.message }; }
}
async function launchUiService(options = {}) {
  windowsOnly();
  const configPath = path.resolve(options.configPath || defaultConfig());
  const saved = await readJson(configPath);
  if (saved.mode !== "ui") throw new Error("Saved service mode is not ui. Run deploy explicitly; launch does not build, stage, or change configuration.");
  if (typeof saved.uiSource !== "string" || !path.isAbsolute(saved.uiSource)) throw new Error("Saved UI configuration requires an absolute uiSource checkout path.");
  const config = buildUiConfig(saved, { sourceRoot: saved.uiSource });
  await profileIdentity(configPath, config);
  const serviceRoot = await resolveServiceRoot(options);
  const junction = await inspectJunction(serviceRoot);
  const packageRoot = await savedPackageRoot(configPath, junction);
  try {
    const health = await observeHealth(configPath, config, { allowMain: true });
    return { command: "launch", status: "already-running", configPath, serviceRoot, packageRoot, ...health };
  } catch { /* The native config-keyed mutex prevents a duplicate supervisor even during startup. */ }
  if (options.dryRun) return { command: "launch", dryRun: true, configPath, serviceRoot, packageRoot, executable: path.join(packageRoot, "bin", "omp-web-tray.exe"), arguments: ["-ConfigPath", configPath] };
  const pid = await startNative(packageRoot, configPath);
  const health = await waitHealthy(configPath, config, { timeoutMs: options.timeoutMs, allowMain: true });
  return { command: "launch", status: "running", configPath, serviceRoot, packageRoot, pid, ...health };
}
async function rollbackUiService(options = {}) {
  windowsOnly();
  const configPath = path.resolve(options.configPath || defaultConfig());
  const file = await deploymentFile(options, configPath);
  const metadata = await readJson(file);
  if (metadata.schemaVersion !== 1 || !samePath(metadata.configPath, configPath) || !samePath(metadata.metadataPath, file)) throw new Error("Deployment receipt does not belong to this exact configuration/path.");
  if (options.dryRun) return receipt(metadata, { command: "rollback", dryRun: true, restorePackageRoot: metadata.before.packageRoot, shortcuts: metadata.before.startup.shortcuts.map((item) => item.path), webTask: Boolean(metadata.before.startup.task), publicUrl: metadata.before.route?.publicUrl });
  return withLock(metadata.serviceRoot, () => restoreDeployment(metadata, { timeoutMs: options.timeoutMs }));
}
async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    source: { type: "string" }, config: { type: "string" }, "service-root": { type: "string" }, "public-url": { type: "string" }, "proxy-port": { type: "string" },
    "install-base": { type: "string" }, deployment: { type: "string" }, verify: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || !positionals.length) {
    process.stdout.write("Usage: node scripts/windows/ui-service.cjs <deploy|launch|status|rollback> [--config <web-service.json>] [--dry-run]\nDeploy: [--source <checkout>] [--public-url <https-origin>] [--proxy-port <port>] [--install-base <directory>] [--verify]\nDeploy/launch/status: [--service-root <package-junction>] (required for custom-config deploy)\nRollback: [--deployment <receipt-id>] (default: newest active deployment for this config)\nLaunch/status never build or change saved settings. Host daemons/tasks/tokens are never managed.\n");
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !["deploy", "launch", "status", "rollback"].includes(command)) throw new Error("Expected exactly one command: deploy, launch, status, or rollback.");
  const deployOnly = ["source", "public-url", "proxy-port", "install-base", "verify"];
  if (command !== "deploy" && deployOnly.some((name) => values[name] !== undefined)) throw new Error("--source, --public-url, --proxy-port, --install-base and --verify apply only to deploy.");
  if (command !== "rollback" && values.deployment !== undefined) throw new Error("--deployment applies only to rollback.");
  if (command === "rollback" && values["service-root"] !== undefined) throw new Error("Rollback uses the service root recorded in its deployment receipt.");
  if (values["proxy-port"] !== undefined && !/^\d+$/.test(values["proxy-port"])) throw new Error("--proxy-port must be an integer from 1 to 65535.");
  const options = { sourceRoot: values.source, configPath: values.config, serviceRoot: values["service-root"], publicUrl: values["public-url"], proxyPort: values["proxy-port"] === undefined ? undefined : Number(values["proxy-port"]),
    installBase: values["install-base"], deployment: values.deployment, verify: values.verify, dryRun: values["dry-run"], logger: (line) => process.stderr.write(String(line) + "\n") };
  const action = { deploy: deployUiService, launch: launchUiService, status: statusUiService, rollback: rollbackUiService }[command];
  const result = await action(options);
  process.stdout.write(json(result));
  if (result.healthy === false) process.exitCode = 1;
  return result;
}
module.exports = { deployUiService, launchUiService, statusUiService, rollbackUiService, buildUiConfig, routeFromStatus, otherRoutes, samePath, main };
if (require.main === module) main().catch((error) => { process.stderr.write(json({ error: error.message, ...(error.receipt ? { receipt: error.receipt } : {}) })); process.exitCode = 1; });
