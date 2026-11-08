import type { AgentMessage, SessionContext } from "./types";

/** Durable display-history position, scoped to one session and selected view. */
export interface SessionHistoryCursor {
  firstEntryId: string | null;
  lastEntryId: string | null;
  /** First row of the full selected path, independent of the loaded subset. */
  contextFirstEntryId?: string | null;
  /** Pins a bounded read only until its final page has been delivered. */
  windowEndOffset?: number;
}

/** Ordering within one web-owned RPC process; resets when that process changes. */
export interface SessionStreamCursor {
  streamId: string;
  sequence: number;
}

export interface SessionLiveToolEvent {
  type: "tool_execution_start" | "tool_execution_update";
  toolCallId: string;
  [key: string]: unknown;
}

export interface SessionLiveSnapshot {
  cursor: SessionStreamCursor;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isCompacting: boolean;
  streamingMessage: Partial<AgentMessage> | null;
  /** omp's messageId of `streamingMessage`: the message its delta updates apply to. */
  streamingMessageId?: string | null;
  toolEvents: SessionLiveToolEvent[];
  /** Positive run-scoped evidence survives message_end's delayed file write. */
  responseObserved?: boolean;
}

export interface SessionHistoryPage {
  mode: "append" | "prepend" | "replace";
  baseEntryId: string | null;
  context: SessionContext;
  cursor: SessionHistoryCursor;
  hasMore: boolean;
  /** Earlier retained rows, distinct from pending forward catch-up. */
  hasOlder?: boolean;
}

export interface SessionHistoryRange extends Omit<SessionHistoryPage, "context"> {
  start: number;
  end: number;
}

export interface SessionSyncResponse extends SessionHistoryPage {
  sessionId: string;
  leafId: string | null;
  /** Null for a file-only session or a view pinned to a historical branch. */
  live: SessionLiveSnapshot | null;
}

export const MAX_SYNC_MESSAGES = 200;
export const RECENT_SYNC_MESSAGES = 50;
/** Soft raw JSONL body-byte budget; one complete oversized row may progress. */
export const MAX_SYNC_PAGE_BYTES = 256 * 1024;

export function historyCursor(context: Pick<SessionContext, "entryIds">): SessionHistoryCursor {
  return {
    firstEntryId: context.entryIds[0] ?? null,
    lastEntryId: context.entryIds.at(-1) ?? null,
  };
}

/** Decode only bounded IDs; a cursor never authorizes a session or a file path. */
export function parseHistoryCursor(raw: string | null): SessionHistoryCursor | null {
  if (raw === null) return null;
  if (raw.length > 2048) throw new Error("Invalid history cursor");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history cursor");
  const cursor = value as Record<string, unknown>;
  const validId = (id: unknown): id is string | null => id === null || (typeof id === "string" && id.length > 0 && id.length <= 256);
  if (!validId(cursor.firstEntryId) || !validId(cursor.lastEntryId)
    || (cursor.firstEntryId === null) !== (cursor.lastEntryId === null)
    || (cursor.contextFirstEntryId !== undefined
      && (!validId(cursor.contextFirstEntryId)
        || (cursor.contextFirstEntryId === null) !== (cursor.firstEntryId === null)))
    || (cursor.windowEndOffset !== undefined
      && (typeof cursor.windowEndOffset !== "number" || !Number.isSafeInteger(cursor.windowEndOffset) || cursor.windowEndOffset < 0))) {
    throw new Error("Invalid history cursor");
  }
  return {
    firstEntryId: cursor.firstEntryId,
    lastEntryId: cursor.lastEntryId,
    ...(cursor.contextFirstEntryId === undefined ? {} : { contextFirstEntryId: cursor.contextFirstEntryId as string | null }),
    ...(cursor.windowEndOffset === undefined ? {} : { windowEndOffset: cursor.windowEndOffset as number }),
  };
}

/** Page the selected display path; an invalidated branch/compaction cursor resets it. */
export function selectSessionHistory(
  context: SessionContext,
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
): SessionHistoryPage {
  const { start, end, ...page } = selectHistoryRange(context.entryIds, cursor, limit);
  if (page.hasMore && context.historyWindow) page.cursor.windowEndOffset = context.historyWindow.endOffset;
  return {
    ...page,
    context: { ...context, messages: context.messages.slice(start, end), entryIds: context.entryIds.slice(start, end) },
  };
}

