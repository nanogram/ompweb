"use client";

import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { Compass, Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import type { DirectorClient } from "@/hooks/useDirector";
import type { DirectorProject } from "@/lib/director-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { comparableProjectPath } from "@/lib/comparable-path";

const buttonStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-hover)", color: "var(--text)", padding: "5px 9px", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" };
const projectKey = (project: DirectorProject) => `${project.hostId}:${comparableProjectPath(project.cwd)}`;

export function DirectorSidebarEntry({ director, selected, project, onSelectSession }: {
  director: DirectorClient;
  selected: boolean;
  project?: DirectorProject;
  onSelectSession: (session: SessionInfo) => void;
}) {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const status = director.status?.session ? director.status : await director.act({ action: "ensure", ...(project ? { project } : {}) });
      if (status.session) onSelectSession(status.session);
    } catch {
      // The shared client exposes the genuine request error below, including retry.
    } finally {
      setOpening(false);
    }
  };
  return <div style={{ flexShrink: 0, padding: "6px 10px 2px" }}>
    <button type="button" aria-label="Director" aria-current={selected ? "page" : undefined} disabled={opening || director.busy} onClick={() => void open()}
      style={{ ...buttonStyle, width: "100%", minHeight: 38, background: selected ? "var(--bg-selected)" : "transparent", textAlign: "left" }}>
      {opening ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Compass size={16} aria-hidden="true" style={{ color: "var(--accent)" }} />}
      <span style={{ flex: 1, fontWeight: 600 }}>Director</span>
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{director.status ? t(`director.status.${director.status.supervisor}`) : t("director.open")}</span>
    </button>
    {director.error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 11, paddingTop: 4, overflowWrap: "anywhere" }}>{director.error} <button type="button" style={buttonStyle} disabled={opening || director.busy} onClick={() => { if (director.status?.session) void director.refresh().catch(() => {}); else void open(); }}>{t("director.retry")}</button></div>}
  </div>;
}

