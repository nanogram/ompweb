import packageJson from "../package.json";

export type AppChannel = "main" | "fork";
export type AppChannelRelease = { channel: AppChannel; version: string; revision: string | null };
export type AppChannelStatus = {
  supported: boolean;
  active: AppChannelRelease;
  selected: AppChannelRelease;
  preparing: null | { channel: AppChannel; stage: string };
  restartRequired: boolean;
  restarting: boolean;
  error: string | null;
  reason?: string;
};

export class AppChannelError extends Error {
  constructor(message: string, public readonly status = 502) { super(message); }
}

function isChannel(value: unknown): value is AppChannel {
  return value === "main" || value === "fork";
}

export function getInstalledAppRelease(): AppChannelRelease {
  const current = process.env.OMP_WEB_CHANNEL_CURRENT;
  return {
    channel: isChannel(current) ? current : /-n(?:\d|anogram)/.test(packageJson.version) ? "fork" : "main",
    version: packageJson.version,
    revision: null,
  };
}

function controlConnection(): { url: string; token: string } | null {
  const url = process.env.OMP_WEB_CHANNEL_CONTROL_URL;
  const token = process.env.OMP_WEB_CHANNEL_CONTROL_TOKEN;
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return { url: parsed.origin, token };
  } catch { return null; }
}

function release(value: unknown): AppChannelRelease {
  const candidate = value as Partial<AppChannelRelease> | null;
  if (!candidate || !isChannel(candidate.channel) || typeof candidate.version !== "string"
    || !(candidate.revision === null || typeof candidate.revision === "string")) {
    throw new AppChannelError("The version manager returned an invalid status. Refresh and try again.");
  }
  return { channel: candidate.channel, version: candidate.version, revision: candidate.revision };
}

/** Only public status fields cross the server/browser boundary. */
function publicStatus(value: unknown): AppChannelStatus {
  const candidate = value as AppChannelStatus | null;
  if (!candidate || typeof candidate.supported !== "boolean" || typeof candidate.restartRequired !== "boolean"
    || typeof candidate.restarting !== "boolean" || !(candidate.error === null || typeof candidate.error === "string")
    || !(candidate.preparing === null || (isChannel(candidate.preparing?.channel) && typeof candidate.preparing.stage === "string"))) {
    throw new AppChannelError("The version manager returned an invalid status. Refresh and try again.");
  }
  return {
    supported: candidate.supported,
    active: release(candidate.active), selected: release(candidate.selected),
    preparing: candidate.preparing ? { channel: candidate.preparing.channel, stage: candidate.preparing.stage } : null,
    restartRequired: candidate.restartRequired, restarting: candidate.restarting, error: candidate.error,
    ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
  };
}

export async function requestAppChannel(action: "state" | "select" | "restart", channel?: AppChannel): Promise<AppChannelStatus> {
  const connection = controlConnection();
  if (!connection) {
    const reason = "Version switching requires the production Node launcher. Start OMPweb with node bin/omp-web.js (not direct Bun, development, or a compiled executable).";
    if (action !== "state") throw new AppChannelError(reason, 409);
    const active = getInstalledAppRelease();
    return { supported: false, active, selected: active, preparing: null, restartRequired: false, restarting: false, error: null, reason };
  }
  let response: Response;
  try {
    response = await fetch(`${connection.url}/${action}`, {
      method: action === "state" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${connection.token}`, ...(action === "state" ? {} : { "Content-Type": "application/json" }) },
      ...(action === "state" ? {} : { body: JSON.stringify(action === "select" ? { channel } : {}) }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppChannelError("The version manager is unavailable. Refresh to reconnect, or restart OMPweb with the Node launcher.", 503);
  }
  let value: unknown;
  try { value = await response.json(); } catch {
    throw new AppChannelError("The version manager returned an invalid response. Refresh and try again.");
  }
  if (!response.ok) {
    const message = (value as { error?: unknown } | null)?.error;
    const safeMessage = typeof message === "string" && !message.includes(connection.token) && !message.includes(connection.url)
      ? message : "The version manager could not complete the action. Refresh and try again.";
    throw new AppChannelError(safeMessage, [400, 409, 503].includes(response.status) ? response.status : 502);
  }
  const status = publicStatus(value);
  const serialized = JSON.stringify(status);
  if (serialized.includes(connection.token) || serialized.includes(connection.url)) {
    throw new AppChannelError("The version manager returned an invalid public status. Refresh and try again.");
  }
  return status;
}
