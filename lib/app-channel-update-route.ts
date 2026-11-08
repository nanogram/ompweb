import { getInstalledAppRelease } from "./app-channel";
import { isApiRequestOriginAllowed } from "./request-security";

const blockedReason = "Use the application version selector in System settings to prepare a version, then restart OMPweb. Package replacement is disabled to preserve the version manager.";

/** Shared by managed upstream source installs; never invoke the npm self-updater. */
export async function GET() {
  return Response.json({
    currentVersion: getInstalledAppRelease().version,
    updatesDisabled: true,
    selfUpdateSupported: false,
    availableVersion: null,
    updateAvailable: false,
    blockedReason,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  return Response.json({ error: blockedReason, code: "managed_app_channel" }, { status: 409 });
}
