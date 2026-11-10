#Requires -Version 5.1
<#
.SYNOPSIS
    Stops or restarts only this installation's web supervisor for an exact config.
.PARAMETER Delay
    Wait one second so an API caller can return before its web subtree is stopped.
.PARAMETER ServiceRoot
    Existing package root to control. Defaults to this controller's package.
    Pass a legacy logical junction root before changing that junction.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('Stop', 'Restart')][string]$Action,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [switch]$Delay,
    [string]$ServiceRoot = ""
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
if (![string]::IsNullOrWhiteSpace($ServiceRoot)) {
    if ($ServiceRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') { throw 'ServiceRoot must be an absolute existing package root.' }
    # Keep the explicitly supplied logical spelling while the junction still
    # points to the old package. Do not silently substitute this staged package.
    $RepoRoot = [System.IO.Path]::GetFullPath($ServiceRoot).TrimEnd([char[]]'\/')
}
if (!(Test-Path -LiteralPath $RepoRoot -PathType Container) -or !(Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json') -PathType Leaf)) {
    throw "ServiceRoot is not an existing package root: $RepoRoot"
}
. (Join-Path $PSScriptRoot 'web-service-ui.ps1')
if (![System.IO.Path]::IsPathRooted($ConfigPath) -or $ConfigPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') {
    throw 'ConfigPath must be an absolute path to the exact web-service JSON file.'
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$NativeExe = Join-Path $RepoRoot 'bin\omp-web-tray.exe'
$TrayScript = Join-Path $RepoRoot 'scripts\windows\omp-web-tray.ps1'
$ServiceScript = Join-Path $RepoRoot 'scripts\windows\omp-web-service.ps1'

# Validate a restart before stopping anything. The launchers still read the saved
# settings themselves; do not override mode/bind/port with an old API snapshot.
if ($Action -eq 'Restart') {
    if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Configuration does not exist: $ConfigPath" }
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $mode = if ($config.mode) { [string]$config.mode } else { 'start' }
    if ($mode -cnotin @('start', 'dev', 'ui')) { throw "Unsupported web service mode '$mode'." }
    if ($mode -eq 'ui') {
        $hostname = if ($config.hostname) { [string]$config.hostname } else { '127.0.0.1' }
        $port = if ($config.port) { [int]$config.port } else { 30177 }
        $null = Resolve-WebServiceUiConfig $config $hostname $port
    }
    if (!(Test-Path -LiteralPath $NativeExe -PathType Leaf) -and !(Test-Path -LiteralPath $ServiceScript -PathType Leaf)) {
        throw 'Neither the native tray executable nor the headless web service is available.'
    }
}

if ($Delay) { Start-Sleep -Seconds 1 }

# Terminate an opened process handle only after comparing its creation identity.
# PID reuse between a CIM snapshot and termination must not kill another process.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OmpWebScopedControl {
    [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr file, System.Text.StringBuilder path, uint capacity, uint flags);
    public static string FinalPath(string path) {
        IntPtr handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle == new IntPtr(-1)) return null;
        try {
            var result = new System.Text.StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
            return length > 0 && length < result.Capacity ? result.ToString() : null;
        } finally { CloseHandle(handle); }
    }
    public static string[] Arguments(string command) {
        int count;
        IntPtr pointer = CommandLineToArgvW(command, out count);
        if (pointer == IntPtr.Zero) throw new Win32Exception();
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
            return result;
        } finally { LocalFree(pointer); }
    }
    public static long Identity(int pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return 0;
        try {
            long creation, exit, kernel, user;
            uint code;
            if (!GetExitCodeProcess(handle, out code) || code != 259) return 0;
            return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation : 0;
        } finally { CloseHandle(handle); }
    }
    public static void Stop(int pid, long expected) {
        IntPtr handle = OpenProcess(0x1001, false, pid);
        if (handle == IntPtr.Zero) {
            if (Identity(pid) == expected) throw new Win32Exception(Marshal.GetLastWin32Error());
            return;
        }
        try {
            long creation, exit, kernel, user;
            uint code;
            if (GetExitCodeProcess(handle, out code) && code != 259) return;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception();
            if (creation == expected && !TerminateProcess(handle, 0)) throw new Win32Exception();
        } finally { CloseHandle(handle); }
    }
}
'@

