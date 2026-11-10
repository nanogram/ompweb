import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import test from "node:test";

const { customizationPublicOrigin, startCustomizationProxy } = createRequire(import.meta.url)("./ui-customization-proxy.js");
const publicUrl = "https://preview.example.test:8446";
const host = new URL(publicUrl).host;

async function fixture(t, respond) {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, headers: request.headers, body });
    if (respond) { await respond(request, response); return; }
    if (request.url.startsWith("/api/")) {
      const allowed = request.headers.cookie === "session=valid" && request.headers.host === host && request.headers.origin === publicUrl;
      response.writeHead(allowed ? 200 : 403);
      response.end(allowed ? "authorized command" : "denied");
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin, body, url: request.url }));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = await startCustomizationProxy({ publicUrl, hostname: "127.0.0.1", port: 0, upstream: upstreamUrl });
  t.after(async () => { await proxy.close(); await new Promise((resolve) => upstream.close(resolve)); });
  async function request(path, { origin = publicUrl, hostname = host, body = "", cookie, headers: extraHeaders = {}, method = body ? "POST" : "GET" } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...extraHeaders, host: hostname, ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}) };
      const outgoing = http.request(proxy.origin + path, { method, headers }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => { chunks.push(chunk); });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const data = Buffer.concat(chunks);
          resolve({ status: incoming.statusCode, text: data.toString("utf8"), data, headers: incoming.headers });
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
  return { proxy, upstream, upstreamUrl, requests, request };
}

test("remote GUI access requires one explicit HTTPS origin", () => {
  assert.equal(customizationPublicOrigin(publicUrl + "/"), publicUrl);
  for (const value of ["http://preview.example.test", "https://user:password@preview.example.test", publicUrl + "/path", publicUrl + "?secret=1", publicUrl + "#fragment"]) {
    assert.throws(() => customizationPublicOrigin(value), /HTTPS origin/);
  }
});

test("Bun assets admit only the configured host and same-origin requests", async (t) => {
  const f = await fixture(t);
  const accepted = await f.request("/_bun/client/example.js?revision=1");
  assert.equal(accepted.status, 200);
  const payload = JSON.parse(accepted.text);
  assert.equal(payload.host, new URL(f.upstreamUrl).host);
  assert.equal(payload.origin, f.upstreamUrl);
  assert.equal(payload.url, "/_bun/client/example.js?revision=1");
  for (const options of [{ hostname: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "null" }]) {
    assert.equal((await f.request("/_bun/client/example.js", options)).status, 403);
  }
  assert.equal(f.requests.length, 1, "refused browser origins must never reach Bun");
  assert.equal((await f.request("/_bun/asset/example.css", { origin: null })).status, 200);
});

test("API authentication and CSRF still see the original public host, origin and credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/command", { body: "message", cookie: "session=valid" })).text, "authorized command");
  assert.equal((await f.request("/api/command", { body: "message", cookie: "session=valid", origin: "https://attacker.example" })).status, 403);
  assert.equal((await f.request("/api/command", { body: "message" })).status, 403);
  assert.deepEqual(f.requests.map(({ body }) => body), ["message", "message", "message"]);
});

test("trusted HMR upgrades carry duplex bytes and preview shutdown closes the tunnel", async (t) => {
  const f = await fixture(t);
  f.upstream.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.host, new URL(f.upstreamUrl).host);
    assert.equal(request.headers.origin, f.upstreamUrl);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (data) => socket.write(data));
    socket.on("end", () => socket.end());
    socket.on("error", () => {});
  });
  const outgoing = http.request(f.proxy.origin + "/_bun/hmr", { headers: { host, origin: publicUrl, connection: "Upgrade", upgrade: "test" } });
  const upgraded = once(outgoing, "upgrade");
  outgoing.end();
  const [response, socket] = await upgraded;
  assert.equal(response.statusCode, 101);
  socket.write("one complete HMR frame");
  const [data] = await once(socket, "data");
  assert.equal(data.toString(), "one complete HMR frame");
  const closed = once(socket, "close");
  socket.resume();
  await f.proxy.close();
  await closed;
  await f.proxy.close();
});

test("an HMR upgrade without its trusted browser origin is refused before reaching upstream", async (t) => {
  const f = await fixture(t);
  let upgrades = 0;
  f.upstream.on("upgrade", (_request, socket) => { upgrades++; socket.destroy(); });
  const outgoing = http.request(f.proxy.origin + "/_bun/hmr", { headers: { host, connection: "Upgrade", upgrade: "test" } });
  const response = once(outgoing, "response");
  outgoing.end();
  const [incoming] = await response;
  incoming.resume();
  assert.equal(incoming.statusCode, 403);
  assert.equal(upgrades, 0);
});

