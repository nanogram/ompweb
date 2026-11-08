import { promisify } from "node:util";
import { constants, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const MIN_COMPRESS_BYTES = 1024;

/** Only advertise encodings we actually implement. An explicit q=0 overrides
 * a wildcard; identity remains acceptable unless explicitly excluded. */
function encodingQuality(header: string | null): { gzip: number; identity: number } {
  const qualities = new Map<string, number>();
  for (const part of header?.split(",") ?? []) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const value = parameter.trim();
      if (!value.startsWith("q=")) continue;
      const raw = value.slice(2);
      quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    }
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }
  return {
    gzip: qualities.get("gzip") ?? qualities.get("*") ?? 0,
    identity: qualities.get("identity") ?? (qualities.get("*") === 0 ? 0 : 1),
  };
}

/** Compress private history JSON without globally compressing APIs or buffering
 * event streams. Async zlib keeps compression off the JavaScript event loop. */
export async function historyJsonResponse(request: Request, value: unknown): Promise<Response> {
  const quality = encodingQuality(request.headers.get("accept-encoding"));
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  });
  if (quality.gzip === 0 && quality.identity === 0) {
    return new Response(JSON.stringify({ error: "No acceptable history encoding", code: "encoding_not_acceptable" }), {
      status: 406, headers,
    });
  }
  const json = JSON.stringify(value);
  if (quality.gzip === 0 || quality.gzip < quality.identity
    || (quality.identity > 0 && Buffer.byteLength(json, "utf8") < MIN_COMPRESS_BYTES)) {
    return new Response(json, { headers });
  }
  const bytes = Buffer.from(json, "utf8");
  const compressed = await gzipAsync(bytes, { level: constants.Z_BEST_SPEED });
  if (compressed.length < bytes.length || quality.identity === 0) {
    headers.set("Content-Encoding", "gzip");
    return new Response(compressed, { headers });
  }
  return new Response(json, { headers });
}
