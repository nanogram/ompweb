export type SessionActivityStatus = "idle" | "running" | "waiting_input" | "completed" | "error" | "quota" | "interrupted";

/** Latest observed run state, independent of operational running and unread state. */
export interface SessionActivity {
  id: string;
  cwd: string;
  /** Absent for this machine, matching RunningRpcSession and SessionInfo. */
  hostId?: string;
  status: SessionActivityStatus;
  detail?: string;
  updatedAt: number;
}
