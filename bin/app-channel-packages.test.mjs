import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { overlayMainSource, prepareChannelPackage } = require("./app-channel-packages.js");
const implementation = readFileSync(new URL("./app-channel-packages.js", import.meta.url), "utf8");
const revision = "f8de44d98655122ac4675892a6e8f998680d6254";
const upstreamUrl = "https://github.com/kahme247/ompweb.git";
const shared = ["components/AppChannelSelector.tsx", "lib/app-channel.ts", "lib/app-channel-update-route.ts", "app/api/app-channel/route.ts"];
const locales = ["en", "ja", "zh-CN", "zh-TW"];
const card = `                {/* ompweb app update card */}
                <section style={{ padding: 14, border: appUpdateIsAvailable ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>{t("settingsConfig.appLabel")}</div>
                  <div>{appUpdatesDisabled ? t("settingsConfig.updatesDisabled") : "status"}</div>
                  {appUpdateMessage && <Alert variant={appUpdateMessage.toLowerCase().includes("fail") || appUpdateMessage.toLowerCase().includes("error") ? "error" : "info"} description={appUpdateMessage} onDismiss={() => setAppUpdateMessage(null)} />}
                </section>`;
const settings = `"use client";\nimport { ToggleSwitch } from "@/components/ui/ToggleSwitch";\nexport function SettingsConfig() { return <>\n${card}\n                <section>unrelated upstream UI</section>\n</>; }\n`;
const routes = 'import * as appUpdate from "@/app/api/app-update/route";\nexport const ROUTE_MODULES = {\n  "app-update": appUpdate,\n};\n';

async function put(root, relative, content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(next);
      else {
        hash.update(next);
        hash.update(await readFile(path.join(root, next)));
      }
    }
  }
  await visit("");
  return hash.digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ompweb-channel-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managerRoot = path.join(root, "fork manager");
  const sourceRoot = path.join(root, "upstream");
  const channelsRoot = path.join(root, "channels");
  const metadata = { name: "@kahme247/ompweb", version: "0.6.0", homepage: "https://github.com/kahme247/ompweb#readme", repository: { type: "git", url: `git+${upstreamUrl}` }, scripts: { build: "bun scripts/build-client.ts" } };
  await put(sourceRoot, "package.json", JSON.stringify(metadata));
  await put(sourceRoot, "components/SettingsConfig.tsx", settings);
  await put(sourceRoot, "lib/project-command-env.ts", 'export const OMP_WEB_SECRET_ENV_VARS: readonly string[] = [\n  "OMP_WEB_PASSWORD",\n];\n');
  await put(sourceRoot, "lib/windows-service.ts", 'export function getRepoRoot(): string {\n  return "upstream";\n}\n');
  await put(sourceRoot, "server/routes.ts", routes);
  await put(sourceRoot, "app/api/app-update/route.ts", "export async function POST() { throw new Error('original npm updater'); }\n");
  await put(sourceRoot, "bin/omp-web.js", "// upstream launcher unchanged\n");
  await put(sourceRoot, "server/main.ts", "// upstream server unchanged\n");
  await put(sourceRoot, "lib/rpc-manager.ts", "// upstream behavior unchanged\n");
  await put(managerRoot, "package.json", JSON.stringify({ ...metadata, version: "0.6.0-n1", repository: { url: "git+https://github.com/nanogram/ompweb.git" } }));
  for (const file of shared) await put(managerRoot, file, `// shared ${file}\n`);
  for (const locale of locales) {
    if (locale !== "zh-TW") await put(sourceRoot, `lib/i18n/locales/${locale}.json`, JSON.stringify({ "upstream.identity": locale, "settingsConfig.appLabel": "ompweb" }));
    await put(managerRoot, `lib/i18n/locales/${locale}.json`, JSON.stringify({ "appChannel.title": `Channel ${locale}`, "appChannel.main": "Main", "fork.only": "must not be copied" }));
  }
  return { root, managerRoot, sourceRoot, channelsRoot, metadata };
}

