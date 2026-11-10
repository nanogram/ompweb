import { COMPOSER_MODELS_STORAGE_KEY, isComposerModelKeys, type ComposerModelKeys } from "./composer-model-visibility";
import { isRecord } from "./type-guards";

export interface ComposerModelPreferenceSnapshot {
  keys: ComposerModelKeys;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

interface PreferenceClient {
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
}

/** One request at a time per viewer; a cached subset is provisional, never authority. */
export function createComposerModelPreferenceStore({ request, storage }: PreferenceClient) {
  let legacy: string[] | undefined;
  try {
    const cached: unknown = JSON.parse(storage?.().getItem(COMPOSER_MODELS_STORAGE_KEY) ?? "null");
    if (Array.isArray(cached) && isComposerModelKeys(cached)) legacy = cached;
  } catch {
    // Invalid/unavailable local storage cannot turn a failed server load into show-all.
  }
  let snapshot: ComposerModelPreferenceSnapshot = {
    keys: legacy ?? [], ready: false, loading: true, saving: false, error: null,
  };
  let confirmed = false;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ComposerModelPreferenceSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const read = async (init?: RequestInit): Promise<ComposerModelKeys | undefined> => {
    const response = await request("/api/web-settings", { cache: "no-store", ...init });
    const data: unknown = await response.json();
    if (!response.ok || !isRecord(data) || data.error) {
      throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
    }
    if (data.composerModelKeys !== undefined && !isComposerModelKeys(data.composerModelKeys)) {
      throw new Error("Invalid shared composer model visibility response");
    }
    return data.composerModelKeys as ComposerModelKeys | undefined;
  };
  const put = (keys: ComposerModelKeys, onlyIfUnset = false) => read({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composerModelKeys: keys, ...(onlyIfUnset ? { composerModelKeysIfUnset: true } : {}) }),
  });
  const accept = (keys: ComposerModelKeys | undefined) => {
    if (keys === undefined && confirmed) throw new Error("The shared composer model preference is unavailable");
    if (keys !== undefined) {
      confirmed = true;
      legacy = undefined;
      try {
        storage?.().setItem(COMPOSER_MODELS_STORAGE_KEY, JSON.stringify(keys));
      } catch {
        // Persistence is server-owned; an unavailable cache does not make a save fail.
      }
    }
    publish({ keys: keys ?? null, ready: true, loading: false, saving: false, error: null });
  };
  const fail = (error: unknown) => publish({
    loading: false, saving: false,
    error: error instanceof Error ? error.message : String(error),
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh(): Promise<void> {
      if (pending) return pending;
      publish({ loading: true });
      pending = (async () => {
        try {
          let keys = await read();
          // Never publish null/all at startup. Only a valid legacy array (including
          // []) may claim an unset server, and its conditional response is authority.
          if (keys === undefined && legacy !== undefined && !confirmed) {
            keys = await put(legacy, true);
            if (keys === undefined) throw new Error("The server did not confirm the migrated composer model preference");
          }
          accept(keys);
        } catch (error) {
          fail(error);
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    save(keys: ComposerModelKeys): Promise<void> {
      if (pending || !snapshot.ready || snapshot.error) return pending ?? Promise.resolve();
      publish({ saving: true });
      pending = (async () => {
        try {
          const saved = await put(keys);
          if (saved === undefined) throw new Error("The server did not confirm the composer model preference");
          accept(saved);
        } catch (error) {
          fail(error);
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
  };
}

export const composerModelPreference = createComposerModelPreferenceStore({
  request: (...args) => fetch(...args),
  storage: () => window.localStorage,
});
