import { createHash } from "node:crypto";
import { applyAgentSelection, commandErrorResponse, runAgentCommand, type AgentSelection } from "./agent-command";
import { startNewRpcSession, WebRpcError, type AgentSessionWrapper } from "./rpc-manager";
import type { Host } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import { takeUploads, UploadError } from "./uploads";
import { isRecord } from "./type-guards";

const MAX_CREATIONS = 256;
interface Reply { status: number; body: Record<string, unknown> }
interface Creation {
  identity: string;
  session?: AgentSessionWrapper;
  ready: Promise<AgentSessionWrapper>;
  initializing: boolean;
  promptPending: boolean;
  initialPrompt: boolean;
  prompt?: { fingerprint: string; reply: Promise<Reply> };
}
declare global {
  var __ompFreshCreations: Map<string, Creation> | undefined;
}

interface FreshCommand {
  host: Host;
  cwd: string;
  toolNames?: string[];
  advisor: boolean;
  owner: string;
  creationKey?: unknown;
  selection: AgentSelection;
  command: Record<string, unknown>;
}

/** One process-local first-send association, not a durable message id or an automatic retry mechanism. */
export async function runFreshSessionCommand(input: FreshCommand): Promise<Response> {
  const { host, cwd, toolNames, advisor, owner, selection, command, creationKey } = input;
  if (creationKey !== undefined && (typeof creationKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(creationKey))) {
    throw new WebRpcError("Invalid fresh-session creation key", "invalid_creation_key");
  }
  if (creationKey !== undefined && command.type !== "prompt" && command.type !== "ensure_session") {
    throw new WebRpcError("Creation keys apply only to fresh-session preparation and first prompts", "invalid_creation_key");
  }
  const records = (globalThis.__ompFreshCreations ??= new Map());
  // Never evict a live association or a startup that may still own a child.
  // Admission is bounded instead; dead wrappers release their records on the next request.
  for (const [key, record] of records) {
    if (!record.initializing && !record.promptPending && record.session && !record.session.isAlive()) records.delete(key);
  }
  const key = creationKey === undefined ? undefined : JSON.stringify([owner, creationKey]);
  const identity = JSON.stringify([host.id, cwd, toolNames ?? null, advisor]);
  let record = key === undefined ? undefined : records.get(key);
  if (record && record.identity !== identity) {
    throw new WebRpcError("This creation key belongs to another fresh-session launch", "creation_key_conflict");
  }
  const fingerprint = command.type === "prompt" ? createHash("sha256").update(JSON.stringify({ command, selection }, (_key, value) =>
    isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]])) : value)).digest("hex") : undefined;
  if (record?.prompt) {
    if (command.type === "prompt") {
      if (record.prompt.fingerprint !== fingerprint) throw new WebRpcError("This creation key already owns a different first prompt", "creation_prompt_conflict");
      const reply = await record.prompt.reply;
      return Response.json(reply.body, { status: reply.status });
    }
  }
  // Validate authority before cold creation. A duplicate already accepted first
  // prompt above reuses its reply even after its uploads have been consumed.
  const prepared = takeUploads({ ...command }, owner);
  if (prepared?.receipts.some((receipt) => receipt.hostId !== host.id)) {
    throw new UploadError(409, "upload_wrong_host", "The file was uploaded to another host");
  }
  if (!record) {
    if (key !== undefined && records.size >= MAX_CREATIONS) {
      throw new HostOpError(503, "fresh_sessions_busy", "Too many fresh sessions are still active; retry after one closes");
    }
    const ready = Promise.withResolvers<AgentSessionWrapper>();
    record = { identity, ready: ready.promise, initializing: true, promptPending: false, initialPrompt: command.type === "prompt" };
    const created = record;
    if (key !== undefined) records.set(key, created);
    // Store the association before the first await/spawn, so ensure and first
    // prompt can join it while the owning host is still starting omp.
    void (async () => {
      try {
        const started = await startNewRpcSession(host, cwd, toolNames, advisor, true);
        if (!started.ok) throw new HostOpError(started.status, started.code, started.error);
        created.session = started.value.session;
        await created.session.withPendingCommand(async () => {
          // Only the request that created this association initializes presets.
          // A late ensure can never revert a newer first-prompt selection.
          await applyAgentSelection(created.session!, selection);
        }, true);
        created.initializing = false;
        ready.resolve(created.session);
      } catch (error) {
        let failure = error;
        let cleanup: Promise<void> | null = null;
        const uncertainStart = !created.session && (error instanceof WebRpcError || error instanceof HostOpError)
          && (error.code === "host_offline" || error.code === "host_timeout");
        try {
          const offline = (error instanceof WebRpcError || error instanceof HostOpError) && error.code === "host_offline";
          if (created.session && !offline) await created.session.destroyAndWait("fresh-initialization-failed");
        } catch (cleanupError) {
          failure = cleanupError;
          cleanup = created.session?.destroyPromise ?? null;
        }
        const finish = () => {
          // No child identity came back from this host. Keep this bounded slot
          // rather than blindly spawn again for the same key after an uncertain open.
          if (uncertainStart) return;
          created.initializing = false;
          if (key !== undefined && (!created.session || !created.session.isAlive()) && records.get(key) === created) records.delete(key);
        };
        if (cleanup) void cleanup.then(finish, finish);
        else finish();
        ready.reject(failure);
      }
    })();
  }
  const created = record;
  const run = async (): Promise<Reply> => {
    try {
      const session = await created.ready;
      if (command.type === "ensure_session") return { status: 200, body: { success: true, sessionId: session.sessionId, data: null } };
      const body = command.type === "prompt" && !created.initialPrompt ? { ...command, ...selection } : command;
      const response = await session.withPendingCommand(() => runAgentCommand(session.sessionId, body, advisor, owner, prepared?.receipts));
      const value: unknown = await response.json();
      if (!isRecord(value)) throw new Error("Invalid shared command response");
      return { status: response.status, body: { ...value, sessionId: session.sessionId } };
    } catch (error) {
      const response = commandErrorResponse(error);
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body: { ...body, ...(created.session ? { sessionId: created.session.sessionId } : {}) } };
    }
  };
  let pending: Promise<Reply>;
  if (command.type === "prompt" && key !== undefined) {
    created.promptPending = true;
    pending = run().finally(() => { created.promptPending = false; });
    created.prompt = { fingerprint: fingerprint!, reply: pending };
  } else {
    pending = run();
  }
  const reply = await pending;
  return Response.json(reply.body, { status: reply.status });
}
