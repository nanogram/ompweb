import { historyCursor, parseHistoryCursor, type SessionHistoryCursor, type SessionLiveSnapshot, type SessionStreamCursor, type SessionSyncResponse } from "@/lib/session-sync";
import type { SessionContext } from "@/lib/types";
import { isDeltaUpdate } from "@/lib/message-delta";
import type { AgentEvent } from "./useAgentSession-stream";

type SessionView = { leafId: string | null; includePreCompaction: boolean };

export function isHistoryAccessDeniedResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403
    || (response.redirected && /\/(?:login|auth)(?:[/?#]|$)/i.test(response.url))
    || (response.ok && /text\/html/i.test(response.headers?.get("content-type") ?? ""));
}

export interface SessionLiveFields {
  message: boolean;
  lifecycle: boolean;
  /** Null rejects tool hydration; otherwise retain these newer per-tool states. */
  tools: ReadonlySet<string> | null;
}

export interface SessionCatchUp {
  request(): Promise<SessionContext | null>;
  /** A live delta found no message to apply to: reads at most once per MISSING_BASE_RETRY_MS, however many such deltas arrive. */
  requestMissingBase(): void;
  seed(context: SessionContext, position?: SessionHistoryCursor | null, page?: { cursor?: SessionHistoryCursor; hasOlder?: boolean }): SessionContext;
  older(beforePrepend?: () => void): Promise<boolean>;
  hasOlder(): boolean;
  invalidate(): void;
  view(): SessionView;
  position(): SessionHistoryCursor | null;
  history(): SessionContext | null;
  select(view: SessionView): void;
  disconnect(): void;
  observe(event: AgentEvent): "epoch" | "stale" | null;
}

/** While reads fail fast, every base-less delta would send its own context request; one per window instead, then the next delta retries. */
export const MISSING_BASE_RETRY_MS = 2000;

/** One durable cursor per selected view. Live ordering is independent of disk pagination. */
export function createSessionCatchUp(options: {
  sessionId: () => string | null;
  scope: () => string | null;
  history: (context: SessionContext, leafId: string | null, metadata?: { version: number; hasLive: boolean }) => void;
  live: (snapshot: SessionLiveSnapshot, fields: SessionLiveFields) => void;
  subscribe: (force: boolean) => boolean;
  metadataVersion?: () => number;
  paging?: (state: { hasOlder: boolean; loadingOlder: boolean; error: boolean }) => void;
  missing?: (accessDenied?: boolean) => void;
}): SessionCatchUp {
  let context: SessionContext | null = null;
  let cursor: SessionHistoryCursor | null = null;
  let view: SessionView = { leafId: null, includePreCompaction: false };
  let revision = 0;
  let stream: SessionStreamCursor | null = null;
  let messageSequence = 0;
  let lifecycleSequence = 0;
  let toolsSnapshotSequence = 0;
  let latestToolSequence = 0;
  const toolSequences = new Map<string, number>();
  const resetStream = () => {
    stream = null;
    messageSequence = lifecycleSequence = toolsSnapshotSequence = latestToolSequence = 0;
    toolSequences.clear();
  };
  let requested = false;
  // performance.now() of the last missing-base request, and the one trailing request waiting for its window to end.
  let missingBaseAt = -Infinity;
  let missingBaseTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<SessionContext | null> | null = null;
  let activeRead: AbortController | null = null;
  let hasOlder = false;
  let olderPending: Promise<boolean> | null = null;
  const pagingState = (loadingOlder = false, error = false) => options.paging?.({ hasOlder, loadingOlder, error });

  const invalidate = () => {
    revision += 1;
    if (pending) requested = true;
    activeRead?.abort();
    pagingState();
    clearTimeout(missingBaseTimer);
    missingBaseTimer = undefined;
    missingBaseAt = -Infinity;
  };
  const seed = (next: SessionContext, position: SessionHistoryCursor | null = cursor, page?: { cursor?: SessionHistoryCursor; hasOlder?: boolean }) => {
    // A newer completed sync may reflect truncation, not just an append.
    // Keep it and re-read rather than inferring freshness from transcript length.
    if (cursor !== position && context) {
      void request();
      return context;
    }
    let seeded = next;
    let nextCursor = page?.cursor ? parseHistoryCursor(JSON.stringify(page.cursor)) : historyCursor(next);
    let nextHasOlder = page?.hasOlder === true;
    if (context && cursor && nextCursor?.contextFirstEntryId !== undefined
      && cursor.contextFirstEntryId === nextCursor.contextFirstEntryId && page?.hasOlder) {
      const join = context.entryIds.indexOf(next.entryIds[0]);
      const oldEnd = next.entryIds.indexOf(cursor.lastEntryId!);
      if (join < 0 || oldEnd < 0 || context.entryIds.length - join !== oldEnd + 1
        || context.entryIds.slice(join).some((id, index) => id !== next.entryIds[index])) {
        // An overview cannot fill a missed forward gap or discard loaded older rows.
        void request();
        return context;
      }
      if (join > 0) {
        seeded = {
          ...next,
          entryIds: [...context.entryIds.slice(0, join), ...next.entryIds],
          messages: [...context.messages.slice(0, join), ...next.messages],
        };
        nextCursor = { ...nextCursor, firstEntryId: cursor.firstEntryId };
        nextHasOlder = hasOlder;
      }
    }
    invalidate();
    context = seeded;
    cursor = nextCursor;
    hasOlder = nextHasOlder;
    pagingState();
    options.history(seeded, view.leafId);
    return seeded;
  };

  const request = (): Promise<SessionContext | null> => {
    requested = true;
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      let loaded: SessionContext | null = null;
      while (requested) {
        requested = false;
        const sid = options.sessionId();
        const scope = options.scope();
        if (!sid || scope === null) break;
        const version = revision;
        const publishedCursor = cursor;
        const metadataVersion = options.metadataVersion?.() ?? 0;
        // Pages are private until the selected history is complete. A failed
        // replacement must not truncate the visible history or advance its cursor.
        let nextContext = context;
        let nextCursor = cursor;
        let paging = false;
        const visited = new Set<string>();
        try {
          while (true) {
            const base = nextCursor;
            const params = new URLSearchParams({ sync: "1", recent: "1", deferThinking: "1", deferMedia: "1" });
            if (base) params.set("cursor", JSON.stringify(base));
            if (view.leafId) params.set("leafId", view.leafId);
            if (view.includePreCompaction) params.set("includePreCompaction", "1");
            const controller = new AbortController();
            activeRead = controller;
            const timeout = setTimeout(() => controller.abort(), 30_000);
            let page: SessionSyncResponse;
            try {
              const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, { signal: controller.signal });
              const denied = isHistoryAccessDeniedResponse(res);
              if ((res.status === 404 || denied) && options.scope() === scope && revision === version && options.sessionId() === sid) {
                context = null;
                cursor = null;
                hasOlder = false;
                pagingState();
                options.missing?.(denied);
              }
              if (denied) throw new Error("Session access denied");
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              page = await res.json() as SessionSyncResponse;
            } finally {
              clearTimeout(timeout);
              if (activeRead === controller) activeRead = null;
            }
            if (options.scope() !== scope || revision !== version || cursor !== publishedCursor || options.sessionId() !== sid) break;
            if (page.sessionId !== sid) break;
            if ((page.mode !== "append" && page.mode !== "replace") || page.context.messages.length !== page.context.entryIds.length) break;
            const parsedCursor = parseHistoryCursor(JSON.stringify(page.cursor));
            if (!parsedCursor) break;
            page.cursor = parsedCursor;
            const window = page.context.historyWindow;
            const previousWindow = nextContext?.historyWindow;
            // Privately collected pages must belong to one stable display window.
            if (paging && (page.mode === "replace"
              || window?.startOffset !== previousWindow?.startOffset
              || window?.endOffset !== previousWindow?.endOffset
              || window?.maxBytes !== previousWindow?.maxBytes)) break;
            if (page.hasMore && window && page.cursor.windowEndOffset !== window.endOffset) break;
            if (base?.windowEndOffset !== undefined && window && window.endOffset !== base.windowEndOffset) break;
            // This request discovered a wrapper restart that the old SSE never saw.
            if (page.live && stream && page.live.cursor.streamId !== stream.streamId) {
              options.subscribe(true);
              requested = false; // the new connection's open/connected frame starts a fresh read
              break;
            }
            if (page.mode === "append" && (page.baseEntryId !== (base?.lastEntryId ?? null)
              || (base?.contextFirstEntryId !== undefined && page.cursor.contextFirstEntryId !== base.contextFirstEntryId))) break;
            const unchanged = page.mode === "append" && page.context.entryIds.length === 0 && nextContext !== null;
            const messages = page.mode === "append" ? unchanged ? nextContext!.messages : [...(nextContext?.messages ?? [])] : [];
            const entryIds = page.mode === "append" ? unchanged ? nextContext!.entryIds : [...(nextContext?.entryIds ?? [])] : [];
            const seen = new Set(unchanged ? [] : entryIds);
            for (let i = 0; i < page.context.entryIds.length; i += 1) {
              const id = page.context.entryIds[i];
              if (!seen.has(id)) {
                seen.add(id);
                entryIds.push(id);
                messages.push(page.context.messages[i]);
              }
            }
            if (page.cursor.firstEntryId !== (entryIds[0] ?? null)
              || page.cursor.lastEntryId !== (entryIds.at(-1) ?? null)) break;
            nextContext = { ...page.context, messages, entryIds };
            nextCursor = page.cursor;
            if (page.hasMore) {
              // Cycles and non-advancing pages cannot publish partial rows.
              const key = JSON.stringify(page.cursor);
              if (visited.has(key) || page.context.entryIds.length === 0
                || (base?.firstEntryId === nextCursor.firstEntryId && base?.lastEntryId === nextCursor.lastEntryId)) break;
              visited.add(key);
              paging = true;
              continue;
            }
            context = nextContext;
            const completeCursor = { ...page.cursor };
            delete completeCursor.windowEndOffset;
            cursor = completeCursor;
            hasOlder = page.hasOlder === true;
            pagingState();
            loaded = context;
            options.history(context, page.leafId, { version: metadataVersion, hasLive: page.live !== null });
            if (page.live) {
              if (options.subscribe(false)) {
                requested = false;
                break;
              }
              if (stream) {
                const sequence = page.live.cursor.sequence;
                const busy = page.live.isStreaming || page.live.isPromptRunning || page.live.isCompacting;
                const preserve = sequence >= Math.max(toolsSnapshotSequence, lifecycleSequence) ? new Set<string>() : null;
                const fields: SessionLiveFields = {
                  message: sequence >= Math.max(messageSequence, lifecycleSequence),
                  lifecycle: sequence >= lifecycleSequence && (busy || sequence >= Math.max(messageSequence, latestToolSequence)),
                  tools: preserve,
                };
                if (preserve) {
                  for (const [id, seen] of toolSequences) {
                    if (seen > sequence) preserve.add(id);
                    else toolSequences.delete(id);
                  }
                  toolsSnapshotSequence = sequence;
                  latestToolSequence = Math.max(latestToolSequence, sequence);
                }
                if (fields.message) messageSequence = sequence;
                if (fields.lifecycle) lifecycleSequence = sequence;
                stream = { ...stream, sequence: Math.max(stream.sequence, sequence) };
                // Even with no field to apply, the snapshot can complete deltas that arrived without their message.
                options.live(page.live, fields);
              }
            }
            break;
          }
        } catch {
          // A failed read is not an empty transcript. A later trigger retries
          // from the last complete history, not a partially fetched replacement.
          loaded = null;
        }
      }
      return loaded;
    }).finally(() => {
      pending = null;
      // A trigger can arrive after the loop returned but before this finalizer.
      if (requested) void request();
    });
    return pending;
  };

  const requestMissingBase = () => {
    const wait = missingBaseAt + MISSING_BASE_RETRY_MS - performance.now();
    if (wait > 0) {
      // The last episode still gets its request, once the window ends: a quiet stream sends no further delta to retry.
      missingBaseTimer ??= setTimeout(() => {
        missingBaseTimer = undefined;
        requestMissingBase();
      }, wait);
      return;
    }
    missingBaseAt = performance.now();
    void request();
  };

  const older = (beforePrepend?: () => void): Promise<boolean> => {
    if (olderPending) return olderPending;
    olderPending = (async () => {
      const initialScope = options.scope();
      const initialView = view;
      // An older page must not join a privately staged forward chain.
      if (pending) await pending;
      if (initialScope !== options.scope() || initialView !== view) return false;
      const sid = options.sessionId();
      const scope = options.scope();
      const base = cursor;
      const previous = context;
      const version = revision;
      if (!sid || scope === null || !base || !previous || !hasOlder) return false;
      const current = () => options.sessionId() === sid && options.scope() === scope && revision === version && cursor === base;
      pagingState(true);
      const controller = new AbortController();
      activeRead = controller;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let failed = false;
      try {
        const params = new URLSearchParams({ sync: "1", recent: "1", direction: "older", deferThinking: "1", deferMedia: "1", cursor: JSON.stringify(base) });
        if (view.leafId) params.set("leafId", view.leafId);
        if (view.includePreCompaction) params.set("includePreCompaction", "1");
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, { signal: controller.signal });
        if (!current()) return false;
        const denied = isHistoryAccessDeniedResponse(res);
        if (res.status === 404 || denied) {
          context = null;
          cursor = null;
          hasOlder = false;
          options.missing?.(denied);
          return false;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = await res.json() as SessionSyncResponse;
        if (!current()) return false;
        if (page.sessionId !== sid || page.hasMore || page.context.messages.length !== page.context.entryIds.length) throw new Error("Invalid older history page");
        const position = parseHistoryCursor(JSON.stringify(page.cursor));
        if (!position || (page.mode !== "prepend" && page.mode !== "replace")) throw new Error("Invalid older history cursor");
        const previousIds = new Set(previous.entryIds);
        if (page.mode === "prepend" && (page.baseEntryId !== base.firstEntryId || position.lastEntryId !== base.lastEntryId
          || position.contextFirstEntryId !== base.contextFirstEntryId
          || page.context.entryIds.length === 0 || page.context.entryIds.some((id) => previousIds.has(id)))) throw new Error("Older history no longer joins");
        const next = page.mode === "replace" ? page.context : {
          ...page.context,
          messages: [...page.context.messages, ...previous.messages],
          entryIds: [...page.context.entryIds, ...previous.entryIds],
        };
        if (position.firstEntryId !== (next.entryIds[0] ?? null) || position.lastEntryId !== (next.entryIds.at(-1) ?? null)) throw new Error("Invalid older history bounds");
        if (page.mode === "prepend") beforePrepend?.();
        // A concurrent forward read retries from this widened cursor.
        if (pending) requested = true;
        context = next;
        cursor = position;
        hasOlder = page.hasOlder === true;
        options.history(next, page.leafId);
        return true;
      } catch {
        failed = true;
        return false;
      } finally {
        clearTimeout(timeout);
        if (activeRead === controller) activeRead = null;
        if (options.scope() === scope && view === initialView && revision === version) pagingState(false, failed);
      }
    })().finally(() => { olderPending = null; });
    return olderPending;
  };

  return {
    request,
    requestMissingBase,
    older,
    hasOlder: () => hasOlder,
    seed,
    invalidate,
    view: () => view,
    position: () => cursor,
    history: () => context,
    select(next: SessionView) {
      invalidate();
      view = next;
      cursor = null;
      context = null;
      hasOlder = false;
      pagingState();
    },
    disconnect() {
      invalidate();
      resetStream();
    },
    /** Observe receipt before token coalescing, so queued tokens also fence HTTP. */
    observe(event: AgentEvent): "epoch" | "stale" | null {
      const next = event.web;
      if (!next) return null;
      const changed = stream !== null && next.streamId !== stream.streamId;
      if (changed) {
        invalidate();
        resetStream();
      }
      const lifecycle = /^(agent_start|agent_end|prompt_result|prompt_error|auto_compaction_start|auto_compaction_end)$/.test(event.type);
      const message = /^(message_start|message_update|message_end)$/.test(event.type)
        && (event.message as { role?: unknown } | undefined)?.role !== "user";
      const tool = /^tool_execution_(start|update|end)$/.test(event.type) && typeof event.toolCallId === "string" ? event.toolCallId : null;
      const floor = lifecycle ? Math.max(lifecycleSequence, messageSequence, latestToolSequence)
        : message ? Math.max(lifecycleSequence, messageSequence)
        : tool ? Math.max(lifecycleSequence, toolsSnapshotSequence, toolSequences.get(tool) ?? 0) : 0;
      // A catch-up snapshot at sequence S already holds delta S: applying its frame again would repeat it.
      if (next.sequence < floor || (message && next.sequence === floor && isDeltaUpdate(event))) return "stale";
      if (lifecycle) {
        lifecycleSequence = next.sequence;
        toolSequences.clear();
      }
      if (message) messageSequence = next.sequence;
      if (tool) {
        toolSequences.set(tool, next.sequence);
        latestToolSequence = Math.max(latestToolSequence, next.sequence);
      }
      stream = { ...next, sequence: Math.max(stream?.sequence ?? 0, next.sequence) };
      return changed ? "epoch" : null;
    },
  };
}