function harness(f, options = {}) {
  const calls = [];
  const terminated = [];
  const fakeModule = { exports: {}, require(file) {
    if (file === "./process-lifecycle.js") return { terminateChildProcess: async (child) => {
      terminated.push(child);
      child.emit("close", null, "SIGKILL");
      return true;
    } };
    return { resolveBunBinary: () => "owned-manager-bun" };
  } };
  const spawn = (file, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ options: spawnOptions });
    queueMicrotask(async () => {
      try {
        const command = file === "git" ? args[4] : file === "owned-manager-bun" ? "build" : "install";
        if (options.holdAt === command) { options.controller.abort(new Error("Supervisor shutdown")); return; }
        if (options.failAt === command) {
          child.stderr.emit("data", "intentional preparation failure");
          child.emit("close", 2, null);
          return;
        }
        if (command === "ls-remote") child.stdout.emit("data", options.remote ?? `${revision}\trefs/heads/main\n`);
        if (command === "checkout") await cp(f.sourceRoot, spawnOptions.cwd, { recursive: true });
        if (command === "rev-parse") child.stdout.emit("data", options.head ?? `${revision}\n`);
        if (command === "build" && !options.missingBuild) {
          await put(spawnOptions.cwd, "dist/index.html", "<html>built upstream</html>");
          await put(spawnOptions.cwd, "dist/event-stream-worker.js", "// built worker");
        }
        child.emit("close", 0, null);
      } catch (error) {
        child.emit("error", error);
        child.emit("close", 1, null);
      }
    });
    return child;
  };
  const fakeProcess = {
    platform: options.platform ?? process.platform,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: "cmd.exe", HOME: "/real-private-home", PI_CODING_AGENT_DIR: "/real-private-agent", OPENAI_API_KEY: "private-provider-key", OMP_WEB_CHANNEL_CONTROL_TOKEN: "private-control-token", NPM_TOKEN: "private-npm-token", NODE_OPTIONS: "--require=/private/injection.js", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "private-helper", HTTPS_PROXY: "http://user:password@proxy" },
    getBuiltinModule: (name) => name === "node:child_process" ? { spawn } : process.getBuiltinModule(name),
  };
  vm.runInNewContext(implementation, { module: fakeModule, process: fakeProcess }, { filename: "app-channel-packages.js" });
  return { ...fakeModule.exports, calls, terminated };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("fork returns the current manager install without source work or cache writes", async (t) => {
  const f = await fixture(t);
  const result = await prepareChannelPackage({ channel: "fork", managerRoot: f.managerRoot, channelsRoot: f.channelsRoot, onProgress() { throw new Error("must not stage fork"); } });
  assert.deepEqual(result, { channel: "fork", packageDir: await process.getBuiltinModule("node:fs/promises").realpath(f.managerRoot), version: "0.6.0-n1", revision: null });
  await assert.rejects(readdir(f.channelsRoot), { code: "ENOENT" });
  await assert.rejects(prepareChannelPackage({ channel: "other", managerRoot: f.managerRoot }), /Unknown application channel/);
});


test("incompatible overlay preflights fail without partially modifying upstream", async (t) => {
  for (const failure of ["duplicate-card", "different-card", "missing-route", "missing-locale", "fork-identity"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      if (failure === "duplicate-card") await put(f.sourceRoot, "components/SettingsConfig.tsx", settings + card);
      if (failure === "different-card") await put(f.sourceRoot, "components/SettingsConfig.tsx", settings.replace("gap: 10", "gap: 11"));
      if (failure === "missing-route") await put(f.sourceRoot, "server/routes.ts", "// changed route registry");
      if (failure === "missing-locale") await put(f.managerRoot, "lib/i18n/locales/zh-TW.json", "{}");
      if (failure === "fork-identity") await put(f.sourceRoot, "package.json", await readFile(path.join(f.managerRoot, "package.json")));
      const before = await treeDigest(f.sourceRoot);
      await assert.rejects(overlayMainSource(f), /Incompatible|Missing channel|actual kahme247/);
      assert.equal(await treeDigest(f.sourceRoot), before);
    });
  }
});

