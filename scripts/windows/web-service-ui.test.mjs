import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL("./web-service-ui.ps1", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };
const psString = (value) => `'${value.replaceAll("'", "''")}'`;

async function powershell(script) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return execFileAsync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `$ErrorActionPreference = 'Stop'; . ${psString(helperPath)}; ${script}`,
  ], { windowsHide: true, timeout: 15_000 });
}

async function sourceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-ui-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Spaces, percent signs, ampersands and non-ASCII characters are literal paths,
  // not cmd expansions or an excuse to lose persisted uiSource characters.
  const source = path.join(root, "source %PATH% & GUI é");
  for (const file of ["package.json", "bin/omp-web-ui.js", "server/ui.ts", "app/client.tsx"]) {
    const destination = path.join(source, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file === "package.json" ? "{}\n" : "");
  }
  return { root, source };
}

test("Windows UI service validates source and optional ingress settings without a dev fallback", windowsOnly, async (t) => {
  const { source } = await sourceFixture(t);
  const { stdout } = await powershell(`
    $config = [PSCustomObject]@{ uiSource = ${psString(source)}; uiPublicUrl = 'https://gui.example:8445'; uiProxyPort = 30179 }
    $settings = Resolve-WebServiceUiConfig $config '127.0.0.1' 30177
    $plain = Resolve-WebServiceUiConfig ([PSCustomObject]@{ uiSource = ${psString(source)} }) '127.0.0.1' 30177
    if ($null -ne $plain.PublicUrl -or $null -ne $plain.ProxyPort) { throw 'Optional settings were invented' }
    $configPath = Join-Path ${psString(source)} 'web-service.json'
    $mutex = Get-WebServiceMutexName $configPath
    if ($mutex -ne (Get-WebServiceMutexName ($configPath.ToUpperInvariant()))) { throw 'Mutex is not canonical' }
    if ($mutex -eq (Get-WebServiceMutexName (Join-Path ${psString(source)} 'isolated.json'))) { throw 'Configurations share a mutex' }
    if ($settings.Source -ne ${psString(source)} -or $settings.PublicUrl -ne 'https://gui.example:8445' -or $settings.ProxyPort -ne 30179) { throw 'Settings changed' }
    foreach ($invalid in @('', 'relative\\checkout', ${psString(path.join(source, "missing"))})) {
      $bad = [PSCustomObject]@{ uiSource = $invalid }
      $rejected = $false
      try { $null = Resolve-WebServiceUiConfig $bad '127.0.0.1' 30177 } catch { $rejected = $_.Exception.Message -like '*uiSource*' }
      if (!$rejected) { throw "Invalid uiSource was accepted: $invalid" }
    }
    foreach ($invalid in @('http://gui.example', 'https://gui.example/path', 'https://user:secret@gui.example', 'https://gui.example?query=1')) {
      $config.uiPublicUrl = $invalid
      $rejected = $false
      try { $null = Resolve-WebServiceUiConfig $config '127.0.0.1' 30177 } catch { $rejected = $_.Exception.Message -like '*uiPublicUrl*' }
      if (!$rejected) { throw 'Invalid public URL was accepted' }
    }
    $config.uiPublicUrl = 'https://gui.example'
    foreach ($invalid in @('30179', 0, 65536, 30177)) {
      $config.uiProxyPort = $invalid
      $rejected = $false
      try { $null = Resolve-WebServiceUiConfig $config '127.0.0.1' 30177 } catch { $rejected = $_.Exception.Message -like '*uiProxyPort*' }
      if (!$rejected) { throw 'Invalid proxy port was accepted' }
    }
    Write-Output 'validated'
  `);
  assert.match(stdout, /validated/);
});
