import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { historyJsonResponse } from "./history-response.ts";

const history = { entryIds: ["retained"], messages: [{ role: "assistant", content: "Recent answer 日本語 🌙\n".repeat(400) }] };
const request = (encoding) => new Request("http://localhost/api/sessions/s/context?sync=1", {
  headers: encoding === undefined ? {} : { "Accept-Encoding": encoding },
});

async function decode(response) {
  const raw = Buffer.from(await response.arrayBuffer());
  return { raw, value: JSON.parse((response.headers.get("Content-Encoding") === "gzip" ? gunzipSync(raw) : raw).toString("utf8")) };
}

test("history compression reduces wire bytes and preserves exact Unicode JSON", async () => {
  const response = await historyJsonResponse(request("br, gzip"), history);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.equal(response.headers.get("Vary"), "Accept-Encoding");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const decoded = await decode(response);
  assert.deepEqual(decoded.value, history);
  assert.ok(decoded.raw.length < Buffer.byteLength(JSON.stringify(history)) / 2);
});

for (const encoding of [undefined, "identity", "br", "gzip;q=0", "*;q=1, gzip;q=0", "gzip;q=0.5, identity;q=1", "gzip;q=invalid"]) {
  test(`identity is preserved when gzip is unavailable or less preferred: ${encoding}`, async () => {
    const response = await historyJsonResponse(request(encoding), history);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("Vary"), "Accept-Encoding");
    assert.deepEqual((await decode(response)).value, history);
  });
}

for (const encoding of ["GZIP;q=1, identity;q=0.2", "*;q=1", "*;q=0, gzip;q=1", "gzip;q=0.5, identity;q=0"]) {
  test(`accepted gzip honors quality and wildcard negotiation: ${encoding}`, async () => {
    const response = await historyJsonResponse(request(encoding), history);
    assert.equal(response.headers.get("Content-Encoding"), "gzip");
    assert.deepEqual((await decode(response)).value, history);
  });
}

test("small responses avoid compression overhead unless identity is forbidden", async () => {
  const small = { entryIds: [] };
  const normal = await historyJsonResponse(request("gzip"), small);
  assert.equal(normal.headers.get("Content-Encoding"), null);
  assert.deepEqual((await decode(normal)).value, small);
  const required = await historyJsonResponse(request("gzip, identity;q=0"), small);
  assert.equal(required.headers.get("Content-Encoding"), "gzip");
  assert.deepEqual((await decode(required)).value, small);
});

for (const encoding of ["gzip;q=0, identity;q=0", "br, *;q=0", "*;q=0"]) {
  test(`unacceptable encodings are rejected without leaking transcript data: ${encoding}`, async () => {
    const response = await historyJsonResponse(request(encoding), history);
    assert.equal(response.status, 406);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.deepEqual(await response.json(), { error: "No acceptable history encoding", code: "encoding_not_acceptable" });
  });
}
