import type { SessionInfo } from "./types";
import type { SessionActivityStatus } from "./session-activity";

export interface DirectorProject {
  cwd: string;
  hostId: string;
}

export interface DirectorConfig {
  enabled: boolean;
  paused: boolean;
  controlEnabled: boolean;
  watchedProjects: DirectorProject[];
  minReviewIntervalMs: number;
}

export interface DirectorSessionSummary {
  id: string;
  name: string;
  cwd: string;
  hostId: string;
  status: SessionActivityStatus;
  updatedAt: number;
  detail?: string;
  lastAssistantText?: string;
}

/** One installation-owned chat; never a workspace row or a task subagent. */
export interface DirectorStatus {
  mode: "observe" | "control";
  config: DirectorConfig;
  session: SessionInfo | null;
  workspaceCwd: string;
  supervisor: "disabled" | "watching" | "paused" | "reviewing" | "offline" | "error";
  monitored: DirectorSessionSummary[];
  lastReviewAt: string | null;
  nextReviewAt: string | null;
  lastError: string | null;
  daily: { date: string; reviews: number; costUsd: number | null };
}

export type DirectorConfigPatch = Partial<DirectorConfig>;

/** Mutations require same-origin authenticated POST; status GET never creates a chat. */
export type DirectorAction =
  | { action: "ensure"; project?: DirectorProject }
  | { action: "configure"; patch: DirectorConfigPatch }
  | { action: "review" };