/** Indexed readers can locate a cursor without scanning the delivered prefix again. */
export function selectHistoryRange(
  entryIds: readonly string[],
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
  positions?: ReadonlyMap<string, number>,
): SessionHistoryRange {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SYNC_MESSAGES) throw new RangeError("Invalid history page limit");
  const firstEntryId = entryIds[0] ?? null;
  const cursorIndex = cursor?.lastEntryId
    ? positions ? positions.get(cursor.lastEntryId) ?? -1 : entryIds.indexOf(cursor.lastEntryId)
    : -1;
  const append = cursor !== null && cursor.firstEntryId === firstEntryId
    && ((cursorIndex >= 0 && entryIds[cursorIndex] === cursor.lastEntryId) || (cursor.lastEntryId === null && entryIds.length === 0));
  const start = append ? cursorIndex + 1 : 0;
  const end = Math.min(start + limit, entryIds.length);
  return {
    mode: append ? "append" : "replace",
    baseEntryId: append ? cursor.lastEntryId : null,
    start,
    end,
    cursor: { firstEntryId, lastEntryId: entryIds[end - 1] ?? null },
    hasMore: end < entryIds.length,
  };
}

/** Select a bounded newest page, an older prepend, or forward catch-up. */
export function selectRecentHistoryRange(
  entryIds: readonly string[],
  cursor: SessionHistoryCursor | null,
  limit = RECENT_SYNC_MESSAGES,
  positions?: ReadonlyMap<string, number>,
  options: { older?: boolean; rowBytes?: readonly number[]; maxBytes?: number } = {},
): SessionHistoryRange {
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_SYNC_MESSAGES) throw new RangeError("Invalid history page limit");
  const maxBytes = options.maxBytes ?? MAX_SYNC_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Invalid history page byte limit");
  const contextFirstEntryId = entryIds[0] ?? null;
  const locate = (id: string | null | undefined) => {
    if (id == null) return -1;
    const index = positions ? positions.get(id) ?? -1 : entryIds.indexOf(id);
    return entryIds[index] === id ? index : -1;
  };
  const firstIndex = locate(cursor?.firstEntryId);
  const lastIndex = locate(cursor?.lastEntryId);
  const valid = cursor !== null && cursor.contextFirstEntryId === contextFirstEntryId
    && ((firstIndex >= 0 && lastIndex >= firstIndex)
      || (entryIds.length === 0 && cursor.firstEntryId === null && cursor.lastEntryId === null));
  const mode = valid ? options.older ? "prepend" : "append" : "replace";
  const bytesAt = (index: number) => {
    const bytes = options.rowBytes === undefined ? 0 : options.rowBytes[index];
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid history row byte length");
    return bytes;
  };
  let start: number;
  let end: number;
  let bytes = 0;
  if (mode === "append") {
    start = lastIndex + 1;
    end = start;
    while (end < entryIds.length && end - start < limit) {
      const nextBytes = bytesAt(end);
      if (end > start && bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      end++;
      if (bytes >= maxBytes) break;
    }
  } else {
    end = mode === "prepend" ? Math.max(0, firstIndex) : entryIds.length;
    start = end;
    while (start > 0 && end - start < limit) {
      const nextBytes = bytesAt(start - 1);
      if (start < end && bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      start--;
      if (bytes >= maxBytes) break;
    }
  }
  const loadedFirst = mode === "append" ? cursor!.firstEntryId
    : entryIds[start] ?? cursor?.firstEntryId ?? null;
  const loadedLast = mode === "prepend" ? cursor!.lastEntryId
    : entryIds[end - 1] ?? null;
  return {
    mode,
    baseEntryId: mode === "append" ? cursor!.lastEntryId : mode === "prepend" ? cursor!.firstEntryId : null,
    start,
    end,
    cursor: {
      firstEntryId: mode === "replace" ? entryIds[start] ?? null : loadedFirst,
      lastEntryId: loadedLast,
      contextFirstEntryId,
    },
    hasMore: mode === "append" && end < entryIds.length,
    hasOlder: mode === "append" ? firstIndex > 0 : start > 0,
  };
}