test("main publishes a separate ready upstream install with isolated preparation state", async (t) => {
  const f = await fixture(t);
  const h = harness(f);
  const result = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.deepEqual(plain(result), { channel: "main", packageDir: result.packageDir, version: "0.6.0", revision });
  assert.equal(path.dirname(result.packageDir), await process.getBuiltinModule("node:fs/promises").realpath(f.channelsRoot));
  assert.notEqual(result.packageDir, f.managerRoot);
  const marker = JSON.parse(await readFile(path.join(result.packageDir, ".omp-web-channel.json"), "utf8"));
  assert.equal(marker.revision, revision);
  assert.equal(marker.repository, upstreamUrl);
  assert.match(marker.overlayFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(path.join(result.packageDir, "package.json"), "utf8")).repository.url, `git+${upstreamUrl}`);
  assert.deepEqual(await readdir(f.channelsRoot), [path.basename(result.packageDir)]);
  assert.equal(JSON.parse(await readFile(path.join(f.managerRoot, "package.json"), "utf8")).version, "0.6.0-n1");
  for (const { options } of h.calls) {
    assert.ok(options.env.HOME.startsWith(f.channelsRoot));
    assert.ok(options.env.PI_CODING_AGENT_DIR.startsWith(options.env.HOME));
    assert.equal(options.env.USERPROFILE, options.env.HOME);
    assert.equal(options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    for (const key of ["OPENAI_API_KEY", "OMP_WEB_CHANNEL_CONTROL_TOKEN", "NPM_TOKEN", "NODE_OPTIONS", "GIT_CONFIG_COUNT", "HTTPS_PROXY"]) assert.equal(options.env[key], undefined);
  }
});


test("source, dependency and build failures preserve old installs and remove only owned staging", async (t) => {
  for (const options of [{ failAt: "fetch" }, { failAt: "install" }, { failAt: "build" }, { head: "a".repeat(40) }, { remote: "not a revision" }, { missingBuild: true }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = await fixture(t);
      const managerBefore = await treeDigest(f.managerRoot);
      await put(f.channelsRoot, "previous-ready/sentinel", "last known working installation");
      const h = harness(f, options);
      await assert.rejects(h.prepareChannelPackage({ ...f, channel: "main" }));
      assert.deepEqual(await readdir(f.channelsRoot), ["previous-ready"]);
      assert.equal(await readFile(path.join(f.channelsRoot, "previous-ready/sentinel"), "utf8"), "last known working installation");
      assert.equal(await treeDigest(f.managerRoot), managerBefore);
    });
  }
});

test("concurrent identical preparations publish at most one reusable ready package", async (t) => {
  const f = await fixture(t);
  // Separate module instances exercise the filesystem publication race, not an in-memory singleton.
  const aInstaller = harness(f);
  const bInstaller = harness(f);
  const [a, b] = await Promise.all([aInstaller.prepareChannelPackage({ ...f, channel: "main" }), bInstaller.prepareChannelPackage({ ...f, channel: "main" })]);
  assert.equal(a.packageDir, b.packageDir);
  assert.equal(a.revision, b.revision);
  assert.deepEqual(await readdir(f.channelsRoot), [path.basename(a.packageDir)]);
});

test("an unchanged revision and overlay reuse ready output without reinstalling or replacing it", async (t) => {
  const f = await fixture(t);
  const options = {};
  const h = harness(f, options);
  const first = await h.prepareChannelPackage({ ...f, channel: "main" });
  await put(first.packageDir, "ready-sentinel", "owned ready package must not be replaced");
  const before = await treeDigest(first.packageDir);
  options.failAt = "install";
  const second = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.equal(second.packageDir, first.packageDir);
  assert.equal(await treeDigest(first.packageDir), before);
  assert.deepEqual(await readdir(f.channelsRoot), [path.basename(first.packageDir)]);
});

