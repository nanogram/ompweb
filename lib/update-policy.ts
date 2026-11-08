import packageJson from "../package.json";

const TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];

export const DISABLE_AUTOUPDATE_ENV_VAR = "OMP_WEB_DISABLE_AUTOUPDATE";

/** Whether update checks and in-app self-update are disabled for this process. */
export function isUpdateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DISABLE_AUTOUPDATE_ENV_VAR];
  return typeof value === "string" && TRUTHY_ENV_VALUES.includes(value.trim().toLowerCase());
}

export const APP_UPDATE_SOURCE_URL = "https://github.com/nanogram/ompweb";
export const APP_UPDATE_MANUAL_REASON = `Automatic application and daemon updates are disabled for the nanogram fork. Update manually from ${APP_UPDATE_SOURCE_URL}.`;

/** The retained npm name belongs to upstream, not to this fork's release channel. */
export function getAppUpdateBlockedReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isUpdateDisabled(env)) return `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`;
  return packageJson.repository?.url === "git+https://github.com/kahme247/ompweb.git" ? null : APP_UPDATE_MANUAL_REASON;
}
