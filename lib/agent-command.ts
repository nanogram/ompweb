import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, getRpcSessionKeys, WebRpcError, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { sessionSpawnTarget } from "@/lib/hosts/session-index";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { attachUploads, forgetUploads, takeUploads, type OutboxUploadReceipt } from "@/lib/uploads";
import { runOutboxCommand } from "@/lib/message-outbox";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isRecord } from "@/lib/type-guards";
import { directorCommandError } from "./director-policy";
import { isDirectorSession } from "./director-state";

export interface AgentSelection {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Fresh/first-prompt envelope fields, never additions to the native prompt RPC. */
export function readAgentSelection(value: Record<string, unknown>): AgentSelection {
  const { provider, modelId, thinkingLevel } = value;
  if ((provider !== undefined || modelId !== undefined)
    && (typeof provider !== "string" || typeof modelId !== "string" || !provider || !modelId
      || provider.startsWith("-") || modelId.startsWith("-") || /\s/.test(provider) || /\s/.test(modelId))) {
    throw new WebRpcError("provider and modelId must identify a model", "invalid_model");
  }
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !thinkingLevel.trim())) {
    throw new WebRpcError("thinkingLevel must be a non-empty string", "invalid_thinking_level");
  }
  return { provider: provider as string | undefined, modelId: modelId as string | undefined, thinkingLevel: thinkingLevel as string | undefined };
}

/** A cold model override can succeed at spawn even when the following RPC spuriously refuses it (#277). */
async function setSelectedModel(session: AgentSessionWrapper, provider: string, modelId: string, boundAtSpawn: boolean, nativeCommand?: Record<string, unknown>): Promise<unknown> {
  try {
    return await session.send(nativeCommand ?? { type: "set_model", provider, modelId });
  } catch (error) {
    if (!boundAtSpawn || ((error instanceof WebRpcError || error instanceof HostOpError) && error.code === "host_offline")) throw error;
    const state = await session.send({ type: "get_state" });
    if (isRecord(state) && isRecord(state.model) && state.model.provider === provider && state.model.id === modelId) {
      return { id: modelId, provider };
    }
    throw error;
  }
}

export async function applyAgentSelection(session: AgentSessionWrapper, selection: AgentSelection, boundAtSpawn = false): Promise<void> {
  if (selection.provider && selection.modelId) await setSelectedModel(session, selection.provider, selection.modelId, boundAtSpawn);
  if (selection.thinkingLevel) await session.send({ type: "set_thinking_level", level: selection.thinkingLevel });
}

async function captureRunBoundary(session: AgentSessionWrapper): Promise<string[]> {
  const result = await session.host.sessionOps.readContext(session.sessionId, undefined, {
    boundary: true, deferThinking: true, deferMedia: true, includePreCompaction: false, sync: null,
  });
  if (result.ok && isRecord(result.value) && Array.isArray(result.value.entryIds)
    && result.value.entryIds.every((id) => typeof id === "string")) return result.value.entryIds;
  if (!result.ok && result.status === 404
    && (!session.sessionFile || !(await session.host.sessionFileExists(session.sessionFile)))) return [];
  if (!result.ok && result.code === "host_offline") throw new WebRpcError(result.error, result.code, "refused");
  if (!result.ok) throw new HostOpError(result.status, result.code, result.error);
  throw new WebRpcError("The host returned an invalid transcript boundary", "invalid_run_boundary");
}

// Commands that ride whatever child is alive and never spawn or replace one:
// keystroke predictions, and the side-question reads/cancel omp-web sends in
// the background (SSE connect, reconcile). Without a live process there is no
// ghost text, no running side question and nothing to cancel, so the reply is
// known without omp. Asking (`btw`) and opening the history start omp first.
export const NO_SPAWN_REPLIES: Record<string, unknown> = {
  predict_word: { suffix: null },
  predict_word_feedback: null,
  get_btw_history: { records: [] },
  btw_cancel: { cancelled: false },
  dismiss_queue_progress: null,
};

