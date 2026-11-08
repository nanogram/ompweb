import type { AgentMessage, SessionContext } from "./types";

export const RECENT_CACHE_MAX_MESSAGES = 50;
export const RECENT_CACHE_SESSION_BYTES = 256 * 1024;
export const RECENT_CACHE_TOTAL_BYTES = 4 * 1024 * 1024;
export const RECENT_CACHE_MAX_ENTRIES = 24;
export const RECENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_TIMEOUT_MS = 1500;
const STORE = "transcripts";
const VERSION = 1;
export type RecentHistoryView = { leafId: string | null; includePreCompaction: boolean };
interface CacheRow {
  key: string;
  sessionId: string;
  version: number;
  payload: string;
  bytes: number;
  writtenAt: number;
  touchedAt: number;
}
const messageFields: Record<string, true> = Object.fromEntries(["role", "content", "timestamp", "branchSummary", "model", "provider", "toolCallId", "toolName", "isError", "passiveContext", "customType", "display", "command", "output", "exitCode", "cancelled", "truncated", "fullOutputPath", "excludeFromContext", "code", "files"].map((key) => [key, true]));
const roles: Record<string, true> = { user: true, assistant: true, toolResult: true, custom: true, developer: true, bashExecution: true, pythonExecution: true, fileMention: true };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function isCacheRow(value: unknown): value is CacheRow {
  return record(value) && value.version === VERSION && typeof value.key === "string" && typeof value.sessionId === "string"
    && typeof value.payload === "string" && value.payload.length <= RECENT_CACHE_SESSION_BYTES
    && typeof value.bytes === "number" && value.bytes > 0 && value.bytes <= RECENT_CACHE_SESSION_BYTES
    && typeof value.writtenAt === "number" && Number.isFinite(value.writtenAt)
    && typeof value.touchedAt === "number" && Number.isFinite(value.touchedAt)
    && value.bytes === new TextEncoder().encode(value.payload).length;
}

function validImage(value: unknown): boolean {
  if (!record(value) || value.type !== "image"
    || ["data", "mimeType", "url"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) return false;
  const source = value.source;
  if (source !== undefined && (!record(source) || !["base64", "url"].includes(String(source.type))
    || ["media_type", "data", "url"].some((key) => source[key] !== undefined && typeof source[key] !== "string"))) return false;
  return typeof value.data === "string" || typeof value.url === "string" || record(source);
}

/** Cached rows are display-only: no cursor, model state, usage or live controls. */
export function decodeRecentHistory(payload: unknown): SessionContext | null {
  if (typeof payload !== "string" || payload.length > RECENT_CACHE_SESSION_BYTES || new TextEncoder().encode(payload).length > RECENT_CACHE_SESSION_BYTES) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!record(value) || !Array.isArray(value.messages) || !Array.isArray(value.entryIds)
      || value.messages.length === 0 || value.messages.length > RECENT_CACHE_MAX_MESSAGES || value.messages.length !== value.entryIds.length
      || value.entryIds.some((id) => typeof id !== "string" || !id || id.length > 4096) || new Set(value.entryIds).size !== value.entryIds.length) return null;
    for (const message of value.messages) {
      if (!record(message) || typeof message.role !== "string" || !Object.hasOwn(roles, message.role)
        || Object.keys(message).some((key) => !Object.hasOwn(messageFields, key))) return null;
      if (["model", "provider", "toolCallId", "toolName", "passiveContext", "customType", "command", "output", "fullOutputPath", "code"]
        .some((key) => message[key] !== undefined && typeof message[key] !== "string")
        || ["branchSummary", "isError", "display", "cancelled", "truncated", "excludeFromContext"]
          .some((key) => message[key] !== undefined && typeof message[key] !== "boolean")
        || ["timestamp", "exitCode"].some((key) => message[key] !== undefined && (typeof message[key] !== "number" || !Number.isFinite(message[key])))) return null;
      if (["bashExecution", "pythonExecution"].includes(message.role)) {
        if (typeof message.output !== "string" || typeof message[message.role === "bashExecution" ? "command" : "code"] !== "string") return null;
      } else if (message.role === "fileMention") {
        if (!Array.isArray(message.files) || message.files.some((file) => !record(file) || typeof file.path !== "string" || typeof file.content !== "string"
          || (file.lineCount !== undefined && (typeof file.lineCount !== "number" || !Number.isFinite(file.lineCount)))
          || (file.byteSize !== undefined && (typeof file.byteSize !== "number" || !Number.isFinite(file.byteSize)))
          || (file.skippedReason !== undefined && !["tooLarge", "binary"].includes(String(file.skippedReason)))
          || (file.image !== undefined && !validImage(file.image)))) return null;
      } else if (typeof message.content !== "string" && (!Array.isArray(message.content) || message.content.some((block) => {
        if (!record(block)) return true;
        if (block.type === "text") return typeof block.text !== "string";
        if (block.type === "thinking") return message.role !== "assistant" || typeof block.thinking !== "string" || (block.deferred !== undefined && typeof block.deferred !== "boolean");
        if (block.type === "toolCall") return message.role !== "assistant" || typeof block.toolCallId !== "string" || typeof block.toolName !== "string" || !record(block.input);
        if (block.type === "image") return !validImage(block);
        return true;
      }))) return null;
      if (["assistant", "toolResult"].includes(message.role) && !Array.isArray(message.content)) return null;
      if (message.role === "toolResult" && typeof message.toolCallId !== "string") return null;
      if (message.role === "custom" && (typeof message.customType !== "string" || typeof message.display !== "boolean")) return null;
    }
    return { messages: value.messages as AgentMessage[], entryIds: value.entryIds as string[], model: null, thinkingLevel: "off", todoPhases: [] };
  } catch { return null; }
}

