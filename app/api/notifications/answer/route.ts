import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import type { ExtensionUiResponse } from "@/lib/notification-events";
import type { RpcAskDialogAnswer } from "@/lib/pi-types";
import { getRpcSession, isAskAnswers, WebRpcError } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

const MAX_BODY_BYTES = 64 * 1024;
const invalid = (error: string) => Response.json({ error, code: "invalid_answer_request" }, { status: 400 });

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Exactly one response variant; method-specific checks belong to the shared settlement path. */
function parseResponse(value: unknown): ExtensionUiResponse | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (typeof value.value === "string") return { value: value.value };
  if (typeof value.confirmed === "boolean") return { confirmed: value.confirmed };
  if (value.cancelled === true) return { cancelled: true };
  if (isAskAnswers(value.answers)) return { answers: value.answers as RpcAskDialogAnswer[] };
  return null;
}

/** Auth-gated, live wrappers only (including their moved-session aliases); never spawns omp. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Answer is too large", code: "request_too_large" }, { status: 413 });
    }
    return invalid("Invalid JSON request body");
  }
  if (!isRecord(body) || !isId(body.sessionId) || !isId(body.requestId)) return invalid("sessionId, requestId and response are required");
  const response = parseResponse(body.response);
  if (!response) return invalid("response must be exactly one of value, confirmed, cancelled or answers");
  const session = getRpcSession(body.sessionId);
  if (!session || !session.isAlive()) return Response.json({ status: "sessionGone" });
  try {
    return Response.json({ status: await session.answerExtensionUiRequest(body.requestId, response) });
  } catch (error) {
    if (error instanceof WebRpcError) return Response.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }
}