/** Parent renders this in normal document flow only for the selected Director chat. */
export function DirectorControls({ director }: { director: DirectorClient }) {
  const { t } = useI18n();
  const { status, busy } = director;
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectReload, setProjectReload] = useState(0);
  const [draft, setDraft] = useState<DirectorProject[] | null>(null);
  const [saving, setSaving] = useState(false);
  const controlId = useId();
  const controlHelpId = useId();
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/projects", { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!Array.isArray(data.projects)) throw new Error(t("director.projectsFailed"));
        if (active) { setProjects(data.projects); setProjectsError(null); }
      } catch (cause) {
        if (active) setProjectsError(controller.signal.aborted ? t("director.projectsFailed") : String(cause instanceof Error ? cause.message : cause).slice(0, 500));
      } finally { clearTimeout(timeout); }
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [projectReload, t]);
  const choices = useMemo(() => {
    const options = new Map<string, { project: DirectorProject; label: string }>();
    for (const item of projects) {
      if (status && (item.hostId ?? "local") === "local" && comparableProjectPath(item.path) === comparableProjectPath(status.workspaceCwd)) continue;
      const project = { cwd: item.path, hostId: item.hostId ?? "local" };
      options.set(projectKey(project), { project, label: item.alias ? `${item.alias} — ${item.path}` : item.path });
    }
    for (const project of [...(status?.config.watchedProjects ?? []), ...(draft ?? [])]) {
      if (!options.has(projectKey(project))) options.set(projectKey(project), { project, label: project.cwd });
    }
    return [...options.values()];
  }, [projects, status, draft]);
  if (!status) return <div role="status" style={{ padding: 8 }}>{director.error ?? t("director.loading")}</div>;
  const watched = draft ?? status.config.watchedProjects;
  const changeScope = (project: DirectorProject, checked: boolean) => {
    setDraft(checked ? [...watched.filter((item) => projectKey(item) !== projectKey(project)), project] : watched.filter((item) => projectKey(item) !== projectKey(project)));
  };
  const saveScope = async () => {
    setSaving(true);
    try {
      await director.act({ action: "configure", patch: { watchedProjects: watched } });
      setDraft(null);
    } catch {
      // Keep the selection intact so a failed save is visible and retryable.
    } finally { setSaving(false); }
  };
  const failure = director.error ?? status.lastError;
  return <section aria-label={t("director.controls")} style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", padding: "7px 12px", fontSize: 12, minWidth: 0, maxHeight: "40dvh", overflow: "auto", overflowWrap: "anywhere" }}>
    <details>
      <summary className="ui-focus-ring" style={{ cursor: "pointer", padding: "4px 0" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t(status.mode === "control" ? "director.controlMode" : "director.observeOnly")}</span>
          <span role="status">{t(`director.status.${status.supervisor}`)}</span>
        </span>
      </summary>
      <div style={{ display: "flex", alignItems: "center", gap: "6px 12px", flexWrap: "wrap", minWidth: 0, marginTop: 8 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, maxWidth: "100%" }}>
          <ToggleSwitch id={controlId} checked={status.config.controlEnabled} disabled={busy || saving} aria-label={t("director.controlSessions")} aria-describedby={controlHelpId}
            onChange={(controlEnabled) => void director.act({ action: "configure", patch: { controlEnabled } }).catch(() => {})} />
          <label htmlFor={controlId} style={{ minWidth: 0, cursor: busy || saving ? "default" : "pointer" }}>{t("director.controlSessions")}</label>
        </div>
        <details style={{ minWidth: 0, maxWidth: "100%" }}>
          <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}>{t("director.scope", { count: status.config.watchedProjects.length })}</summary>
          <div style={{ display: "grid", gap: 6, padding: "8px 0", maxWidth: "min(100%, 640px)" }}>
            <span style={{ color: "var(--text-muted)" }}>{t("director.scopeHelp")}</span>
            {status.config.watchedProjects.length === 0 && <span>{t("director.zeroWatched")}</span>}
            {choices.map(({ project, label }) => <label key={projectKey(project)} style={{ display: "flex", alignItems: "flex-start", gap: 7, overflowWrap: "anywhere" }}>
              <input type="checkbox" checked={watched.some((item) => projectKey(item) === projectKey(project))} disabled={busy || saving} onChange={(event) => changeScope(project, event.target.checked)} />
              <span style={{ minWidth: 0 }}>{label} <span style={{ color: "var(--text-muted)" }}>({project.hostId})</span></span>
            </label>)}
            {projectsError && <div role="alert" style={{ color: "var(--status-error)" }}>{projectsError} <button style={buttonStyle} onClick={() => setProjectReload((value) => value + 1)}>{t("director.retry")}</button></div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={buttonStyle} disabled={!draft || busy || saving} onClick={() => void saveScope()}>{t("director.saveScope")}</button><button style={buttonStyle} disabled={!draft || saving} onClick={() => setDraft(null)}>{t("director.cancel")}</button></div>
          </div>
        </details>
        <button style={buttonStyle} disabled={busy || saving} onClick={() => void director.act({ action: "configure", patch: { enabled: true, paused: status.config.enabled && !status.config.paused } }).catch(() => {})}>
          {status.config.enabled && !status.config.paused ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
          {t(status.config.enabled && !status.config.paused ? "director.pause" : "director.resume")}
        </button>
        <button style={buttonStyle} disabled={busy || saving || status.supervisor === "reviewing" || !status.config.watchedProjects.length} onClick={() => void director.act({ action: "review" }).catch(() => {})}><RefreshCw size={13} aria-hidden="true" />{t("director.reviewNow")}</button>
        <span style={{ color: "var(--text-muted)" }}>{t("director.usage", { used: status.daily.reviews, cost: status.daily.costUsd === null ? t("director.unknownCost") : status.daily.costUsd.toFixed(2) })}</span>
      </div>
      <div id={controlHelpId} style={{ marginTop: 4, color: "var(--text-muted)" }}>{t("director.controlHelp")}</div>
      <div style={{ marginTop: 4, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{status.config.watchedProjects.length ? status.config.watchedProjects.map((project) => `${project.cwd} (${project.hostId})`).join(" · ") : t("director.zeroWatched")}</div>
    </details>
    {failure && <div role="alert" style={{ marginTop: 4, color: "var(--status-error)", overflowWrap: "anywhere" }}>{failure}</div>}
  </section>;
}
