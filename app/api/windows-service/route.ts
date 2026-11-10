import * as path from "node:path";
import {
  getWebServiceStatus,
  installTrayShortcuts,
  uninstallTrayShortcuts,
  toggleAutostart,
  startTrayService,
  requestTrayServiceAction,
  type WebServiceConfig,
} from "@/lib/windows-service";

interface WindowsServiceRequestBody extends Partial<WebServiceConfig> {
  action?: "install" | "uninstall" | "toggle-autostart" | "start" | "stop" | "restart";
  startImmediately?: boolean;
  cleanConfig?: boolean;
}

export async function GET(): Promise<Response> {
  const status = await getWebServiceStatus();
  return Response.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as WindowsServiceRequestBody;
    const { action } = body;

    if (!action) {
      return Response.json(
        { error: "Missing required 'action' parameter.", code: "missing_action" },
        { status: 400 }
      );
    }

    let result: { success: boolean; message?: string } = { success: true };

    switch (action) {
      case "install": {
        if (body.mode !== undefined && body.mode !== "start" && body.mode !== "dev" && body.mode !== "ui") {
          return Response.json({ error: "Mode must be 'start', 'dev', or 'ui'.", code: "invalid_mode" }, { status: 400 });
        }
        if (body.uiSource !== undefined && (typeof body.uiSource !== "string" || !path.isAbsolute(body.uiSource))) {
          return Response.json({ error: "uiSource must be an absolute source checkout path.", code: "invalid_ui_source" }, { status: 400 });
        }
        if (body.uiPublicUrl !== undefined) {
          let validOrigin = false;
          try {
            const url = new URL(body.uiPublicUrl);
            validOrigin = typeof body.uiPublicUrl === "string" && url.protocol === "https:" &&
              !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
          } catch {
            // Invalid URLs are rejected before saving any settings.
          }
          if (!validOrigin) {
            return Response.json({ error: "uiPublicUrl must be a trusted HTTPS origin.", code: "invalid_ui_public_url" }, { status: 400 });
          }
        }
        if (body.uiProxyPort !== undefined && (typeof body.uiProxyPort !== "number" || !Number.isInteger(body.uiProxyPort) || body.uiProxyPort < 1 || body.uiProxyPort > 65535)) {
          return Response.json({ error: "uiProxyPort must be an integer from 1 to 65535.", code: "invalid_ui_proxy_port" }, { status: 400 });
        }
        result = await installTrayShortcuts({
          port: body.port,
          hostname: body.hostname,
          mode: body.mode,
          uiSource: body.uiSource,
          uiPublicUrl: body.uiPublicUrl,
          uiProxyPort: body.uiProxyPort,
          autostart: body.autostart,
          openBrowserOnLaunch: body.openBrowserOnLaunch,
          autoRestart: body.autoRestart,
          startImmediately: body.startImmediately,
        });
        break;
      }

      case "uninstall":
        result = await uninstallTrayShortcuts({
          cleanConfig: body.cleanConfig,
        });
        break;

      case "toggle-autostart": {
        const targetState = body.autostart !== false;
        result = await toggleAutostart(targetState);
        break;
      }

      case "start":
        result = await startTrayService({ openBrowser: false });
        break;

      case "stop":
      case "restart": {
        const scheduled = await requestTrayServiceAction(action);
        // Reading status here can outlive the controller's delay and lose the
        // response when our own web process stops. The browser reconnects.
        return Response.json(scheduled.success
          ? { success: true, message: scheduled.message }
          : { error: scheduled.message, code: "action_failed" },
        { status: scheduled.success ? 202 : 500 });
      }

      default:
        return Response.json(
          { error: `Unknown action '${String(action)}'.`, code: "invalid_action" },
          { status: 400 }
        );
    }

    const updatedStatus = await getWebServiceStatus();

    if (!result.success) {
      return Response.json(
        {
          error: result.message || `Action '${action}' failed.`,
          code: "action_failed",
          status: updatedStatus,
        },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      message: result.message,
      status: updatedStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "server_error" }, { status: 500 });
  }
}
