import assert from "node:assert/strict";
import test from "node:test";
import { PATCH, POST } from "./route.ts";

function request(method, launchConfig) {
  return new Request("http://localhost/api/projects", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: "/fixture", launchConfig }) });
}

for (const [method, handler] of [["POST", POST], ["PATCH", PATCH]]) {
  test(`${method} rejects invalid profile selections before contacting a host`, async () => {
    for (const profile of ["bad profile", "Uppercase", "con", "con.txt", "-flag", "a".repeat(65), ""]) {
      const response = await handler(request(method, { profile }));
      assert.equal(response.status, 400, profile);
      assert.equal((await response.json()).code, "invalid_profile", profile);
    }
  });
  test(`${method} rejects a reserved option/value pair without allowing its value to become a prompt`, async () => {
    for (const extraArgs of [["--profile", "work"], ["--profile=work"], ["--extension", "/fixture/extension.mjs"], ["--hook=hook.mjs"], ["--plugin-dir", "/fixture/plugins"], ["--cwd", "/other"]]) {
      const response = await handler(request(method, { extraArgs }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "invalid_extra_args");
    }
  });
}
