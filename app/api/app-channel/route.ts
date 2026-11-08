import { AppChannelError, requestAppChannel } from "@/lib/app-channel";
import { isApiRequestOriginAllowed } from "@/lib/request-security";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";

const headers = { "Cache-Control": "no-store" };
function failure(error: unknown): Response {
  if (error instanceof AppChannelError) return Response.json({ error: error.message }, { status: error.status, headers });
  return Response.json({ error: "The version manager could not be contacted. Refresh and try again." }, { status: 502, headers });
}
export async function GET(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403, headers });
  try { return Response.json(await requestAppChannel("state"), { headers }); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415, headers });
  }
  let body: unknown;
  try { body = await parseJsonWithinLimit<unknown>(request, 4_096); } catch (error) {
    return Response.json({ error: error instanceof RequestBodyTooLargeError ? error.message : "Request body must be valid JSON" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid version action" }, { status: 400, headers });
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  try {
    if (value.action === "select" && keys.length === 2 && (value.channel === "main" || value.channel === "fork")) {
      return Response.json(await requestAppChannel("select", value.channel), { status: 202, headers });
    }
    if (value.action === "restart" && keys.length === 1) {
      return Response.json(await requestAppChannel("restart"), { status: 202, headers });
    }
    return Response.json({ error: "Use exactly {action: select, channel: main|fork} or {action: restart}" }, { status: 400, headers });
  } catch (error) { return failure(error); }
}