// Live diagnostics of a skill-resolving omp. A saved or exited session has none,
// and resuming a full child (MCP, LSP) just to answer a read-only inspection or
// flip one setting is not what the click asked for: with no live wrapper these
// answer 409 instead of starting omp, and a live idle child is never replaced
// because the advisor flag differs.
const LIVE_SESSION_ONLY = new Set(["get_skill_diagnostics", "set_skill_startup_diagnostics"]);

/** omp-web's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
export function commandErrorResponse(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if (error instanceof WebRpcError && error.code !== "host_offline") {
    return Response.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof RpcCommandError) {
    return Response.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  return apiErrorResponse(error);
}

declare global {
  var __ompSendFences: Map<string, Promise<void>> | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function sendFences(): Map<string, Promise<void>> {
  return (globalThis.__ompSendFences ??= new Map());
}

/** Everything POST /api/agent/[id] does once the body is parsed; shared with
 * the browser socket. `owner`: the caller's web session (lib/web-auth.ts
 * `requestOwner`), whose uploads a prompt may attach. Never throws: failures
 * become `commandErrorResponse`. */
export async function runAgentCommand(id: string, body: unknown, advisor: boolean, owner: string, trustedUploads?: OutboxUploadReceipt[]): Promise<Response> {
  let release = () => {}; // frees this command's send fence; idempotent
  try {
    // Attachment preparation, native-write tracking and reply correlation share this exact object.
    const command = body as { type?: unknown; [key: string]: unknown } | null;
    if (typeof command?.type !== "string" || !command.type.trim()) {
      return Response.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }
    const type = command.type;
    const liveDirector = getRpcSession(id);
    const directorError = directorCommandError(id, liveDirector?.cwd, command, liveDirector?.host.id);
    if (directorError) throw new WebRpcError(directorError, "director_read_only");
    if ((!liveDirector || liveDirector.host.id === "local") && isDirectorSession(id, liveDirector?.cwd)) advisor = false;
    const selection: AgentSelection = type === "prompt" ? readAgentSelection(command) : {};
    const captureBoundary = type === "prompt" && command.captureRunBoundary === true;
    if (type === "prompt") {
      delete command.provider;
      delete command.modelId;
      delete command.thinkingLevel;
      delete command.captureRunBoundary;
    }
    let runBoundary: string[] | undefined;
    const success = (data: unknown) => Response.json({ success: true, data, ...(runBoundary !== undefined ? { runBoundary } : {}) });
    // Held messages: stored and answered here; the outbox's dispatcher sends them to omp (lib/message-outbox.ts).
    if (type === "outbox_add" || type === "outbox_remove" || type === "outbox_scope") return await runOutboxCommand(id, command, advisor, owner);
    // Attached files go to the session's host first; nothing reaches omp when one fails (spec U3).
    const uploads = takeUploads(command, owner, trustedUploads);
    const preparesPrompt = Boolean(uploads || captureBoundary || selection.provider || selection.thinkingLevel);
    // Hold later wrapper selection as well as dispatch behind attachment preparation, so an
    // advisor toggle cannot replace the child and a Stop cannot overtake the preparing prompt.
    // A moved session answers to several ids: a command through any of them waits.
    const held = getRpcSessionKeys(id).flatMap((key) => sendFences().get(key) ?? []);
    const prior = held.length ? Promise.all(held).then(() => {}) : undefined;
    if (preparesPrompt) {
      const gate = Promise.withResolvers<void>();
      release = gate.resolve;
      const fence = prior ? prior.then(() => gate.promise) : gate.promise;
      sendFences().set(id, fence);
      void fence.then(() => {
        if (sendFences().get(id) === fence) sendFences().delete(id);
      });
    }
    if (prior) await prior;
    const send = async (session: AgentSessionWrapper, boundAtSpawn = false) => {
      if (!preparesPrompt) return session.send(command);
      return session.withPendingCommand(async () => {
        let sending: Promise<unknown>;
        try {
          await applyAgentSelection(session, selection, boundAtSpawn);
          if (uploads) await attachUploads(uploads.ids, owner, session, command, uploads.receipts);
          if (captureBoundary) runBoundary = await captureRunBoundary(session);
          sending = session.send(command);
        } finally {
          release();
        }
        const result = await sending;
        if (uploads) forgetUploads(uploads.ids, owner, uploads.receipts);
        return result;
      });
    };

    // Fast path: already-running session. --advisor is a spawn-time flag with
    // no runtime RPC, so a toggle that now differs from the live child's spawn
    // flag must replace an idle child to take effect; busy children keep
    // running and pick the flag up at the next natural respawn.
    const existing = getRpcSession(id);
    let resumeId = id;
    let resumeHost: AgentSessionWrapper["host"] | undefined;
    const noSpawn = Object.hasOwn(NO_SPAWN_REPLIES, type);
    const liveOnly = LIVE_SESSION_ONLY.has(type);
    if (existing?.isAlive()) {
      if (noSpawn || liveOnly || (existing.adopted && !existing.hostOwnedLifecycle)
        || existing.advisorSpawned === (advisor === true || existing.launchAdvisor === true) || existing.isRunning() || existing.isEditingHistory()) {
        const result = await send(existing);
        return success(result);
      }
      // Disposing a child behind a down link would wait for the link to return.
      const offline = hostOfflineResponse(existing.host);
      if (offline) return offline;
      resumeId = existing.sessionId;
      resumeHost = existing.host;
      if (!existing.hostOwnedLifecycle) await existing.destroyAndWait("advisor", true);
    }
    if (noSpawn) return Response.json({ success: true, data: NO_SPAWN_REPLIES[type] });
    if (liveOnly) {
      return Response.json(
        { error: "Skill diagnostics require a running session", code: "skill_diagnostics_unavailable" },
        { status: 409 },
      );
    }

    const resolved = resumeHost ? { host: resumeHost } : await resolveSessionHostOr404(resumeId);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    const offline = hostOfflineResponse(host);
    if (offline) return offline;
    const target = await sessionSpawnTarget(resumeId, host);
    if (!target) return Response.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });

    // A cold set_model must reach omp before the saved model is restored:
    // spawning with only --resume lets omp exit on an unrestorable saved
    // model before the RPC below ever runs (#277). Binding the requested
    // model at spawn time skips that restore check. Live children never
    // reach this path (they take the fast path above), and any other command
    // keeps the previous spawn behavior.
    const modelSelection = type === "prompt" ? selection : command;
    const spawnModel =
      (type === "set_model" || type === "prompt") &&
      typeof modelSelection.provider === "string" &&
      typeof modelSelection.modelId === "string" &&
      modelSelection.provider.trim() &&
      modelSelection.modelId.trim() &&
      !modelSelection.provider.startsWith("-") &&
      !modelSelection.modelId.startsWith("-") &&
      !/\s/.test(modelSelection.provider) &&
      !/\s/.test(modelSelection.modelId)
        ? `${modelSelection.provider}/${modelSelection.modelId}`
        : undefined;

    const { session } = await startRpcSession(id, target.sessionFile, target.cwd, undefined, advisor, target.recordedCwd, spawnModel, host, true);
    // This command inherits the open's preparation lease, so the shared child cannot idle out before it is sent.
    return await session.withPendingCommand(async () => {
      if (type === "set_model" && spawnModel) {
        const result = await setSelectedModel(session, command.provider as string, command.modelId as string, true, command);
        return success(result);
      }
      const result = await send(session, Boolean(spawnModel));
      return success(result);
    }, true);
  } catch (error) {
    return commandErrorResponse(error);
  } finally {
    release();
  }
}
