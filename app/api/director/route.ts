import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { ensureDirector, getDirectorStatus, requestDirectorReview, updateDirectorConfig } from "@/lib/director";
import { DirectorError, parseDirectorPatch, parseDirectorProject } from "@/lib/director-engine";

// Authentication and same-origin/CSRF checks stay in the normal API gate.
export async function GET() {
  try { return Response.json(await getDirectorStatus(), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit<unknown>(request, 32_768);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("action" in body)) throw new DirectorError("A Director action is required", "invalid_director_action", 400);
    const keys = Object.keys(body);
    if (body.action === "ensure") {
      if (keys.some((key) => key !== "action" && key !== "project")) throw new DirectorError("Unknown ensure parameter", "invalid_director_action", 400);
      const project = "project" in body ? parseDirectorProject(body.project) : undefined;
      return Response.json(await ensureDirector(project));
    }
    if (body.action === "configure") {
      if (keys.some((key) => key !== "action" && key !== "patch") || !("patch" in body)) throw new DirectorError("A configuration patch is required", "invalid_director_action", 400);
      return Response.json(await updateDirectorConfig(parseDirectorPatch(body.patch)));
    }
    if (body.action === "review" && keys.length === 1) return Response.json(await requestDirectorReview());
    throw new DirectorError("Unknown Director action", "invalid_director_action", 400);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "Director request is too large", code: "request_too_large" }, { status: 413 });
    if (error instanceof SyntaxError || error instanceof TypeError) return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
    if (error instanceof DirectorError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return apiErrorResponse(error);
  }
}
