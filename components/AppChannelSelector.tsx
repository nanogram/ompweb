"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AppChannel, AppChannelRelease, AppChannelStatus } from "@/lib/app-channel";
import { useI18n } from "@/lib/i18n";

const reloadPage = () => window.location.reload();
const RESTART_KEY = "ompweb-channel-restart";

export function isAppChannelRestartComplete(status: AppChannelStatus, target: AppChannelRelease): boolean {
  return status.supported && !status.restarting && !status.preparing && !status.restartRequired && !status.error
    && status.active.channel === target.channel && status.active.version === target.version && status.active.revision === target.revision
    && status.selected.channel === target.channel && status.selected.version === target.version && status.selected.revision === target.revision;
}

function readRestartTarget(): AppChannelRelease | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESTART_KEY) ?? "null");
    return value && (value.channel === "main" || value.channel === "fork") && typeof value.version === "string"
      && (value.revision === null || typeof value.revision === "string") ? value : null;
  } catch { return null; }
}
function rememberRestart(target: AppChannelRelease | null) {
  try {
    if (target) sessionStorage.setItem(RESTART_KEY, JSON.stringify(target));
    else sessionStorage.removeItem(RESTART_KEY);
  } catch { /* Reconnect still works when browser storage is unavailable. */ }
}

export function AppChannelSelector({ reload = reloadPage }: { reload?: () => void } = {}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const [status, setStatus] = useState<AppChannelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartTarget, setRestartTarget] = useState<AppChannelRelease | null>(null);
  const mounted = useRef(false);
  const requestInFlight = useRef(false);
  const mutationInFlight = useRef(false);
  const requestGeneration = useRef(0);

  const receive = useCallback((next: AppChannelStatus) => {
    setStatus(next);
    setError(null);
    if (next.restarting) {
      setRestartTarget(next.selected);
      rememberRestart(next.selected);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (requestInFlight.current || mutationInFlight.current) return;
    requestInFlight.current = true;
    const generation = requestGeneration.current;
    try {
      const response = await fetch("/api/app-channel", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || t("appChannel.loadFailed"));
      if (mounted.current && generation === requestGeneration.current) receive(value);
    } catch (cause) {
      if (mounted.current && generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : t("appChannel.loadFailed"));
    } finally { requestInFlight.current = false; }
  }, [receive, t]);

  useEffect(() => {
    mounted.current = true;
    setRestartTarget(readRestartTarget());
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const polling = Boolean(status?.preparing || status?.restarting || restartTarget);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  useEffect(() => {
    if (!status || !restartTarget) return;
    if (!status.supported) {
      rememberRestart(null);
      setRestartTarget(null);
      return;
    }
    if (isAppChannelRestartComplete(status, restartTarget)) {
      rememberRestart(null);
      setRestartTarget(null);
      reload();
    } else if (!status.restarting && status.error) {
      // A failed candidate may have rolled back. Keep its error and allow retry.
      rememberRestart(null);
      setRestartTarget(null);
    }
  }, [status, restartTarget, reload]);

  async function act(action: "select" | "restart", channel?: AppChannel) {
    if (!status || mutationInFlight.current) return;
    mutationInFlight.current = true;
    requestGeneration.current += 1;
    setBusy(true);
    setError(null);
    setStatus({ ...status, error: null });
    if (action === "restart") {
      setRestartTarget(status.selected);
      rememberRestart(status.selected);
    }
    try {
      const response = await fetch("/api/app-channel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "select" ? { action, channel } : { action }),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await response.json();
      if (!response.ok) {
        if (action === "restart") { setRestartTarget(null); rememberRestart(null); }
        throw new Error(value.error || t("appChannel.actionFailed"));
      }
      if (mounted.current) receive(value);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("appChannel.actionFailed"));
      // A dropped restart response is ambiguous: reconnect until the manager confirms.
    } finally {
      mutationInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const channelLabel = (channel: AppChannel) => t(channel === "main" ? "appChannel.main" : "appChannel.fork");
  const describeRelease = (release: AppChannelRelease) => `${channelLabel(release.channel)} · v${release.version}${release.revision ? ` · ${release.revision.slice(0, 12)}` : ""}`;
  const disabled = !status?.supported || busy || Boolean(status.preparing || status.restarting || restartTarget);
  const selected = status?.preparing?.channel ?? status?.selected.channel;
  const issue = error || status?.error;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <fieldset disabled={disabled} aria-describedby={descriptionId} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("appChannel.label")}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(["main", "fork"] as const).map((channel) => (
            <label key={channel} style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 160px", minHeight: 44, padding: "8px 12px", boxSizing: "border-box", border: `1px solid ${selected === channel ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-control)", cursor: disabled ? "not-allowed" : "pointer", fontSize: 13 }}>
              <input type="radio" name={descriptionId} value={channel} checked={selected === channel} onChange={() => void act("select", channel)} />
              {channelLabel(channel)}
            </label>
          ))}
        </div>
      </fieldset>
      <p id={descriptionId} style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>{t("appChannel.description")}</p>
      {status ? (
        <div style={{ fontSize: 12, overflowWrap: "anywhere", display: "flex", flexDirection: "column", gap: 5 }}>
          <div>{t("appChannel.active", { release: describeRelease(status.active) })}</div>
          <div>{t("appChannel.selected", { release: describeRelease(status.selected) })}</div>
          {!status.supported && <div role="note">{status.reason || t("appChannel.unsupported")}</div>}
          <div role="status" aria-live="polite">
            {status.preparing ? t("appChannel.preparing", { channel: channelLabel(status.preparing.channel), stage: status.preparing.stage })
              : status.restarting || restartTarget ? t("appChannel.restarting")
                : status.restartRequired ? t("appChannel.ready") : null}
          </div>
        </div>
      ) : <div role="status">{t("appChannel.loading")}</div>}
      {issue && <div role="alert" style={{ fontSize: 12, overflowWrap: "anywhere", color: "var(--status-error)" }}>{issue}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {status?.supported && status.restartRequired && !status.preparing && !status.restarting && (
          <button type="button" disabled={busy} onClick={() => void act("restart")} style={{ minHeight: 44, padding: "8px 12px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", cursor: busy ? "wait" : "pointer" }}>{t("appChannel.restart")}</button>
        )}
        {issue && <button type="button" disabled={busy} onClick={() => void refresh()} style={{ minHeight: 44, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)" }}>{t("appChannel.refresh")}</button>}
      </div>
    </div>
  );
}
