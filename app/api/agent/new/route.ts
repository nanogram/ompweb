import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { readAgentSelection } from "@/lib/agent-command";
import { runFreshSessionCommand } from "@/lib/fresh-session-handoff";
import { requestOwner } from "@/lib/web-auth";
import { isDirectorWorkspace } from "@/lib/director-state";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "New session request is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if ((error instanceof WebRpcError && error.code !== "host_offline") || error instanceof RpcCommandError) {
    return Response.json(
      { error: error.message, code: error instanceof WebRpcError ? error.code : (error.code ?? "rpc_command_failed") },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
// POST /api/agent/new  body: { cwd: string; type: string; hostId?: string; message?: string; ... }
// Spawns a brand-new omp session on `hostId` (this machine when absent). Most
// calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is omp's real session id.
// A creationKey joins precreation and the first prompt server-side; neither a
// renderer continuation nor the order of the two HTTP responses owns delivery.
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{ cwd?: string; hostId?: unknown; [key: string]: unknown }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    const { cwd: requestedCwd, hostId, creationKey, ...command } = body;
    const target = resolveHostOrError(hostId);
    if ("response" in target) return target.response;
    const { host } = target;

    if (!requestedCwd || typeof requestedCwd !== "string") {
      return Response.json({ error: "cwd is required", code: "cwd_required" }, { status: 400 });
    }
    if (host.id === LOCAL_HOST_ID && isDirectorWorkspace(requestedCwd)) {
      return Response.json({ error: "Use the dedicated Director entry instead of creating another Director chat.", code: "director_managed" }, { status: 409 });
    }

    const { provider, modelId, toolNames, thinkingLevel, advisor, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; advisor?: boolean; [key: string]: unknown };
    // A session id has no meaning for a fresh spawn and must never reach the
    // child RPC: a stale or forged id would address the wrong session.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return Response.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    return await runFreshSessionCommand({
      host,
      cwd: requestedCwd,
      toolNames,
      advisor: advisor === true,
      selection: readAgentSelection({ provider, modelId, thinkingLevel }),
      owner: requestOwner(req),
      creationKey,
      command: promptCommand,
    });
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