function Same-Path([string]$left, [string]$right) {
    if ([string]::IsNullOrWhiteSpace($left) -or [string]::IsNullOrWhiteSpace($right)) { return $false }
    try { return [string]::Equals([System.IO.Path]::GetFullPath($left), [System.IO.Path]::GetFullPath($right), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}
function Same-PackagePath([string]$left, [string]$right) {
    if ($left -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') { return $false }
    if (Same-Path $left $right) { return $true }
    if ([string]::IsNullOrWhiteSpace($left) -or [string]::IsNullOrWhiteSpace($right)) { return $false }
    # Resolve only supervisor files, never ConfigPath: a physical and logical
    # package alias may be identical while configurations must remain exact.
    $leftFinal = [OmpWebScopedControl]::FinalPath($left)
    $rightFinal = [OmpWebScopedControl]::FinalPath($right)
    return $leftFinal -and $rightFinal -and [string]::Equals($leftFinal, $rightFinal, [StringComparison]::OrdinalIgnoreCase)
}
function Same-ConfigPath([string]$candidate) {
    # A process's relative path is relative to its own (unavailable) cwd, not
    # this controller's cwd. Do not guess which JSON file it means.
    return $candidate -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])' -and (Same-Path $candidate $ConfigPath)
}

$CallerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try { $Profile = Get-CimInstance Win32_UserProfile -Filter "SID='$CallerSid'" -OperationTimeoutSec 3 | Select-Object -First 1 } catch { $Profile = $null }
$DefaultConfig = if ($Profile -and $Profile.LocalPath) { Join-Path $Profile.LocalPath '.omp\agent\web-service.json' } else { $null }
$AllowImplicitDefault = $DefaultConfig -and (Same-Path $ConfigPath $DefaultConfig) -and (Same-Path $env:USERPROFILE $Profile.LocalPath) -and (Same-Path ([Environment]::GetFolderPath('UserProfile')) $Profile.LocalPath)

function Is-MatchingSupervisor($process) {
    if ($process.ProcessId -eq $PID -or !$process.CommandLine) { return $false }
    $argv = [OmpWebScopedControl]::Arguments($process.CommandLine)
    if ($argv.Length -lt 1) { return $false }
    $native = $process.Name -ieq 'omp-web-tray.exe' -and (Same-PackagePath $process.ExecutablePath $NativeExe)
    $scriptIndex = -1
    if (!$native) {
        if ($process.Name -inotmatch '^(?:powershell|pwsh)\.exe$') { return $false }
        for ($index = 1; $index -lt $argv.Length - 1; $index++) {
            if ($argv[$index] -ieq '-File') { $scriptIndex = $index + 1; break }
        }
        if ($scriptIndex -lt 0 -or (!(Same-PackagePath $argv[$scriptIndex] $TrayScript) -and !(Same-PackagePath $argv[$scriptIndex] $ServiceScript))) { return $false }
    }
    $foundConfig = $false
    $configMatches = $false
    $start = if ($native) { 1 } else { $scriptIndex + 1 }
    for ($index = $start; $index -lt $argv.Length; $index++) {
        # Native Program.cs accepts precisely -ConfigPath; PowerShell names are
        # case-insensitive and also accept -ConfigPath:<value>.
        if ($native -and $argv[$index] -ceq '-ConfigPath') {
            $foundConfig = $true
            $configMatches = $index + 1 -lt $argv.Length -and (Same-ConfigPath $argv[$index + 1])
            $index++
        } elseif (!$native -and $argv[$index] -imatch '^-(C|Co|Con|Conf|Confi|Config|ConfigP|ConfigPa|ConfigPat|ConfigPath)(?::(.*))?$') {
            # PowerShell permits unique abbreviated parameter names. Treat an
            # explicit relative/unknown config as non-matching, never default.
            $foundConfig = $true
            if ($argv[$index].Contains(':')) {
                $configMatches = Same-ConfigPath $Matches[2]
            } else {
                $configMatches = $index + 1 -lt $argv.Length -and (Same-ConfigPath $argv[$index + 1])
                $index++
            }
        }
    }
    if ($foundConfig) { return $configMatches }
    if (!$AllowImplicitDefault) { return $false }
    # Native uses the account's Windows SpecialFolder. PowerShell defaults from
    # USERPROFILE, which may have been overridden per process and is not exposed
    # by CIM. Refuse an unprovable legacy default rather than stop another config.
    if (!$native) { throw "Implicit PowerShell web supervisor PID $($process.ProcessId) has no explicit ConfigPath; its default cannot be proven. Restart it with an explicit ConfigPath before scoped control." }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -OperationTimeoutSec 3
    return $owner.ReturnValue -eq 0 -and $owner.Sid -eq $CallerSid
}

function Is-ProtectedHost($process) {
    # Protection is deliberately conservative. Never traverse a host supervisor,
    # the daemon itself, or the native OMP processes below it, even if inherited
    # parent IDs happen to place that host beneath a web supervisor.
    return $process.CommandLine -match '(?i)(?:omp-web-host\.(?:ps1|js)|(?:omp-web\.js|ompweb(?:\.exe)?)"?\s+host(?:\s|$))' -or $process.Name -imatch '^(?:omp|pi)\.exe$'
}

$watch = [Diagnostics.Stopwatch]::StartNew()
$snapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3)
$roots = @($snapshot | Where-Object { Is-MatchingSupervisor $_ })
$rootIds = @{}
foreach ($process in $roots) { $rootIds[[int]$process.ProcessId] = $true }
$owned = @{}
$protected = @{}
foreach ($process in $snapshot) {
    if ($process.ProcessId -eq $PID -or (Is-ProtectedHost $process)) { $protected[[int]$process.ProcessId] = $true }
}
# Expand protection before collecting any owned descendants.
for ($round = 0; $round -lt $snapshot.Count; $round++) {
    $changed = $false
    foreach ($process in $snapshot) {
        # A web service launched by an OMP tool remains a web service. Its
        # exact config/package boundary must not inherit the tool's protection;
        # native OMP/host descendants inside it are still protected separately.
        if ($rootIds.ContainsKey([int]$process.ProcessId)) { continue }
        if ($protected.ContainsKey([int]$process.ParentProcessId) -and !$protected.ContainsKey([int]$process.ProcessId)) {
            $protected[[int]$process.ProcessId] = $true
            $changed = $true
        }
    }
    if (!$changed) { break }
}
function Remember-Process($process) {
    $identity = [OmpWebScopedControl]::Identity([int]$process.ProcessId)
    if ($identity -eq 0) {
        if (!(Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -OperationTimeoutSec 3)) { return }
        throw "Cannot establish process identity for PID $($process.ProcessId); refusing an unscoped stop."
    }
    if (!$process.CreationDate -or [DateTime]::FromFileTimeUtc($identity).ToString('yyyyMMddHHmmssffffff') -ne $process.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) {
        throw "PID $($process.ProcessId) changed since discovery; refusing to stop it."
    }
    $owned[[int]$process.ProcessId] = @{ Process = $process; Identity = $identity; StopBefore = $null }
}
foreach ($process in $roots) { if (!$protected.ContainsKey([int]$process.ProcessId)) { Remember-Process $process } }
function Remember-Descendants($processes) {
    for ($round = 0; $round -lt $processes.Count; $round++) {
        $changed = $false
        foreach ($process in $processes) {
            $id = [int]$process.ProcessId
            $parentId = [int]$process.ParentProcessId
            if ($owned.ContainsKey($id) -or $protected.ContainsKey($id) -or !$owned.ContainsKey($parentId) -or (Is-ProtectedHost $process)) { continue }
            $parent = $owned[$parentId]
            if ($process.CreationDate -lt $parent.Process.CreationDate) { continue }
            # A recycled parent PID is not proof of ownership.
            $currentParent = [OmpWebScopedControl]::Identity($parentId)
            if ($currentParent -ne 0 -and $currentParent -ne $parent.Identity) { continue }
            if ($currentParent -eq 0 -and $parent.StopBefore -and $process.CreationDate.ToUniversalTime() -gt $parent.StopBefore) { continue }
            Remember-Process $process
            $changed = $true
        }
        if (!$changed) { break }
        if ($watch.Elapsed.TotalSeconds -gt 12) { throw 'Scoped web service stop exceeded its deadline.' }
    }
}
Remember-Descendants $snapshot
# Stop supervisors first so they cannot respawn a web child during shutdown.
foreach ($process in $roots) {
    $id = [int]$process.ProcessId
    if ($owned.ContainsKey($id)) {
        $owned[$id].StopBefore = [DateTime]::UtcNow
        [OmpWebScopedControl]::Stop($id, $owned[$id].Identity)
    }
}
# Capture any web children created just before their supervisor was terminated.
for ($pass = 0; $pass -lt 2 -and $owned.Count -gt 0; $pass++) {
    Remember-Descendants @(Get-CimInstance Win32_Process -OperationTimeoutSec 3)
    foreach ($id in @($owned.Keys)) {
        if (!$owned[$id].StopBefore) { $owned[$id].StopBefore = [DateTime]::UtcNow }
        [OmpWebScopedControl]::Stop($id, $owned[$id].Identity)
    }
    Start-Sleep -Milliseconds 100
}
$exitDeadline = [DateTime]::UtcNow.AddSeconds(3)
do {
    $remaining = @($owned.Keys | Where-Object { [OmpWebScopedControl]::Identity($_) -eq $owned[$_].Identity })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $exitDeadline)
