#Requires -Version 5.1
# Shared by the native-tray fallback and scheduled-task web supervisors.
function Get-WebServiceMutexName([string]$configPath) {
    $canonical = [System.IO.Path]::GetFullPath($configPath).Replace('/', '\').ToUpperInvariant()
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '') } finally { $hash.Dispose() }
    return "Local\OmpWebService_$key"
}

function Resolve-WebServiceUiConfig($Config, [string]$hostname, [int]$port) {
    if ($hostname -notin @('127.0.0.1', 'localhost', '::1')) { throw 'UI mode requires a loopback hostname.' }
    if ($port -lt 1 -or $port -gt 65535) { throw 'UI mode requires a web service port from 1 to 65535.' }
    $source = if ($Config) { $Config.uiSource } else { $null }
    if ($source -isnot [string] -or [string]::IsNullOrWhiteSpace($source) -or $source -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])') {
        throw 'UI mode requires uiSource to be an absolute full source checkout path in web-service.json.'
    }
    $source = [System.IO.Path]::GetFullPath($source).TrimEnd([char[]]'\/')
    foreach ($relative in @('package.json', 'bin\omp-web-ui.js', 'server\ui.ts', 'app\client.tsx')) {
        if (!(Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
            throw "UI mode uiSource is not a full source checkout: missing $relative under $source."
        }
    }
    $publicUrl = $null
    if ($Config -and $null -ne $Config.uiPublicUrl) {
        $uri = $null
        if ($Config.uiPublicUrl -isnot [string] -or ![Uri]::TryCreate($Config.uiPublicUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $Config.uiPublicUrl -match '[\s"<>]') {
            throw 'UI mode uiPublicUrl must be a trusted HTTPS origin without credentials, path, query or fragment.'
        }
        $publicUrl = $uri.GetLeftPart([UriPartial]::Authority)
    }
    $proxyPort = $null
    if ($Config -and $null -ne $Config.uiProxyPort) {
        if ($Config.uiProxyPort -isnot [int] -and $Config.uiProxyPort -isnot [long]) {
            throw 'UI mode uiProxyPort must be an integer from 1 to 65535.'
        }
        if ($Config.uiProxyPort -lt 1 -or $Config.uiProxyPort -gt 65535) {
            throw 'UI mode uiProxyPort must be an integer from 1 to 65535.'
        }
        $proxyPort = [int]$Config.uiProxyPort
        if ($proxyPort -eq $port) { throw 'UI mode uiProxyPort must differ from the web service port.' }
    }
    return @{ Source = $source; PublicUrl = $publicUrl; ProxyPort = $proxyPort }
}

function Set-WebServiceUiCommand($psi, $settings, [string]$nodeExe, [string]$serviceRoot, [string]$hostname, [int]$port, [string]$configPath) {
    $psi.WorkingDirectory = $settings.Source
    $psi.EnvironmentVariables['OMP_WEB_SERVICE_ROOT'] = $serviceRoot
    $configPath = [System.IO.Path]::GetFullPath($configPath)
    $psi.EnvironmentVariables['OMP_WEB_SERVICE_CONFIG_PATH'] = $configPath
    $psi.EnvironmentVariables['PI_CODING_AGENT_DIR'] = [System.IO.Path]::GetDirectoryName($configPath)
    # cmd expands these once, inside quotes. Literal percent signs and shell
    # metacharacters in a checkout path must not become another command.
    $psi.EnvironmentVariables['OMP_WEB_UI_NODE'] = $nodeExe
    $psi.EnvironmentVariables['OMP_WEB_UI_RUNNER'] = Join-Path $settings.Source 'bin\omp-web-ui.js'
    $psi.EnvironmentVariables['OMP_WEB_UI_SOURCE'] = $settings.Source
    $psi.EnvironmentVariables['OMP_WEB_UI_SERVICE_ROOT'] = $serviceRoot
    $psi.EnvironmentVariables['OMP_WEB_UI_HOSTNAME'] = $hostname
    $command = '"%OMP_WEB_UI_NODE%" "%OMP_WEB_UI_RUNNER%" --source "%OMP_WEB_UI_SOURCE%" -H "%OMP_WEB_UI_HOSTNAME%" -p ' + $port + ' --primary --service-root "%OMP_WEB_UI_SERVICE_ROOT%"'
    if ($settings.PublicUrl) {
        $psi.EnvironmentVariables['OMP_WEB_UI_PUBLIC_URL'] = $settings.PublicUrl
        $command += ' --public-url "%OMP_WEB_UI_PUBLIC_URL%"'
    }
    if ($null -ne $settings.ProxyPort) { $command += ' --proxy-port ' + $settings.ProxyPort }
    return $command
}