test("shared control and translation changes create distinct caches while unrelated locale changes do not", async (t) => {
  const f = await fixture(t);
  const h = harness(f);
  const first = await h.prepareChannelPackage({ ...f, channel: "main" });
  const firstDigest = await treeDigest(first.packageDir);
  await put(f.managerRoot, shared[0], "export const changedChannelControls = true;\n");
  const controlsChanged = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.notEqual(controlsChanged.packageDir, first.packageDir);
  const translations = JSON.parse(await readFile(path.join(f.managerRoot, "lib/i18n/locales/en.json"), "utf8"));
  translations["appChannel.title"] = "Changed channel controls";
  await put(f.managerRoot, "lib/i18n/locales/en.json", JSON.stringify(translations));
  const translationsChanged = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.notEqual(translationsChanged.packageDir, controlsChanged.packageDir);
  translations["fork.only"] = "unrelated changed fork string";
  await put(f.managerRoot, "lib/i18n/locales/en.json", JSON.stringify(translations));
  const unrelatedChanged = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.equal(unrelatedChanged.packageDir, translationsChanged.packageDir);
  assert.equal(await treeDigest(first.packageDir), firstDigest);
  assert.equal((await readdir(f.channelsRoot)).length, 3);
});

test("a damaged ready cache is never overwritten or silently rebuilt", async (t) => {
  const f = await fixture(t);
  const h = harness(f);
  const ready = await h.prepareChannelPackage({ ...f, channel: "main" });
  await rm(path.join(ready.packageDir, "dist/index.html"));
  const before = await treeDigest(ready.packageDir);
  await assert.rejects(h.prepareChannelPackage({ ...f, channel: "main" }), /ENOENT|missing/);
  assert.equal(await treeDigest(ready.packageDir), before);
  assert.deepEqual(await readdir(f.channelsRoot), [path.basename(ready.packageDir)]);
});

test("a newer upstream revision gets its own cache and a failed newer build preserves the previous ready revision", async (t) => {
  const f = await fixture(t);
  const options = {};
  const h = harness(f, options);
  const old = await h.prepareChannelPackage({ ...f, channel: "main" });
  const before = await treeDigest(old.packageDir);
  const nextRevision = "a".repeat(40);
  options.remote = `${nextRevision}\trefs/heads/main\n`;
  options.head = `${nextRevision}\n`;
  options.failAt = "build";
  await assert.rejects(h.prepareChannelPackage({ ...f, channel: "main" }), /failed/);
  assert.deepEqual(await readdir(f.channelsRoot), [path.basename(old.packageDir)]);
  assert.equal(await treeDigest(old.packageDir), before);
  delete options.failAt;
  const next = await h.prepareChannelPackage({ ...f, channel: "main" });
  assert.notEqual(next.packageDir, old.packageDir);
  assert.equal(next.revision, nextRevision);
  assert.equal(await treeDigest(old.packageDir), before);
  assert.equal((await readdir(f.channelsRoot)).length, 2);
});

test("supervisor cancellation reaps its owned child before deleting incomplete staging", async (t) => {
  const f = await fixture(t);
  await put(f.channelsRoot, "previous-ready/sentinel", "keep");
  const controller = new AbortController();
  const h = harness(f, { holdAt: "install", controller });
  await assert.rejects(h.prepareChannelPackage({ ...f, channel: "main", signal: controller.signal }), /Supervisor shutdown/);
  assert.equal(h.terminated.length, 1);
  assert.deepEqual(await readdir(f.channelsRoot), ["previous-ready"]);
  await assert.rejects(h.prepareChannelPackage({ ...f, channel: "main", signal: controller.signal }), /Supervisor shutdown/);
  assert.deepEqual(await readdir(f.channelsRoot), ["previous-ready"]);
});

test("Windows can launch a cached executable below a long agent directory", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  f.channelsRoot = path.join(f.root, "nested-".repeat(7), "channels");
  const result = await harness(f).prepareChannelPackage({ ...f, channel: "main" });
  const executable = path.join(result.packageDir, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  await cp(path.join(system32, "where.exe"), executable);
  const output = await new Promise((resolve, reject) => execFile(executable, ["cmd.exe"], {
    windowsHide: true, timeout: 10_000, env: { ...process.env, PATH: system32, Path: system32 },
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.match(output, /cmd\.exe/i);
});
