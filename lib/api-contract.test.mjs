import assert from "node:assert/strict";
import test from "node:test";

test("PUT /api/web-settings validates the transport and tells open streams only when it changed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete globalThis.__ompWebSettingsCache;
  const { PUT, GET } = await import("../app/api/web-settings/route.ts");
  const { EventStreamConnection } = await import("./event-stream-hub.ts");
  const put = (body) => PUT(new Request("http://localhost/api/web-settings", { method: "PUT", body: JSON.stringify(body) }));
  const connection = new EventStreamConnection();
  const reader = connection.stream.getReader();
  const decoder = new TextDecoder();
  const read = async () => {
    let watchdog;
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("read stalled: the expected frame never arrived")), 2000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    return decoder.decode(chunk.value);
  };
  try {
    assert.match(await read(), /"type":"hello"/);

    // The experiment's modes are gone: only sse and ws.
    for (const value of ["websocket", "ws-pool", "ws-client"]) {
      const invalid = await put({ browserTransport: value });
      assert.equal(invalid.status, 400);
      const answer = await invalid.json();
      assert.equal(answer.code, "invalid_settings");
    }

    // The default is ws, so the first change is to sse.
    const ok = await put({ browserTransport: "sse" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).browserTransport, "sse");
    assert.match(await read(), /^event: mux\n.*\ndata: \{"type":"transport","transport":"sse"\}\n\n$/s);
    assert.equal((await (await GET()).json()).browserTransport, "sse");

    // Saves that do not change the state broadcast nothing: the next frame is the one we trigger ourselves.
    for (const unchanged of [{ autoResumeSessions: false }, { browserTransport: "sse" }]) {
      assert.equal((await put(unchanged)).status, 200);
      connection.control({ type: "open", sub: "s1" });
      assert.match(await read(), /"type":"open"/);
    }

    assert.equal((await put({ browserTransport: "ws" })).status, 200);
    assert.match(await read(), /"type":"transport","transport":"ws"/);
  } finally {
    connection.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  }
});
