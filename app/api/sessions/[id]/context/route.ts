import { buildSessionContext } from "@/lib/session-reader";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { MAX_SYNC_MESSAGES, RECENT_SYNC_MESSAGES, parseHistoryCursor, selectRecentHistoryRange, selectSessionHistory, type SessionHistoryCursor, type SessionHistoryPage, type SessionSyncResponse } from "@/lib/session-sync";

import { historyJsonResponse } from "@/lib/history-response";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // Read-only transcript mode: include entries omitted from the active agent context.
  const includePreCompaction = url.searchParams.has("includePreCompaction");
  const sync = url.searchParams.get("sync");
  const boundary = url.searchParams.get("boundary");
  const recent = url.searchParams.get("recent");
  const direction = url.searchParams.get("direction");
  if (boundary !== null) {
    if (boundary !== "1" || url.searchParams.getAll("boundary").length !== 1) {
      return Response.json({ error: "Invalid boundary mode", code: "invalid_boundary" }, { status: 400 });
    }
    if (["sync", "recent", "direction", "leafId", "includePreCompaction", "cursor", "limit"].some((option) => url.searchParams.has(option))) {
      return Response.json({ error: "Boundary mode requires the current active context", code: "invalid_boundary_options" }, { status: 400 });
    }
  }
  let cursor: SessionHistoryCursor | null = null;
  let limit = recent === "1" ? RECENT_SYNC_MESSAGES : MAX_SYNC_MESSAGES;
  if (sync !== null && (sync !== "1" || url.searchParams.getAll("sync").length !== 1)) {
    return Response.json({ error: "Invalid sync mode", code: "invalid_sync" }, { status: 400 });
  }
  if (recent !== null && (recent !== "1" || sync !== "1" || url.searchParams.getAll("recent").length !== 1)) {
    return Response.json({ error: "Invalid recent mode", code: "invalid_recent" }, { status: 400 });
  }
  if (direction !== null && (direction !== "older" || recent !== "1" || !url.searchParams.has("cursor")
    || url.searchParams.getAll("direction").length !== 1)) {
    return Response.json({ error: "Invalid history direction", code: "invalid_sync_direction" }, { status: 400 });
  }
  if (sync === null && ["cursor", "limit"].some((key) => url.searchParams.has(key))) {
    return Response.json({ error: "History paging requires sync mode", code: "invalid_sync_options" }, { status: 400 });
  }
  if (sync === "1") {
    try {
      if (url.searchParams.getAll("cursor").length > 1) throw new Error("Duplicate history cursor");
      cursor = parseHistoryCursor(url.searchParams.get("cursor"));
    } catch {
      return Response.json({ error: "Invalid history cursor", code: "invalid_sync_cursor" }, { status: 400 });
    }
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isInteger(limit)
        || limit > (recent === "1" ? RECENT_SYNC_MESSAGES : MAX_SYNC_MESSAGES)
        || url.searchParams.getAll("limit").length !== 1) {
        return Response.json({ error: "Invalid history page limit", code: "invalid_sync_limit" }, { status: 400 });
      }
    }
  }

  try {
    const resolved = await resolveSessionHostOr404(id);
    // A live session resolves to its host even before its file exists; the host then answers 404.
    const result = "response" in resolved ? resolved : await resolved.host.sessionOps.readContext(id, leafId, {
      deferThinking,
      deferMedia: deferToolResultImages,
      includePreCompaction,
      boundary: boundary === "1",
      sync: sync === "1" ? { cursor, limit, recent: recent === "1", older: direction === "older" } : null,
    });
    if ("response" in result || !result.ok) {
      // OMP may not create the file until the first assistant message is
      // committed. A live wrapper can still recover that first partial reply,
      // and its persisted boundary is empty (the next prompt must not 404).
      // Never replace previously confirmed history when its file is missing.
      const notFound = "response" in result ? result.response.status === 404 : result.status === 404;
      const session = notFound && (boundary === "1" || (sync === "1" && !cursor?.lastEntryId && leafId === undefined)) ? getRpcSession(id) : undefined;
      if (session?.isAlive() && !(await session.host.sessionFileExists(session.sessionFile))) {
        if (boundary === "1") {
          return await historyJsonResponse(req, { entryIds: [] });
        }
        const context = buildSessionContext([]);
        const recentPage = recent === "1"
          ? selectRecentHistoryRange([], cursor, limit, undefined, { older: direction === "older" })
          : null;
        const response: SessionSyncResponse = {
          ...(recentPage ? {
            mode: recentPage.mode,
            baseEntryId: recentPage.baseEntryId,
            cursor: recentPage.cursor,
            hasMore: recentPage.hasMore,
            hasOlder: recentPage.hasOlder,
            context,
          } : selectSessionHistory(context, cursor, limit)),
          sessionId: id,
          leafId: null,
          live: session.getStreamSnapshot(),
        };
        return await historyJsonResponse(req, response);
      }
      return "response" in result ? result.response : opErrorResponse(result);
    }
    if (boundary === "1") {
      return await historyJsonResponse(req, result.value);
    }
    if (sync === "1") {
      const page = result.value as { history: SessionHistoryPage; leafId: string | null; tipId: string | null };
      // Sample AFTER the disk read: a quiet active run still supplies its most
      // recent partial output, and events arriving during the read win.
      const session = getRpcSession(id);
      const live = session?.isAlive() && (leafId === undefined || leafId === page.tipId)
        ? session.getStreamSnapshot()
        : null;
      const response: SessionSyncResponse = { ...page.history, sessionId: id, leafId: page.leafId, live };
      return await historyJsonResponse(req, response);
    }
    return await historyJsonResponse(req, result.value);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
