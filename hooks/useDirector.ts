"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectorAction, DirectorStatus } from "@/lib/director-types";
import { subscribeSessionsChanged } from "@/lib/session-change-bus";

export interface DirectorClient {
  status: DirectorStatus | null;
  error: string | null;
  busy: boolean;
  refresh(): Promise<DirectorStatus>;
  act(action: DirectorAction): Promise<DirectorStatus>;
}

/** Status-only observer: never opens a session stream or advertises chat presence. */
export function useDirector(): DirectorClient {
  const [status, setStatus] = useState<DirectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const ensurePending = useRef<Promise<DirectorStatus> | null>(null);
  const refreshPending = useRef<Promise<DirectorStatus> | null>(null);
  const mutations = useRef(0);
  const revision = useRef(0);

  const request = useCallback(async (action?: DirectorAction): Promise<DirectorStatus> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), action ? 90_000 : 15_000);
    const owner = lifetime.current;
    const startedAt = revision.current;
    if (action) {
      revision.current++;
      mutations.current++;
      if (mounted.current) setBusy(true);
    }
    try {
      const response = await fetch("/api/director", {
        method: action ? "POST" : "GET",
        ...(action ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) } : {}),
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error.slice(0, 500) : `HTTP ${response.status}`);
      if (!data || (data.mode !== "observe" && data.mode !== "control") || !data.config || typeof data.workspaceCwd !== "string") throw new Error("Invalid Director response");
      const next = data as DirectorStatus;
      if (mounted.current && owner === lifetime.current && (action || (startedAt === revision.current && mutations.current === 0))) {
        // Polls and unrelated session writes often return the same JSON snapshot.
        // Retain its identity so they do not repaint the shell and sidebar.
        setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        setError(null);
      }
      return next;
    } catch (cause) {
      const failure = new Error(controller.signal.aborted ? "Director request timed out or was cancelled" : (cause instanceof Error ? cause.message : String(cause)).slice(0, 500));
      if (mounted.current && owner === lifetime.current && (action || startedAt === revision.current)) setError(failure.message);
      throw failure;
    } finally {
      clearTimeout(timer);
      controllers.current.delete(controller);
      if (action) {
        mutations.current--;
        revision.current++;
        if (mounted.current && owner === lifetime.current) setBusy(mutations.current > 0);
      }
    }
  }, []);

  const refresh = useCallback((): Promise<DirectorStatus> => {
    if (refreshPending.current) return refreshPending.current;
    const pending = request().finally(() => { if (refreshPending.current === pending) refreshPending.current = null; });
    refreshPending.current = pending;
    return pending;
  }, [request]);

  const act = useCallback((action: DirectorAction): Promise<DirectorStatus> => {
    if (action.action !== "ensure") return request(action);
    if (ensurePending.current) return ensurePending.current;
    const pending = request(action).finally(() => { if (ensurePending.current === pending) ensurePending.current = null; });
    ensurePending.current = pending;
    return pending;
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    const owner = lifetime.current;
    const pendingControllers = controllers.current;
    const refreshVisible = () => {
      if (document.visibilityState === "visible" && mutations.current === 0) void refresh().catch(() => {});
    };
    refreshVisible();
    const timer = setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    const unsubscribe = subscribeSessionsChanged(refreshVisible);
    return () => {
      mounted.current = false;
      lifetime.current = owner + 1;
      refreshPending.current = null;
      ensurePending.current = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      unsubscribe();
      for (const controller of pendingControllers) controller.abort();
    };
  }, [refresh]);

  return useMemo(() => ({ status, error, busy, refresh, act }), [status, error, busy, refresh, act]);
}
