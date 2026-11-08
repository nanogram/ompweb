import type { RememberedSession } from "./workspace-memory";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  hostId?: string;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">, remembered: RememberedSession | null = null): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const explicitSession = searchParams.get("session");
  const explicitWorkspace = searchParams.get("cwd") !== null;
  const fallback = explicitSession === null && !explicitWorkspace ? remembered : null;
  const hostId = fallback ? fallback.hostId ?? "local" : searchParams.get("hostId") ?? undefined;
  return {
    requestedCwd,
    sessionId: requestedCwd ? null : explicitSession ?? fallback?.sessionId ?? null,
    ...(hostId ? { hostId } : {}),
  };
}
