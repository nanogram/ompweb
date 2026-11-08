import { createHash } from "crypto";
import { listSessionsAllHosts } from "@/lib/hosts/session-index";
import { getRunningRpcSessions, getSessionActivities } from "@/lib/rpc-manager";
import { getHost } from "@/lib/hosts/hub";
import { isLinkUp } from "@/lib/hosts/host";
import { HostOpError } from "@/lib/hosts/link-protocol";
import type { SessionInfo } from "@/lib/types";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const filterId = params.get("id");
    const hostId = params.get("hostId");
    let sessions: SessionInfo[];
    if (filterId !== null && hostId !== null) {
      // Aggregate lists retain stale rows on host failures. Startup restore needs
      // an authoritative response from the remembered session's own machine.
      const host = getHost(hostId);
      if (!host || !isLinkUp(host.status())) throw new HostOpError(503, "host_offline", "The session host is offline");
      try {
        sessions = (await host.sessionOps.listSessions()).map((session) => ({ ...session, hostId }));
      } catch (error) {
        if (error instanceof HostOpError && error.status === 503) throw error;
        throw new HostOpError(503, "host_sessions_unavailable", "The session host's sessions are unavailable");
      }
    } else {
      sessions = await listSessionsAllHosts();
    }
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);
    // Filter only the session rows: navigation still needs the complete running
    // set (including host identity), just like the full sidebar response.
    const body = { sessions: filterId === null ? sessions : sessions.filter((session) => session.id === filterId), runningSessionIds, runningSessions, sessionActivities: getSessionActivities() };
    const bodyJson = JSON.stringify(body);
    if (filterId !== null) {
      return new Response(bodyJson, { headers: { "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
    }
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new Response(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    if (error instanceof HostOpError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