export function encodeRecentHistory(context: SessionContext): string | null {
  const messages: string[] = [];
  const entryIds: string[] = [];
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify({ messages: [], entryIds: [] })).length;
  for (let i = context.messages.length - 1; i >= Math.max(0, context.messages.length - RECENT_CACHE_MAX_MESSAGES); i -= 1) {
    const source = context.messages[i];
    // Persisted HTTP history only; a partial tool snapshot is never durable.
    if ((source.role === "toolResult" && source.partial) || !context.entryIds[i]) return null;
    const message = JSON.stringify(Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(messageFields, key))));
    const id = JSON.stringify(context.entryIds[i]);
    if (message.length > RECENT_CACHE_SESSION_BYTES) break;
    bytes += encoder.encode(message).length + encoder.encode(id).length + (messages.length ? 2 : 0);
    if (bytes > RECENT_CACHE_SESSION_BYTES) break;
    messages.unshift(message);
    entryIds.unshift(id);
  }
  if (!messages.length) return null;
  const payload = `{"messages":[${messages.join(",")}],"entryIds":[${entryIds.join(",")}]}`;
  return decodeRecentHistory(payload) ? payload : null;
}

/** IDB is origin-local. Every operation is optional and deadline-bounded. */
export function createRecentHistoryCache(options: { indexedDB?: () => IDBFactory | undefined; now?: () => number; timeoutMs?: number } = {}) {
  let epoch = 0;
  const now = options.now ?? Date.now;
  const factory = options.indexedDB ?? (() => typeof indexedDB === "undefined" ? undefined : indexedDB);
  const keyFor = (sessionId: string, view: RecentHistoryView) => JSON.stringify([sessionId, view.leafId, view.includePreCompaction]);
  async function transact<T>(fallback: T, action: (store: IDBObjectStore, finish: (value: T) => void) => void): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<T>();
    let db: IDBDatabase | undefined;
    let tx: IDBTransaction | undefined;
    let ended = false;
    let result = fallback;
    const finish = (value: T) => { result = value; };
    const settle = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      db?.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      result = fallback;
      try { tx?.abort(); } catch { /* Already completed. */ }
      settle();
    }, options.timeoutMs ?? STORAGE_TIMEOUT_MS);
    try {
      const idb = factory();
      if (!idb) { settle(); return promise; }
      const open = idb.open("ompweb-recent-history", VERSION);
      open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: "key" }); };
      open.onblocked = open.onerror = () => { result = fallback; settle(); };
      open.onsuccess = () => {
        db = open.result;
        if (ended) { db.close(); return; }
        db.onversionchange = () => db?.close();
        try {
          tx = db.transaction(STORE, "readwrite");
          tx.oncomplete = settle;
          tx.onabort = tx.onerror = () => { result = fallback; settle(); };
          action(tx.objectStore(STORE), finish);
        } catch { result = fallback; settle(); }
      };
    } catch { result = fallback; settle(); }
    return promise;
  }
  return {
    async read(sessionId: string, view: RecentHistoryView, current: () => boolean = () => true): Promise<SessionContext | null> {
      const readEpoch = epoch;
      const key = keyFor(sessionId, view);
      return transact<SessionContext | null>(null, (store, finish) => {
        const request = store.get(key);
        request.onsuccess = () => {
          if (!current() || readEpoch !== epoch) return;
          const row: unknown = request.result;
          if (row === undefined) return;
          const context = isCacheRow(row) && row.key === key && row.sessionId === sessionId
            && row.writtenAt <= now() && now() - row.writtenAt < RECENT_CACHE_TTL_MS ? decodeRecentHistory(row.payload) : null;
          if (!context) { store.delete(key); return; }
          if (!isCacheRow(row)) return;
          store.put({ ...row, touchedAt: now() });
          finish(context);
        };
      }).then((context) => current() && readEpoch === epoch ? context : null);
    },
    async write(sessionId: string, view: RecentHistoryView, context: SessionContext, current: () => boolean = () => true): Promise<void> {
      const writeEpoch = epoch;
      await Promise.resolve();
      if (!current() || writeEpoch !== epoch) return;
      let payload: string | null;
      try { payload = encodeRecentHistory(context); } catch { payload = null; }
      const key = keyFor(sessionId, view);
      await transact(false, (store, finish) => {
        const rows: CacheRow[] = [];
        const scan = store.openCursor();
        scan.onsuccess = () => {
          if (!current() || writeEpoch !== epoch) return;
          const cursor = scan.result;
          if (cursor) {
            const row: unknown = cursor.value;
            if (isCacheRow(row) && row.key !== key && row.sessionId !== sessionId
              && row.writtenAt <= now() && now() - row.writtenAt < RECENT_CACHE_TTL_MS
              && decodeRecentHistory(row.payload)) rows.push(row);
            else cursor.delete();
            cursor.continue();
            return;
          }
          rows.sort((a, b) => b.touchedAt - a.touchedAt);
          let bytes = payload ? new TextEncoder().encode(payload).length : 0;
          let entries = payload ? 1 : 0;
          for (const row of rows) {
            bytes += row.bytes;
            entries += 1;
            if (bytes > RECENT_CACHE_TOTAL_BYTES || entries > RECENT_CACHE_MAX_ENTRIES) store.delete(row.key);
          }
          if (payload) store.put({ key, sessionId, version: VERSION, payload, bytes: new TextEncoder().encode(payload).length, writtenAt: now(), touchedAt: now() } satisfies CacheRow);
          finish(true);
        };
      });
    },
    async invalidate(sessionId: string): Promise<void> {
      // One scalar fences pending work without retaining session tombstones.
      epoch += 1;
      await transact(false, (store, finish) => {
        const scan = store.openCursor();
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (!cursor) { finish(true); return; }
          if (record(cursor.value) && cursor.value.sessionId === sessionId) cursor.delete();
          cursor.continue();
        };
      });
    },
    async clearAll(): Promise<void> {
      epoch += 1;
      await transact(false, (store, finish) => {
        store.clear();
        finish(true);
      });
    },
  };
}

export const recentHistoryCache = createRecentHistoryCache();

/** Call on sign-out as well as an authoritative authentication rejection. */
export function clearRecentHistoryCache(): Promise<void> {
  return recentHistoryCache.clearAll();
}
