import { AgentToolGuard } from "./agent-tools";
import { comparableProjectPath } from "./comparable-path";
import { executeDirectorControlTool, isDirectorTargetSelected, type DirectorControllableSession, type DirectorControlContext } from "./director-control";
import { getDirectorWorkspaceCwd, isDirectorWorkspace, readDirectorState } from "./director-state";
import { getHost } from "./hosts/hub";
import { isLinkUp } from "./hosts/host";
import { hostSessions } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { getLiveRpcSessionIds, getRpcSession, getSessionActivities, startRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import type { WebSessionState } from "./pi-types";
import type { SessionInfo } from "./types";

declare global { var __ompDirectorControlGuard: AgentToolGuard | undefined; }
const guard = () => (globalThis.__ompDirectorControlGuard ??= new AgentToolGuard());
const keyOf = (id: string, hostId: string) => `${hostId}/${id}`;

/** Permissions come from private installation state, never model arguments or worker output. */
function contextFor(sourceSessionId: string, mutate: boolean): DirectorControlContext {
  const state = readDirectorState();
  const source = getRpcSession(sourceSessionId);
  if (state.session?.id !== sourceSessionId || !source?.isAlive() || source.sessionId !== sourceSessionId
    || source.host.id !== LOCAL_HOST_ID || !isDirectorWorkspace(source.cwd)) throw new Error("Only the dedicated Director can control sessions.");
  if (mutate && (!state.config.enabled || state.config.paused || !state.config.controlEnabled)) {
    throw new Error("Director control is disabled or paused; no session was changed.");
  }
  return { sourceSessionId, workspaceCwd: getDirectorWorkspaceCwd(), config: state.config, guard: guard() };
}

async function listSessions(sourceSessionId: string): Promise<DirectorControllableSession[]> {
  const context = contextFor(sourceSessionId, false);
  const hostIds = [...new Set(context.config.watchedProjects.map((project) => project.hostId))];
  const lists = await Promise.all(hostIds.map((id) => hostSessions(id)));
  const activities = new Map(getSessionActivities().map((activity) => [keyOf(activity.id, activity.hostId ?? LOCAL_HOST_ID), activity]));
  const rows = new Map<string, DirectorControllableSession>();
  for (let index = 0; index < hostIds.length; index++) {
    for (const session of lists[index]) {
      const hostId = hostIds[index];
      const activity = activities.get(keyOf(session.id, hostId));
      rows.set(keyOf(session.id, hostId), {
        id: session.id, hostId, cwd: session.cwd, projectRoot: session.projectRoot,
        name: session.name || session.firstMessage || session.id, status: activity?.status ?? session.activityStatus ?? "idle",
      });
    }
  }
  for (const id of getLiveRpcSessionIds()) {
    const live = getRpcSession(id);
    if (!live?.isAlive() || live.sessionId !== id || !hostIds.includes(live.host.id)) continue;
    const key = keyOf(id, live.host.id);
    const previous = rows.get(key);
    const activity = live.getActivity();
    rows.set(key, {
      ...previous, id, hostId: live.host.id, cwd: live.cwd,
      status: activity?.status === "waiting_input" ? "waiting_input" : live.isRunning() ? "running" : activity?.status ?? previous?.status ?? "idle",
    });
  }
  return [...rows.values()];
}

function requireTarget(sourceSessionId: string, target: DirectorControllableSession): void {
  if (!isDirectorTargetSelected(target, contextFor(sourceSessionId, true))) throw new Error("Target is outside the Director's current selected projects.");
}

function requireIdentity(wrapper: AgentSessionWrapper, target: DirectorControllableSession): void {
  if (!wrapper.isAlive() || wrapper.sessionId !== target.id || wrapper.host.id !== target.hostId
    || comparableProjectPath(wrapper.cwd) !== comparableProjectPath(target.cwd) || getRpcSession(target.id) !== wrapper) {
    throw new Error("Target session identity changed; refresh the session list before directing it.");
  }
}

/** Authoritative owner metadata precedes every cold resume; cached lists cannot authorize a write. */
async function openTarget(sourceSessionId: string, expected: DirectorControllableSession): Promise<{ wrapper: AgentSessionWrapper; target: DirectorControllableSession; cold: boolean }> {
  contextFor(sourceSessionId, true);
  const host = getHost(expected.hostId);
  if (!host || !isLinkUp(host.status())) throw new Error("Target host is offline; no control command was sent.");
  const live = getRpcSession(expected.id);
  if (live && (live.sessionId !== expected.id || live.host.id !== expected.hostId)) throw new Error("Target session moved; refresh its exact identity before directing it.");
  const current = live?.isAlive() ? live : undefined;
  const listed = await host.sessionOps.listSessions();
  const info: SessionInfo | undefined = listed.find((session) => session.id === expected.id);
  const cwd = current?.cwd ?? info?.cwd;
  if (!cwd || comparableProjectPath(cwd) !== comparableProjectPath(expected.cwd)) throw new Error("Target session is missing or changed its workspace.");
  const validated = await host.sessionOps.validateCwd(cwd);
  if (!validated.ok) throw new Error(validated.error);
  const target = { ...expected, cwd, projectRoot: validated.value.projectRoot || validated.value.cwd };
  requireTarget(sourceSessionId, target);
  if (current) {
    requireIdentity(current, target);
    return { wrapper: current, target, cold: false };
  }
  if (!info?.path || !await host.sessionFileExists(info.path)) throw new Error("The existing target transcript is unavailable; no replacement session was created.");
  requireTarget(sourceSessionId, target);
  const started = await startRpcSession(expected.id, info.path, cwd, undefined, undefined, info.cwd, undefined, host, true);
  requireIdentity(started.session, target);
  if (started.realSessionId !== expected.id) throw new Error("The resumed session did not preserve its identity; no command was sent.");
  return { wrapper: started.session, target, cold: true };
}

async function controlTarget(sourceSessionId: string, expected: DirectorControllableSession, action: "resume" | "stop" | "prompt" | "steer" | "followUp", message?: string): Promise<unknown> {
  const { wrapper, target, cold } = await openTarget(sourceSessionId, expected);
  return wrapper.withPendingCommand(async () => {
    requireTarget(sourceSessionId, target);
    requireIdentity(wrapper, target);
    const native = await wrapper.send({ type: "get_state" }) as WebSessionState;
    requireTarget(sourceSessionId, target);
    requireIdentity(wrapper, target);
    if (wrapper.isEditingHistory()) throw new Error("Target history is being edited; no control command was sent.");
    const waiting = native.activity?.status === "waiting_input" || wrapper.getActivity()?.status === "waiting_input";
    const running = wrapper.isRunning() || native.isStreaming || native.isPromptRunning || native.isBashRunning || native.isCompacting;
    if (action === "resume") return { accepted: true, action, targetSessionId: target.id, hostId: target.hostId, running, waitingForHuman: waiting };
    if (action !== "stop" && waiting) throw new Error("Target is waiting for human input; Director cannot answer or bypass questions or approvals.");
    if (action !== "stop" && native.isCompacting) throw new Error("Target is compacting; wait before directing another turn.");
    if (action === "prompt" && running) throw new Error("Target is running; use steer or followUp instead of starting another turn.");
    if (action === "steer" && !running) throw new Error("Target is inactive; use message to start its next turn.");
    if (action === "stop" && !running && !waiting) throw new Error("Target has no active turn to stop.");
    try {
      await wrapper.send(action === "stop" ? { type: "abort" }
        : action === "followUp" ? { type: "prompt", message, streamingBehavior: "followUp" }
        : { type: action, message });
    } catch (error) {
      throw new Error(`Director command was not acknowledged and its delivery may be uncertain. Do not retry blindly; inspect the target first. ${error instanceof Error ? error.message : String(error)}`);
    }
    return { accepted: true, action: action === "prompt" ? "message" : action, targetSessionId: target.id, hostId: target.hostId };
  }, cold);
}

/** Invoked only by the local Director's server-owned host-tool dispatcher, never a browser. */
export async function executeDirectorRuntimeTool(sourceSessionId: string, name: string, args: unknown): Promise<unknown> {
  return executeDirectorControlTool(name, args, contextFor(sourceSessionId, false), {
    listSessions: () => listSessions(sourceSessionId),
    resume: (target) => controlTarget(sourceSessionId, target, "resume"),
    deliver: (target, delivery, message) => controlTarget(sourceSessionId, target, delivery, message),
    stop: (target) => controlTarget(sourceSessionId, target, "stop"),
  });
}
