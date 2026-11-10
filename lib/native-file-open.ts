import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isOmpSecretFile } from "./file-access";
import { HostOpError } from "./hosts/link-protocol";
import { canOpenInSystemApp } from "./native-file-types";
import { createChildProcessEnvironment } from "./project-command-env";
import { resolvePowerShellBin } from "./windows-service";
import type { WorkspaceFileInfo } from "./workspace-types";

const execFileAsync = promisify(execFile);
const WINDOWS_OPEN_DOCUMENT = [
  "$ErrorActionPreference = 'Stop'",
  "$start = New-Object System.Diagnostics.ProcessStartInfo",
  "$start.FileName = $env:OMP_WEB_NATIVE_FILE",
  "$start.UseShellExecute = $true",
  "$start.Verb = 'open'",
  "$opened = [System.Diagnostics.Process]::Start($start)",
  "if ($null -ne $opened) { $opened.Dispose() }",
].join("; ");

async function launchDefaultApplication(filePath: string): Promise<void> {
  const options = { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, env: createChildProcessEnvironment() };
  if (process.platform === "win32") {
    // The filename is data, not PowerShell source or a command-line fragment.
    await execFileAsync(resolvePowerShellBin(), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_OPEN_DOCUMENT], {
      ...options, env: createChildProcessEnvironment({ OMP_WEB_NATIVE_FILE: filePath }),
    });
  } else if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/open", ["--", filePath], options);
  } else if (process.platform === "linux") {
    await execFileAsync("xdg-open", [filePath], options);
  } else {
    throw new HostOpError(501, "native_open_unsupported", "System application opening is not supported on this operating system");
  }
}

/** Only call with metadata authorized by this machine's owning workspace host. */
export async function openNativeFile(
  info: Pick<WorkspaceFileInfo, "path" | "size" | "mtimeMs" | "isDirectory">,
  launch: (filePath: string) => Promise<void> = launchDefaultApplication,
): Promise<void> {
  if (!path.isAbsolute(info.path) || !canOpenInSystemApp(info.path)) {
    throw new HostOpError(403, "native_file_type_blocked", "Only supported documents and media can be opened in a system application");
  }
  let canonical: string;
  let current: Stats;
  try {
    canonical = await realpath(info.path);
    current = await stat(canonical);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new HostOpError(404, "file_not_found", "The file is no longer available on the OMPweb computer");
    }
    throw error;
  }
  if (info.isDirectory || !current.isFile()) throw new HostOpError(400, "not_a_file", "Not a regular file");
  if (!canOpenInSystemApp(canonical) || isOmpSecretFile(canonical)) {
    throw new HostOpError(403, "native_file_type_blocked", "The resolved file cannot be opened in a system application");
  }
  // Never reinterpret a linked host's path or open a local namesake that does not match its authorized metadata.
  if (current.size !== info.size || Math.abs(current.mtimeMs - info.mtimeMs) > 1) {
    throw new HostOpError(409, "file_changed", "The file changed after it was authorized; try opening it again");
  }
  try {
    await launch(canonical);
  } catch (error) {
    if (error instanceof HostOpError) throw error;
    throw new HostOpError(502, "native_open_failed", `Could not open the file in its system application: ${error instanceof Error ? error.message : String(error)}`);
  }
}
