import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const { checkNpmUpdate } = await import("./npm-update.ts");
const { checkOmpUpdate } = await import("./omp/updates.ts");
const { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } = await import("./update-policy.ts");
const {
  getSelfUpdateSupport,
  prepareSelfUpdate,
  commitSelfUpdate,
  validateCommitSelfUpdate,
} = await import("./self-update.ts");
const { GET: getAppUpdate, POST: postAppUpdate } = await import("../app/api/app-update/route.ts");
const { POST: postOmpUpdate } = await import("../app/api/omp-update/route.ts");

const ENV_VAR = DISABLE_AUTOUPDATE_ENV_VAR;


test("update opt-out accepts truthy values and leaves falsy values enabled", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), true);
  }
  for (const value of [undefined, "", "0", "false", "off", "no"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), false);
  }
});
test("update opt-out skips external checks and self-update actions", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env[ENV_VAR] = "1";
  process.env.OMP_WEB_OMP_BIN = join(tmpdir(), "omp-web-missing-omp-for-update-policy-test");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ version: "999.0.0" });
  };

  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  const appStatus = await checkNpmUpdate(true);
  assert.equal(appStatus.updatesDisabled, true);
  assert.equal(appStatus.updateAvailable, false);
  assert.equal(appStatus.availableVersion, null);

  const ompStatus = await checkOmpUpdate(true);
  assert.equal(ompStatus.updatesDisabled, true);
  assert.equal(ompStatus.updateAvailable, false);
  assert.equal(ompStatus.availableVersion, null);

  const appResponse = await getAppUpdate(new Request("http://localhost/api/app-update?force=1"));
  assert.equal(appResponse.status, 200);
  const appBody = await appResponse.json();
  assert.equal(appBody.updatesDisabled, true);
  assert.equal(appBody.updateAvailable, false);
  assert.equal(appBody.selfUpdateSupported, false);
  assert.equal(appBody.selfUpdateStatus, undefined);

  const ompResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check", force: true }),
  }));
  assert.equal(ompResponse.status, 200);
  const ompBody = await ompResponse.json();
  assert.equal(ompBody.updatesDisabled, true);
  assert.equal(ompBody.updateAvailable, false);
  assert.equal(ompBody.selfUpdateSupported, false);

  const appPrepareResponse = await postAppUpdate(new Request("http://localhost/api/app-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare" }),
  }));
  assert.equal(appPrepareResponse.status, 403);
  assert.equal((await appPrepareResponse.json()).code, "updates_disabled");

  const ompUpdateResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update" }),
  }));
  assert.equal(ompUpdateResponse.status, 403);
  assert.equal((await ompUpdateResponse.json()).code, "updates_disabled");
  assert.equal(fetchCalls, 0);

  assert.equal(getSelfUpdateSupport().supported, false);
  await assert.rejects(prepareSelfUpdate("app"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  assert.throws(() => validateCommitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  await assert.rejects(() => commitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
});

test("fork application status and direct prepare/commit never contact upstream", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const scratch = mkdtempSync(join(tmpdir(), "ompweb-fork-policy-"));
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = scratch;
  delete process.env[ENV_VAR];
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("upstream must not be consulted"); };
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    rmSync(scratch, { recursive: true, force: true });
  });
  const response = await getAppUpdate(new Request("http://localhost/api/app-update?force=1"));
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.availableVersion, null);
  assert.equal(status.selfUpdateSupported, false);
  assert.equal(status.manualUpdateSource, "https://github.com/nanogram/ompweb");
  assert.equal(status.updateCommand, status.manualUpdateSource);
  assert.match(status.blockedReason, /disabled for the nanogram fork.*Update manually from https:\/\/github\.com\/nanogram\/ompweb/);
  for (const body of [{ action: "prepare" }, { action: "commit", attemptId: "2e4c6460-5a8f-4ef7-8d81-42cb688a8bdc" }]) {
    const attempt = await postAppUpdate(new Request("http://localhost/api/app-update", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(attempt.status, 403);
    assert.equal((await attempt.json()).code, "manual_update_required");
  }
  assert.equal(fetchCalls, 0);
  assert.equal(isUpdateDisabled(), false, "fork policy must not turn off independent OMP updates");
  assert.equal(getSelfUpdateSupport("omp").supported, true);
});

test("the omp update check says whether this server can run the update itself", async (t) => {
  const originalEnv = { ...process.env };
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-update-check-"));
  t.after(() => {
    process.env = originalEnv;
    rmSync(scratch, { recursive: true, force: true });
  });
  // An omp whose `update --check` reports a newer version.
  const fakeOmp = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
  writeFileSync(fakeOmp, process.platform === "win32"
    ? "@echo Current version: 1.0.0\r\n@echo New version available: 1.1.0\r\n"
    : "#!/bin/sh\nprintf 'Current version: 1.0.0\\nNew version available: 1.1.0\\n'\n");
  chmodSync(fakeOmp, 0o755);
  delete process.env[ENV_VAR];
  process.env.OMP_WEB_OMP_BIN = fakeOmp;

  const response = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check", force: true }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.updateAvailable, true);
  // The npm install (not the compiled binary, which answers false) runs the update worker.
  assert.equal(body.selfUpdateSupported, true);
});
