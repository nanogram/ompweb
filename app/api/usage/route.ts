import { isRecord } from "@/lib/type-guards";
import { getUsageReport } from "@/lib/usage-service";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

/** Custom windows are bounded; named presets, including `all`, retain their
 * existing meaning. */
const MAX_USAGE_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

function invalidWindow(): Response {
  return Response.json({ error: "Invalid usage window", code: "invalid_usage_window" }, { status: 400 });
}

/** Epoch milliseconds, digits only; undefined when absent, null when invalid. */
function parseTimestamp(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range");
  const granularityParam = url.searchParams.get("granularity");
  const projectParam = url.searchParams.get("project");
  const refreshParam = url.searchParams.get("refresh");

  const validRanges: UsageTimeRange[] = ["today", "7d", "30d", "90d", "month", "all"];
  const range: UsageTimeRange = validRanges.includes(rangeParam as UsageTimeRange)
    ? (rangeParam as UsageTimeRange)
    : "30d";

  const validGranularities: UsageGranularity[] = ["daily", "monthly", "projects"];
  const granularity: UsageGranularity = validGranularities.includes(granularityParam as UsageGranularity)
    ? (granularityParam as UsageGranularity)
    : "daily";

  const from = parseTimestamp(url.searchParams.get("from"));
  const to = parseTimestamp(url.searchParams.get("to"));
  if (from === null || to === null) return invalidWindow();
  // The database only uses explicit bounds when BOTH are present. Reject
  // incomplete pairs instead of silently serving a different preset window.
  if ((from === undefined) !== (to === undefined)) return invalidWindow();
  if (from !== undefined && to !== undefined && (from > to || to - from > MAX_USAGE_WINDOW_MS)) return invalidWindow();

  const forceRefresh = refreshParam === "true" || refreshParam === "1";

  try {
    const report = await getUsageReport({
      range,
      granularity,
      project: projectParam || undefined,
      from,
      to,
      forceRefresh,
    });
    return Response.json(report);
  } catch (error) {
    // Paths and database messages stay in the server log; the client gets a
    // stable code it can act on. Match on the code, not `instanceof`: a
    // re-evaluated module or a worker restart need not share class identity.
    console.error("[api/usage]", error);
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "usage_busy") {
      return Response.json({ error: "Usage scan busy", code: "usage_busy" }, { status: 503 });
    }
    if (code === "usage_timeout") {
      return Response.json({ error: "Usage scan timed out", code: "usage_timeout" }, { status: 504 });
    }
    return Response.json({ error: "Usage report failed", code: "usage_failed" }, { status: 500 });
  }
}