test("reserved GUI scripts and styles negotiate streaming gzip without changing their content", async (t) => {
  const content = "export const greeting = 'A complete live GUI asset';\n".repeat(1024);
  const f = await fixture(t, (request, response) => {
    response.writeHead(200, {
      "content-type": request.url.endsWith(".css") ? "text/css;charset=utf-8" : "text/javascript;charset=utf-8",
      "content-length": Buffer.byteLength(content),
      etag: '"revision-1"',
      vary: "Origin",
    });
    response.end(content);
  });
  for (const path of ["/_bun/client/entry.js", "/_bun/asset/styles.css"]) {
    const compressed = await f.request(path, { headers: { "accept-encoding": "gzip" } });
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(compressed.headers["content-length"], undefined);
    assert.equal(compressed.headers.etag, 'W/"revision-1"');
    assert.match(compressed.headers.vary, /Origin/);
    assert.match(compressed.headers.vary, /Accept-Encoding/);
    assert.equal(gunzipSync(compressed.data).toString(), content);
    const identity = await f.request(path, { headers: { "accept-encoding": "identity" } });
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.equal(identity.headers.etag, '"revision-1"');
    assert.equal(identity.text, content);
    assert.match(identity.headers.vary, /Accept-Encoding/);
  }
  for (const value of ["gzip;q=0, *;q=1", "*;q=1, gzip;q=0", "br", "gzip;q=invalid"]) {
    const rejected = await f.request("/_bun/client/entry.js", { headers: { "accept-encoding": value } });
    assert.equal(rejected.headers["content-encoding"], undefined, value);
    assert.equal(rejected.text, content);
  }
  const wildcard = await f.request("/_bun/client/entry.js", { headers: { "accept-encoding": "*;q=0.5" } });
  assert.equal(gunzipSync(wildcard.data).toString(), content);
  const head = await f.request("/_bun/client/entry.js", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(head.headers["content-length"], undefined);
  assert.equal(head.data.byteLength, 0);
});

test("GUI revalidation avoids a repeat body but never hides a changed HMR revision", async (t) => {
  let revision = 1;
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/javascript", etag: `"revision-${revision}"` });
    response.end(`export const revision = ${revision};`);
  });
  const first = await f.request("/_bun/client/entry.js", { headers: { "accept-encoding": "gzip" } });
  assert.match(first.headers["cache-control"], /private/);
  assert.match(first.headers["cache-control"], /no-cache/);
  const headers = { "accept-encoding": "gzip", "if-none-match": first.headers.etag };
  const unchanged = await f.request("/_bun/client/entry.js", { headers });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.data.byteLength, 0);
  assert.equal(unchanged.headers["content-length"], undefined);
  assert.equal(unchanged.headers["content-encoding"], undefined);
  assert.match(unchanged.headers.vary, /Accept-Encoding/);
  revision++;
  const changed = await f.request("/_bun/client/entry.js", { headers });
  assert.equal(changed.status, 200);
  assert.equal(gunzipSync(changed.data).toString(), "export const revision = 2;");
  assert.equal(changed.headers.etag, 'W/"revision-2"');
  const list = await f.request("/_bun/client/entry.js", { headers: { "if-none-match": '"other", W/"revision-2"' } });
  assert.equal(list.status, 304);
  assert.equal((await f.request("/_bun/client/entry.js", { headers: { "if-none-match": "*" } })).status, 304);
});

test("asset transforms preserve encoded bytes, ranges, no-store/no-transform policies and API responses", async (t) => {
  const text = "A complete response that must survive the proxy.";
  const encoded = gzipSync(text);
  const f = await fixture(t, (request, response) => {
    let body = Buffer.from(text);
    const headers = { "content-type": "text/javascript", etag: '"original"' };
    let status = 200;
    if (request.url.endsWith("encoded.js")) { body = encoded; headers["content-encoding"] = "gzip"; }
    if (request.url.endsWith("font.woff2")) { body = Buffer.from([0, 255, 128, 1]); headers["content-type"] = "font/woff2"; }
    if (request.url.endsWith("partial.js")) { status = 206; body = Buffer.from("abc"); headers["content-range"] = "bytes 0-2/100"; }
    if (request.url.endsWith("no-store.js")) headers["cache-control"] = "no-store";
    if (request.url.endsWith("no-transform.js")) headers["cache-control"] = "private, no-transform";
    if (request.url.startsWith("/api/")) headers["cache-control"] = "no-store";
    headers["content-length"] = body.byteLength;
    response.writeHead(status, headers);
    response.end(body);
  });
  const compressed = await f.request("/_bun/client/encoded.js", { headers: { "accept-encoding": "gzip" } });
  assert.deepEqual(compressed.data, encoded);
  assert.equal(gunzipSync(compressed.data).toString(), text);
  const binary = await f.request("/_bun/asset/font.woff2", { headers: { "accept-encoding": "gzip" } });
  assert.equal(binary.headers["content-encoding"], undefined);
  assert.deepEqual(binary.data, Buffer.from([0, 255, 128, 1]));
  const partial = await f.request("/_bun/client/partial.js", { headers: { "accept-encoding": "gzip", range: "bytes=0-2" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.text, "abc");
  assert.equal(partial.headers["content-range"], "bytes 0-2/100");
  assert.equal(partial.headers["content-encoding"], undefined);
  const privateAsset = await f.request("/_bun/client/no-store.js", { headers: { "accept-encoding": "gzip", "if-none-match": "*" } });
  assert.equal(privateAsset.status, 200);
  assert.equal(privateAsset.headers["cache-control"], "no-store");
  assert.equal(gunzipSync(privateAsset.data).toString(), text);
  const noTransform = await f.request("/_bun/client/no-transform.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(noTransform.text, text);
  assert.equal(noTransform.headers["content-encoding"], undefined);
  const api = await f.request("/api/private", { headers: { "accept-encoding": "gzip", "if-none-match": "*" } });
  assert.equal(api.status, 200);
  assert.equal(api.text, text);
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(api.headers["content-encoding"], undefined);
  const mutation = await f.request("/_bun/client/entry.js", { method: "POST", body: "mutation", headers: { "accept-encoding": "gzip", "if-none-match": "*" } });
  assert.equal(mutation.status, 200);
  assert.equal(mutation.text, text);
  assert.equal(mutation.headers["content-encoding"], undefined);
});
