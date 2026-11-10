"use strict";

// Local artifacts only. Publication means a reviewed GitHub fork commit, never npm.
const fs = process.getBuiltinModule("node:fs/promises");
const fsSync = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const { createHash } = process.getBuiltinModule("node:crypto");
const { spawn } = process.getBuiltinModule("node:child_process");
const { parseArgs } = process.getBuiltinModule("node:util");

const DEFAULT_SOURCE = path.resolve(__dirname, "..");
const UPSTREAM = "kahme247/ompweb";
const REQUIRED_RUNTIME = [
  "package.json", "dist/index.html", "dist/event-stream-worker.js", "bin/omp-web.js",
  "bin/omp-web-ui.js", "bin/omp-web-tray.js", "server/main.ts", "server/ui.ts",
  "scripts/windows/omp-web-service.ps1", "scripts/windows/omp-web-tray.ps1",
  "scripts/windows/control-tray.ps1", "scripts/windows/control-tray.vbs", "scripts/windows/web-service-ui.ps1",
];

function log(options, message) {
  const logger = options.logger ?? console;
  if (typeof logger === "function") logger(message);
  else logger.log(message);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function json(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function optionalJson(file) {
  try { return await json(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeReceipt(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function context(options) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("UI release automation requires Node.js 24 or newer");
  const sourceRoot = await fs.realpath(path.resolve(options.sourceRoot ?? DEFAULT_SOURCE));
  const metadata = await json(path.join(sourceRoot, "package.json"));
  if (typeof metadata.name !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error("Source package needs a name and a valid release version");
  }
  return { sourceRoot, metadata, cacheRoot: path.join(sourceRoot, "build", "ui-release") };
}

// Avoid cmd.exe quoting and .cmd spawning: invoke npm's JavaScript CLI with Node.
function npmCommand(sourceRoot) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...Object.entries(process.env).filter(([key]) => key.toUpperCase() === "PATH")
      .flatMap(([, value]) => value.split(path.delimiter))
      .map((directory) => path.join(directory.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  try { candidates.push(require.resolve("npm/bin/npm-cli.js", { paths: [sourceRoot] })); } catch { /* Not a local dependency. */ }
  for (const candidate of candidates) {
    if (candidate && /npm-cli\.js$/i.test(candidate) && fsSync.existsSync(candidate)) return [process.execPath, [candidate]];
  }
  if (process.platform !== "win32") return ["npm", []];
  throw new Error("Cannot locate npm-cli.js beside Node or on PATH; install npm with Node.js, or invoke through npm run");
}

function buildEnvironment(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OMP_WEB_|NODE_CHANNEL_|NODE_UNIQUE_ID$|NODE_OPTIONS$|BUN_OPTIONS$)/i.test(name)));
  return { ...env, ...overrides };
}

async function run(command, args, { sourceRoot, logger, capture = false, env = {} }) {
  log({ logger }, `$ ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: sourceRoot, windowsHide: true, shell: false,
      env: buildEnvironment(env),
      stdio: capture || logger ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    let failed;
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    } else if (logger) {
      // A lifecycle CLI reserves stdout for its JSON receipt. Build subprocesses
      // must use that caller's diagnostic sink too, not inherit stdout.
      child.stdout.on("data", (chunk) => log({ logger }, chunk.toString("utf8").trimEnd()));
      child.stderr.on("data", (chunk) => log({ logger }, chunk.toString("utf8").trimEnd()));
    }
    child.once("error", (error) => { failed = error; });
    child.once("close", (code, signal) => {
      if (failed) reject(new Error(`Cannot run ${command}: ${failed.message}`, { cause: failed }));
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolve(stdout.trim());
    });
  });
}

async function npm(args, ctx, options, capture = false) {
  const [command, prefix] = npmCommand(ctx.sourceRoot);
  return run(command, [...prefix, ...args], {
    sourceRoot: ctx.sourceRoot, logger: options.logger, capture,
    env: { ...options.checkEnv, NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false" },
  });
}

async function assertFiles(root, files) {
  for (const relative of files) {
    const stat = await fs.stat(path.join(root, relative));
    if (!stat.isFile() || !stat.size) throw new Error(`Release artifact is missing or empty: ${relative}`);
  }
}

async function inventory(root, { skip = [] } = {}) {
  const entries = {};
  async function walk(directory, prefix = "") {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip.includes(relative)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, relative);
      else if (entry.isFile()) entries[relative] = await hashFile(file);
      else throw new Error(`Unexpected link or special file in release inputs: ${relative}`);
    }
  }
  await walk(root);
  return entries;
}

async function nativeFingerprint(ctx) {
  const inputs = await inventory(path.join(ctx.sourceRoot, "native", "tray"), { skip: ["bin", "obj"] });
  for (const name of await fs.readdir(ctx.sourceRoot)) {
    if (/^(global\.json|Directory\.(Build\.(props|targets)|Packages\.props)|NuGet\.Config)$/i.test(name)) {
      inputs[`root/${name}`] = await hashFile(path.join(ctx.sourceRoot, name));
    }
  }
  return digest(JSON.stringify({ inputs, runtime: "win-x64", configuration: "Release", selfContained: false }));
}

async function buildNative(ctx, options) {
  const executable = path.join(ctx.sourceRoot, "bin", "omp-web-tray.exe");
  if (process.platform !== "win32") {
    await assertFiles(ctx.sourceRoot, ["bin/omp-web-tray.exe"]);
    log(options, "Not Windows: retaining the existing tracked tray executable (native source was not compiled).");
    return { executable, rebuilt: false, nativeCompiled: false };
  }
  const fingerprint = await nativeFingerprint(ctx);
  const receiptPath = path.join(ctx.cacheRoot, "native.json");
  const previous = await optionalJson(receiptPath);
  if (previous?.fingerprint === fingerprint && fsSync.existsSync(executable) && previous.executableHash === await hashFile(executable)) {
    log(options, `Reusing verified native executable: ${executable}`);
    return { executable, rebuilt: false, nativeCompiled: true, fingerprint };
  }
  const output = path.join(ctx.cacheRoot, "native");
  await run("dotnet", ["publish", path.join(ctx.sourceRoot, "native", "tray", "tray.csproj"),
    "--configuration", "Release", "--runtime", "win-x64", "--self-contained", "false", "--output", output, "--nologo"],
  { sourceRoot: ctx.sourceRoot, logger: options.logger });
  const published = path.join(output, "omp-web-tray.exe");
  await assertFiles(output, ["omp-web-tray.exe"]);
  const executableHash = await hashFile(published);
  if (!fsSync.existsSync(executable) || executableHash !== await hashFile(executable)) await fs.copyFile(published, executable);
  if (fingerprint !== await nativeFingerprint(ctx)) throw new Error("Native source changed during the build; retry from a stable checkout");
  await writeReceipt(receiptPath, { schema: 1, fingerprint, executableHash, builtAt: new Date().toISOString() });
  return { executable, rebuilt: true, nativeCompiled: true, fingerprint };
}

function buildPlan(ctx, options) {
  return [
    "Build client using npm run build",
    "Incrementally publish native/tray/tray.csproj for win-x64 on Windows; reuse matching native receipt",
    ...(options.verify ? ["Run npm run typecheck, npm run lint, npm test, npm run smoke (isolated smoke service)"] : []),
    `Write artifact receipts beneath ${ctx.cacheRoot}`,
  ];
}

async function buildRelease(options = {}) {
  const ctx = await context(options);
  const plan = buildPlan(ctx, options);
  if (options.dryRun) return { sourceRoot: ctx.sourceRoot, version: ctx.metadata.version, dryRun: true, plan };
  // Checks cannot inherit a running server's control tokens, update flags or user profile.
  const native = await buildNative(ctx, options);
  const checkHome = options.verify ? await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-release-check-")) : null;
  try {
    const checkOptions = checkHome ? { ...options, checkEnv: {
      HOME: checkHome, USERPROFILE: checkHome, PI_CODING_AGENT_DIR: path.join(checkHome, "agent"),
      APPDATA: path.join(checkHome, "AppData", "Roaming"), LOCALAPPDATA: path.join(checkHome, "AppData", "Local"),
      TEMP: path.join(checkHome, "tmp"), TMP: path.join(checkHome, "tmp"), TMPDIR: path.join(checkHome, "tmp"),
    } } : options;
    if (checkHome) {
      for (const directory of Object.values(checkOptions.checkEnv)) await fs.mkdir(directory, { recursive: true });
      await npm(["run", "typecheck"], ctx, checkOptions);
      await npm(["run", "lint"], ctx, checkOptions);
      await npm(["test"], ctx, checkOptions);
    }
    await npm(["run", "build"], ctx, options);
    await assertFiles(ctx.sourceRoot, REQUIRED_RUNTIME);
    if (options.verify) await npm(["run", "smoke"], ctx, checkOptions);
    const receiptPath = path.join(ctx.cacheRoot, "build.json");
    const result = {
      sourceRoot: ctx.sourceRoot, version: ctx.metadata.version, verified: Boolean(options.verify),
      artifacts: { clientRoot: path.join(ctx.sourceRoot, "dist"), nativeExecutable: native.executable },
      native, receiptPath, builtAt: new Date().toISOString(),
    };
    await writeReceipt(receiptPath, result);
    log(options, `Built client: ${result.artifacts.clientRoot}; tray: ${native.executable}`);
    return result;
  } finally {
    if (checkHome) await fs.rm(checkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function installBase(options) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.resolve(options.installBase ?? path.join(local, "Programs", "OMPweb-nanogram", "ui"));
}

// npm 10/11 arrays, single records, and newer package-name-keyed JSON maps.
function packRecord(output) {
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (error) { throw new Error("npm pack did not return valid --json output", { cause: error }); }
  const records = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.filename === "string") records.push(value);
    else for (const child of Object.values(value)) visit(child);
  }
  visit(parsed);
  if (records.length !== 1) throw new Error(`Expected one npm packed artifact, received ${records.length}`);
  const record = records[0];
  if (!record.filename.endsWith(".tgz") || path.basename(record.filename) !== record.filename || /[\\/]/.test(record.filename)) {
    throw new Error("npm returned an unsafe artifact filename");
  }
  return record;
}

async function validateStage(stageRoot, expected) {
  const manifestPath = path.join(stageRoot, "manifest.json");
  const manifest = await json(manifestPath);
  for (const key of ["sourceRoot", "version", "artifactHash", "dependencyRoot"]) {
    if (manifest[key] !== expected[key]) throw new Error(`Existing immutable stage has mismatched ${key}: ${stageRoot}`);
  }
  if (manifest.schema !== 1 || !manifest.files || typeof manifest.files !== "object") throw new Error(`Invalid stage manifest: ${manifestPath}`);
  if (await hashFile(path.join(stageRoot, "artifact.tgz")) !== expected.artifactHash) throw new Error(`Staged archive was modified: ${stageRoot}`);
  const packageRoot = path.join(stageRoot, "package");
  const actual = await inventory(packageRoot, { skip: ["node_modules"] });
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error(`Immutable stage content was modified: ${packageRoot}`);
  const dependencies = path.join(packageRoot, "node_modules");
  if (!(await fs.lstat(dependencies)).isSymbolicLink() || await fs.realpath(dependencies) !== expected.dependencyRoot) {
    throw new Error(`Stage dependencies no longer point to the source dependency directory: ${dependencies}`);
  }
  await assertFiles(packageRoot, [...REQUIRED_RUNTIME, "bin/omp-web-tray.exe"]);
  const metadata = await json(path.join(packageRoot, "package.json"));
  if (metadata.version !== expected.version) throw new Error("Stage package version does not match its receipt");
  return { packageRoot, stageRoot, sourceRoot: expected.sourceRoot, version: expected.version, artifactHash: expected.artifactHash, manifestPath };
}

async function stageRelease(options = {}) {
  const ctx = await context(options);
  const base = installBase(options);
  if (options.dryRun) {
    return {
      packageRoot: null, stageRoot: null, sourceRoot: ctx.sourceRoot, version: ctx.metadata.version,
      artifactHash: null, manifestPath: null, dryRun: true,
      plan: [...buildPlan(ctx, options), "npm pack --ignore-scripts --json into ignored temporary storage",
        `Extract and verify immutable content-addressed stage beneath ${base}; junction node_modules to source dependencies`],
    };
  }
  const dependencyRoot = await fs.realpath(path.join(ctx.sourceRoot, "node_modules"));
  if (!(await fs.stat(dependencyRoot)).isDirectory()) throw new Error("Install source dependencies before staging");
  const build = await buildRelease(options);
  await fs.mkdir(ctx.cacheRoot, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(ctx.cacheRoot, "pack-"));
  let pending;
  try {
    const record = packRecord(await npm(["pack", "--ignore-scripts", "--json", "--workspaces=false", "--pack-destination", temporary], ctx, options, true));
    const archive = path.join(temporary, record.filename);
    const artifactHash = await hashFile(archive);
    const expected = { sourceRoot: ctx.sourceRoot, version: ctx.metadata.version, artifactHash, dependencyRoot };
    // The source suffix prevents identical packages from sharing mutable dependency junctions across checkouts.
    const stageRoot = path.join(base, `${ctx.metadata.version}-${artifactHash.slice(0, 16)}-${digest(ctx.sourceRoot).slice(0, 8)}`);
    if (fsSync.existsSync(stageRoot)) {
      const result = await validateStage(stageRoot, expected);
      log(options, `Reusing verified stage: ${stageRoot}`);
      return result;
    }
    await fs.mkdir(base, { recursive: true });
    pending = await fs.mkdtemp(path.join(base, ".staging-"));
    await fs.copyFile(archive, path.join(pending, "artifact.tgz"));
    // Check paths before extraction, including archives returned by a nonstandard npm installation.
    const listing = await run("tar", ["-tzf", archive], { sourceRoot: ctx.sourceRoot, logger: options.logger, capture: true });
    for (const member of listing.split(/\r?\n/)) {
      const parts = member.replace(/\/$/, "").split("/");
      if (parts[0] !== "package" || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) {
        throw new Error(`Unsafe npm archive member: ${member}`);
      }
    }
    await run("tar", ["-xzf", archive, "-C", pending], { sourceRoot: ctx.sourceRoot, logger: options.logger });
    const packageRoot = path.join(pending, "package");
    const files = await inventory(packageRoot);
    if (Object.keys(files).some((name) => name === "node_modules" || name.startsWith("node_modules/"))) {
      throw new Error("The packed runtime unexpectedly bundles node_modules; refusing to replace it with a junction");
    }
    await assertFiles(packageRoot, [...REQUIRED_RUNTIME, "bin/omp-web-tray.exe"]);
    await fs.symlink(dependencyRoot, path.join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeReceipt(path.join(pending, "manifest.json"), {
      schema: 1, ...expected, packageName: ctx.metadata.name, createdAt: new Date().toISOString(),
      verified: build.verified, dependencies: "shared-source-junction", files,
    });
    await validateStage(pending, expected);
    try { await fs.rename(pending, stageRoot); pending = null; }
    catch (error) {
      // Another invocation can publish the same immutable stage while this one packs it.
      if (!fsSync.existsSync(stageRoot)) throw error;
      await validateStage(stageRoot, expected);
    }
    const result = await validateStage(stageRoot, expected);
    await writeReceipt(path.join(ctx.cacheRoot, "stage.json"), { ...result, stagedAt: new Date().toISOString() });
    log(options, `Staged ${ctx.metadata.name}@${ctx.metadata.version}: ${result.packageRoot}`);
    return result;
  } finally {
    if (pending) await fs.rm(pending, { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function githubRepository(value) {
  if (typeof value !== "string") return null;
  const match = value.replace(/^git\+/, "").match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return match?.[1].toLowerCase() ?? null;
}

async function git(ctx, options, args) {
  // Do not let a caller's repository-location overrides redirect the publication.
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/i.test(key)) env[key] = undefined;
  }
  return run("git", ["--no-optional-locks", "-C", ctx.sourceRoot, ...args], {
    sourceRoot: ctx.sourceRoot, logger: options.logger, capture: true, env,
  });
}

async function publicationState(ctx, options) {
  const configured = githubRepository(typeof ctx.metadata.repository === "string" ? ctx.metadata.repository : ctx.metadata.repository?.url);
  if (!configured || configured === UPSTREAM) throw new Error("Publication requires an explicitly configured GitHub fork repository; upstream is forbidden");
  if (options.remote && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.remote)) throw new Error("Invalid Git remote name");
  const root = await fs.realpath(await git(ctx, options, ["rev-parse", "--show-toplevel"]));
  if (root !== ctx.sourceRoot) throw new Error("--source must be the Git checkout root for publication");
  const head = await git(ctx, options, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const names = options.remote ? [options.remote] : (await git(ctx, options, ["remote"])).split(/\r?\n/).filter(Boolean);
  let remote;
  let destination;
  for (const name of names) {
    const urls = (await git(ctx, options, ["remote", "get-url", "--push", "--all", name])).split(/\r?\n/);
    if (urls.length === 1 && githubRepository(urls[0]) === configured) {
      remote = name;
      destination = urls[0];
      break;
    }
  }
  if (!destination && !options.remote) {
    // Source checkouts commonly keep origin pointing at upstream. The package's
    // explicit fork identity is still an unambiguous, single push destination.
    remote = null;
    destination = `https://github.com/${configured}.git`;
  }
  if (!destination) throw new Error(`No matching ${options.remote} remote has exactly one GitHub push URL for fork ${configured}`);
  // A canonical URL, not the remote name, avoids push refspecs/mirror settings and extra push URLs.
  const status = await git(ctx, options, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { head, remote, destination, repository: configured, clean: status === "", status };
}

async function publishRelease(options = {}) {
  const ctx = await context(options);
  const before = await publicationState(ctx, options);
  const blockers = [];
  if (!before.clean) blockers.push("Source must be clean and committed (including the tracked native executable)");
  if (options.reviewedHead && options.reviewedHead !== before.head) blockers.push(`Reviewed HEAD does not match current commit ${before.head}`);
  const result = {
    sourceRoot: ctx.sourceRoot, version: ctx.metadata.version, ...before,
    refspec: `${before.head}:refs/heads/main`, verified: false, published: false,
  };
  if (options.dryRun) {
    return { ...result, dryRun: true, blockers,
      plan: [...buildPlan(ctx, { ...options, verify: true }), `Push only ${before.head} to ${before.repository}:main (no tags, force, or npm publication)`] };
  }
  if (blockers.length) throw new Error(blockers.join("; "));
  await buildRelease({ ...options, verify: true });
  const after = await publicationState(ctx, options);
  if (!after.clean || after.head !== before.head || after.destination !== before.destination || after.repository !== before.repository) {
    throw new Error("Source, HEAD, or publication destination changed during verification; review and commit the resulting changes before publishing");
  }
  // --no-follow-tags neutralizes push.followTags; --recurse-submodules=no never pushes another repository.
  const output = await git(ctx, options, ["-c", "push.followTags=false", "-c", "remote.pushDefault=", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", before.destination, result.refspec]);
  const receiptPath = path.join(ctx.cacheRoot, "publish.json");
  const receipt = { ...result, verified: true, published: true, publishedAt: new Date().toISOString(), output, receiptPath };
  await writeReceipt(receiptPath, receipt);
  log(options, `Published reviewed commit ${before.head} to ${before.repository}:main`);
  return receipt;
}

async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    source: { type: "string" }, "install-base": { type: "string" }, verify: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }, remote: { type: "string" }, "reviewed-head": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("Usage: node scripts/ui-release.cjs <build|stage|publish> [--source PATH] [--verify] [--dry-run]\n  stage: [--install-base PATH]\n  publish: [--remote NAME] [--reviewed-head FULL_SHA] (always verifies; auto-selects configured fork remote)\nDry-run never builds, writes files, runs checks, or pushes. Publish never uses npm registry, commits, tags, or force pushes.");
    return;
  }
  if (positionals.length !== 1 || !["build", "stage", "publish"].includes(positionals[0])) throw new Error("Expected one subcommand: build, stage, or publish (use --help)");
  const command = positionals[0];
  if (values["install-base"] && command !== "stage") throw new Error("--install-base applies only to stage");
  if ((values.remote || values["reviewed-head"]) && command !== "publish") throw new Error("--remote and --reviewed-head apply only to publish");
  const options = {
    sourceRoot: values.source, installBase: values["install-base"], verify: values.verify,
    dryRun: values["dry-run"], remote: values.remote, reviewedHead: values["reviewed-head"],
  };
  const handlers = { build: buildRelease, stage: stageRelease, publish: publishRelease };
  const result = await handlers[command](options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

module.exports = { buildRelease, stageRelease, publishRelease, main };
if (require.main === module) {
  main().catch((error) => { console.error(`UI release failed: ${error.message}`); process.exitCode = 1; });
}