if ($remaining.Count -gt 0) { throw "Owned web process(es) did not stop: $($remaining -join ', '); restart refused." }

if ($Action -eq 'Restart') {
    # Wait a bounded interval for this configuration's old mutex ownership.
    $handoff = $null
    try { $handoff = [Threading.Mutex]::OpenExisting((Get-WebServiceMutexName $ConfigPath)) } catch [Threading.WaitHandleCannotBeOpenedException] { }
    if ($handoff) {
        $acquired = $false
        try {
            try { $acquired = $handoff.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
            if (!$acquired) { throw 'The exact web service configuration is still owned; restart refused.' }
        } finally {
            if ($acquired) { $handoff.ReleaseMutex() }
            $handoff.Dispose()
        }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $RepoRoot
    if (Test-Path -LiteralPath $NativeExe -PathType Leaf) {
        $psi.FileName = $NativeExe
        $psi.Arguments = '-ConfigPath "' + $ConfigPath + '"'
    } else {
        $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $psi.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ServiceScript + '" -ConfigPath "' + $ConfigPath + '"'
    }
    $child = [Diagnostics.Process]::Start($psi)
    if (!$child) { throw 'Failed to launch the web service supervisor.' }
    Write-Output "Restart launched for $ConfigPath (PID $($child.Id))."
    $child.Dispose()
} else {
    Write-Output "Stopped $($roots.Count) matching web supervisor(s) for $ConfigPath."
}
