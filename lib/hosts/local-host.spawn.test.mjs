import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionSpawnArgs, localHost } from "./local-host.ts";
import { loadProjectRegistry, parseProjectRegistry, saveProjectRegistry, updateProjectsPresentation } from "../project-registry.ts";

const hasCode = code => error => error?.code === code;

test("native argv migrates a valid legacy profile pair without leaving a positional value", () => {
  for (const extraArgs of [["--profile", "work", "--verbose"], ["--profile=work", "--verbose"]]) {
    assert.deepEqual(buildSessionSpawnArgs("", undefined, false, { extraArgs }), ["--profile", "work", "--verbose"]);
  }
  assert.throws(() => buildSessionSpawnArgs("", undefined, false, { profile: "personal", extraArgs: ["--profile", "work"] }), hasCode("invalid_profile"));
  for (const extraArgs of [["--profile"], ["--profile", "bad profile"], ["--profile", "--verbose"]]) {
    assert.throws(() => buildSessionSpawnArgs("", undefined, false, { extraArgs }), hasCode("invalid_profile"));
  }
});

test("native argv rejects a reserved flag and its value as a whole rather than stripping either", () => {
  for (const flag of ["--cwd", "--mode", "--resume", "--extension", "--hook", "-e", "--plugin-dir"]) {
    for (const extraArgs of [[flag, "value", "--verbose"], [`${flag}=value`, "--verbose"]]) {
      assert.throws(() => buildSessionSpawnArgs("", undefined, false, { extraArgs }), hasCode("invalid_extra_args"));
    }
  }
  assert.throws(() => buildSessionSpawnArgs("", undefined, false, { extraArgs: ["--", "prompt"] }), hasCode("invalid_extra_args"));
});

test("actual local daemon spawn refuses stored invalid selections even after an unrelated registry save", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-spawn-policy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  for (const [launchConfig, code] of [
    [{ profile: "bad profile" }, "invalid_profile"],
    [{ profile: "CON" }, "invalid_profile"],
    [{ profile: "--other" }, "invalid_profile"],
    [{ extraArgs: ["--extension", "evil.mjs"] }, "invalid_extra_args"],
    [{ extraArgs: ["--profile", "bad profile"] }, "invalid_profile"],
    [{ extraArgs: ["--verbose", 42] }, "invalid_extra_args"],
  ]) {
    const registry = parseProjectRegistry(JSON.stringify({ projects: [{ path: cwd, hidden: true, launchConfig }] }));
    saveProjectRegistry(updateProjectsPresentation(registry, [{ path: cwd, alias: "Renamed" }]));
    await assert.rejects(localHost.spawnRpc({ cwd, sessionFile: "" }), hasCode(code));
    assert.deepEqual(loadProjectRegistry().projects[0].launchConfig, launchConfig);
  }
});

test("daemon child receives only the selected profile, never a fallback workspace's config", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-spawn-argv-"));
  const old = Object.fromEntries(["PI_CODING_AGENT_DIR", "OMP_WEB_OMP_BIN"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "fallback");
  const recordedCwd = join(root, "recorded");
  mkdirSync(cwd);
  mkdirSync(recordedCwd);
  const bin = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  const source = 'console.log(JSON.stringify(process.argv.slice(2)));';
  if (process.platform === "win32") {
    writeFileSync(bin + ".cjs", source);
    writeFileSync(bin, `@"${process.execPath}" "${bin}.cjs" %*\r\n`);
  } else writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  saveProjectRegistry(parseProjectRegistry(JSON.stringify({ projects: [
    { path: cwd, launchConfig: { profile: "fallback" } },
    { path: recordedCwd, launchConfig: { extraArgs: ["--profile", "chosen", "--verbose"] } },
  ] })));
  for (const [recorded, profile] of [[recordedCwd, "chosen"], [null, undefined]]) {
    const result = await localHost.spawnRpc({ cwd, recordedCwd: recorded, sessionFile: join(root, "session.jsonl"), advisor: false });
    const lines = [];
    const errors = [];
    result.transport.onLine(line => lines.push(line));
    result.transport.onStderr(chunk => errors.push(chunk));
    const exit = await new Promise(resolve => result.transport.onExit((code) => resolve(code)));
    assert.equal(exit, 0, errors.join(""));
    const args = JSON.parse(lines[0]);
    const profiles = args.flatMap((arg, i) => arg === "--profile" ? [args[i + 1]] : []);
    assert.deepEqual(profiles, profile ? [profile] : []);
    assert.equal(args.filter(arg => arg === "--extension").length, 1);
  }
});
