import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const agent = mkdtempSync(join(tmpdir(), "omp-web-ui-link-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
const directory = join(agent, "omp-web");
const loginFile = join(directory, "host.json");
const registryFile = join(directory, "hosts.json");
const { attachUiHostLink, detachUiHostLink, uiPreviewOrigin } = await import("./ui-link.ts");
const { addHostLink, loginHost, readHostLinks, readHostLogin } = await import("../lib/hosts/host-login.ts");
const { hostForToken, loadHosts, rotateLocalHostToken } = await import("../lib/hosts/registry.ts");
const production = "http://127.0.0.1:40001";
const preview = "http://127.0.0.1:40002";
beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
});
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agent, { recursive: true, force: true });
});
async function primary() {
  const token = rotateLocalHostToken();
  await loginHost({ url: production, token });
  return token;
}

test("primary service reuse keeps both credential files and secondary memberships untouched", async () => {
  const token = await primary();
  await addHostLink({ url: preview, token });
  const loginBefore = readFileSync(loginFile, "utf8");
  const registryBefore = readFileSync(registryFile, "utf8");
  const loginIdentity = statSync(loginFile).ino;
  await attachUiHostLink(production + "/", { primary: true });
  assert.equal(readFileSync(loginFile, "utf8"), loginBefore);
  assert.equal(statSync(loginFile).ino, loginIdentity);
  assert.equal(readFileSync(registryFile, "utf8"), registryBefore);
});

test("primary service reuse cannot move the primary or accept unrecognized credentials", async () => {
  await primary();
  const before = readFileSync(loginFile, "utf8");
  await assert.rejects(attachUiHostLink(preview, { primary: true }), /existing primary host origin/);
  assert.equal(readFileSync(loginFile, "utf8"), before);
  const invalid = JSON.stringify({ url: production, token: "unrecognized", links: [{ url: production, token: "unrecognized" }] });
  writeFileSync(loginFile, invalid);
  const registryBefore = readFileSync(registryFile, "utf8");
  await assert.rejects(attachUiHostLink(production, { primary: true }), /not valid/);
  assert.equal(readFileSync(loginFile, "utf8"), invalid);
  assert.equal(readFileSync(registryFile, "utf8"), registryBefore);
});

test("a preview reuses the production token and cleanup preserves production membership", async () => {
  const token = await primary();
  const registryBefore = readFileSync(registryFile, "utf8");
  await attachUiHostLink(preview + "/");
  assert.deepEqual(readHostLogin(), { url: production, token });
  assert.deepEqual(readHostLinks(), [{ url: production, token }, { url: preview, token }]);
  await attachUiHostLink(preview);
  assert.equal(readHostLinks().length, 2);
  assert.equal(readFileSync(registryFile, "utf8"), registryBefore);
  assert.equal(await detachUiHostLink(preview), true);
  assert.deepEqual(readHostLinks(), [{ url: production, token }]);
  assert.equal(await detachUiHostLink(preview), false);
  assert.equal(hostForToken(token)?.id, "local");
});

test("a preview cannot bootstrap or rotate a missing production login", async () => {
  await assert.rejects(attachUiHostLink(preview), /normal OMPweb/);
  await assert.rejects(attachUiHostLink(production, { primary: true }), /normal OMPweb/);
  assert.equal(existsSync(loginFile), false);
  assert.deepEqual(loadHosts(), []);
});

test("unrecognized production credentials fail without replacing either saved file", async () => {
  const valid = await primary();
  writeFileSync(loginFile, JSON.stringify({ url: production, token: "unknown-token", links: [{ url: production, token: "unknown-token" }] }));
  const beforeLogin = readFileSync(loginFile, "utf8");
  const beforeRegistry = readFileSync(registryFile, "utf8");
  await assert.rejects(attachUiHostLink(preview), /not valid/);
  assert.equal(readFileSync(loginFile, "utf8"), beforeLogin);
  assert.equal(readFileSync(registryFile, "utf8"), beforeRegistry);
  assert.equal(hostForToken(valid)?.id, "local");
});

test("preview startup cannot take the primary port or an unrelated link's credentials", async () => {
  const token = await primary();
  await assert.rejects(attachUiHostLink(production), /another port/);
  await addHostLink({ url: preview, token: "another-host-token" });
  const before = readFileSync(loginFile, "utf8");
  await assert.rejects(attachUiHostLink(preview), /different host link/);
  assert.equal(readFileSync(loginFile, "utf8"), before);
  assert.deepEqual(readHostLogin(), { url: production, token });
});

test("cleanup refuses a preview promoted to the primary while it was running", async () => {
  const token = await primary();
  await attachUiHostLink(preview);
  await loginHost({ url: preview, token });
  const before = readFileSync(loginFile, "utf8");
  assert.equal(await detachUiHostLink(preview), false);
  assert.equal(readFileSync(loginFile, "utf8"), before);
  assert.deepEqual(readHostLinks(), [{ url: preview, token }]);
});

test("customization origins cannot expose the debug server or carry credentials or paths", () => {
  assert.equal(uiPreviewOrigin(preview + "/"), preview);
  assert.equal(uiPreviewOrigin("http://[::1]:40002"), "http://[::1]:40002");
  for (const url of ["https://127.0.0.1:40002", "http://example.com:40002", "http://0.0.0.0:40002", "http://user:secret@127.0.0.1:40002", preview + "/api", preview + "?secret=1", preview + "#fragment", "http://127.0.0.1:0"]) {
    assert.throws(() => uiPreviewOrigin(url), /loopback origin/);
  }
});
