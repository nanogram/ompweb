import type { SessionInfo } from "./types";

const LAST_VIEWED_SESSION_KEY = "omp-web:last-viewed-session";
const RESTORE_LAST_CHAT_KEY = "omp-web:restore-last-chat";

export interface RememberedSession {
  sessionId: string;
  hostId?: string;
  workspace?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}


export function workspaceKeyOf(session: Pick<SessionInfo, "cwd" | "projectRoot" | "projectKey">): string {
  return session.projectKey || session.projectRoot || session.cwd || "";
}


export function getRestoreLastChat(storage: StorageLike | null = browserStorage()): boolean {
  try { return storage?.getItem(RESTORE_LAST_CHAT_KEY) === "true"; } catch { return false; }
}

export function setRestoreLastChat(enabled: boolean, storage: StorageLike | null = browserStorage()): void {
  try { storage?.setItem(RESTORE_LAST_CHAT_KEY, String(enabled)); } catch { /* Browser-local convenience. */ }
}

export function getLastViewedSession(storage: StorageLike | null = browserStorage()): RememberedSession | null {
  try {
    const raw = storage?.getItem(LAST_VIEWED_SESSION_KEY);
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // The deployed browser remembered a raw id before hosts existed.
      // Upgrade once; the authoritative session lookup will fill its workspace.
      const sessionId = raw.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) return null;
      const migrated: RememberedSession = { sessionId, hostId: "local" };
      setLastViewedSession(migrated, storage);
      return migrated;
    }
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<RememberedSession>;
    if (typeof item.sessionId !== "string" || !item.sessionId || (item.workspace !== undefined && typeof item.workspace !== "string")) return null;
    if (item.hostId !== undefined && typeof item.hostId !== "string") return null;
    return { sessionId: item.sessionId, ...(item.workspace !== undefined ? { workspace: item.workspace } : {}), ...(item.hostId ? { hostId: item.hostId } : {}) };
  } catch { return null; }
}

export function setLastViewedSession(session: RememberedSession, storage: StorageLike | null = browserStorage()): void {
  try { storage?.setItem(LAST_VIEWED_SESSION_KEY, JSON.stringify(session)); } catch { /* Browser-local convenience. */ }
}

export function clearLastViewedSession(sessionId: string, storage: StorageLike | null = browserStorage()): void {
  if (getLastViewedSession(storage)?.sessionId !== sessionId) return;
  try { storage?.removeItem(LAST_VIEWED_SESSION_KEY); } catch { /* A stale tab must not erase a newer pointer. */ }
}
