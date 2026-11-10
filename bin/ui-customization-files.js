"use strict";

const fs = module.require("node:fs");
const path = module.require("node:path");
const os = module.require("node:os");
const { createHash, randomUUID } = module.require("node:crypto");

const SNAPSHOT_DIRECTORIES = ["app", "bin", "components", "hooks", "lib", "public", "scripts", "server"];
const SNAPSHOT_FILES = ["package.json", "tsconfig.json", "bunfig.toml", "instrumentation.node.ts", "proxy.ts"];
const STATUS_FILE = "public/ui-customization.json";
const LIST_LIMIT = 100;
const DISPLAY_FILES = new Set([
  "components/MarkdownBody.tsx", "components/MarkdownCode.tsx", "components/MessageView.tsx",
  "components/MessageView-tool-format.ts", "components/MessageCopyActions.tsx", "components/ChatInput-banners.tsx",
  "components/ComposerPanels.tsx", "components/TodoList.tsx",
  "lib/markdown.ts", "lib/syntax-highlight.ts",
]);
const OMIT_DIRECTORIES = new Set(["node_modules", "tests", "__tests__", "__fixtures__", "fixtures", "cache", "coverage", "dist", "build"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".json", ".toml", ".svg", ".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".md", ".txt", ".ps1", ".sh", ".cmd", ".bat", ".exe", ".dll", ".wasm"]);

// Paths are portable, canonical checkout-relative names, never user-supplied filesystem paths.
function validRelativePath(relative) {
  return typeof relative === "string" && relative.length > 0 && !/[\\:\x00-\x1f<>"|?*]/.test(relative)
    && relative.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function includedSourcePath(relative) {
  if (!validRelativePath(relative)) return false;
  const parts = relative.split("/");
  if (parts.some((part) => part.startsWith(".") || OMIT_DIRECTORIES.has(part.toLowerCase()))) return false;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relative)
    && !/^(?:auth|credentials|tokens?)\.(?:json|ya?ml)$/i.test(parts[parts.length - 1])
    && !/\.(?:snap|tsbuildinfo)$/i.test(relative);
}

/** Explicit display/style opt-in, not a claim that arbitrary frontend code is safe. */
function isUiCustomizationFile(relative) {
  if (!includedSourcePath(relative) || /^app\/api(?:\/|$)/i.test(relative)) return false;
  if (/^(?:app|components|public)\/.+\.css$/.test(relative)) return true;
  if (DISPLAY_FILES.has(relative) || /^components\/MessageView-[^/]+\.tsx$/.test(relative)) return true;
  return /^components\/display\/.+\.(?:ts|tsx|js|jsx|css)$/.test(relative)
    || /^lib\/display\/.+\.(?:ts|tsx|js|jsx)$/.test(relative);
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function safePath(root, relative, createParents = false) {
  if (!validRelativePath(relative)) throw new Error(`Unsafe customization path: ${relative}`);
  const parts = relative.split("/");
  let current = root;
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error("Customization root was replaced or linked");
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let info;
    try { info = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (i === parts.length - 1) return current;
      if (!createParents) return current;
      fs.mkdirSync(current, { mode: 0o700 });
      info = fs.lstatSync(current);
    }
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not customization sources: ${relative}`);
    if (i !== parts.length - 1 && !info.isDirectory()) throw new Error(`Customization parent is not a directory: ${relative}`);
    if (!contained(root, fs.realpathSync(current))) throw new Error(`Customization path escapes its root: ${relative}`);
  }
  return current;
}
function stamp(info) { return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":"); }
function readSource(root, relative) {
  const file = safePath(root, relative);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular source file: ${relative}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (stamp(before) !== stamp(opened)) throw new Error(`Source changed while opening: ${relative}`);
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    safePath(root, relative);
    if (stamp(opened) !== stamp(after) || stamp(after) !== stamp(fs.lstatSync(file))) throw new Error(`Source changed while reading: ${relative}`);
    return { data, stamp: stamp(after), digest: createHash("sha256").update(data).digest("hex") };
  } finally { fs.closeSync(descriptor); }
}
function scanSource(root, previous, changes) {
  const files = changes ? new Map(previous) : new Map();
  function visit(relative) {
    if (!includedSourcePath(relative)) return;
    const file = safePath(root, relative);
    let info;
    try { info = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(relative + "/" + name);
    } else if (info.isFile()) {
      // Authentication/history API directories contain code, not saved state.
      // Copy only runtime source/assets; never transcripts, databases or tokens.
      if (SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) files.set(relative, { stamp: stamp(info) });
    } else throw new Error(`Not a regular source file: ${relative}`);
  }
  if (changes) {
    for (const relative of changes) {
      if (!validRelativePath(relative) || ![...SNAPSHOT_DIRECTORIES, ...SNAPSHOT_FILES].some((name) => relative === name || relative.startsWith(name + "/"))) {
        throw new Error(`Unsafe customization change: ${relative}`);
      }
      for (const name of files.keys()) if (name === relative || name.startsWith(relative + "/")) files.delete(name);
      visit(relative);
    }
  } else for (const relative of [...SNAPSHOT_DIRECTORIES, ...SNAPSHOT_FILES]) visit(relative);
  return files;
}

/** Watch only runtime roots, never the linked dependency tree or private state. */
function watchCustomizationSource(sourceRoot, changed, failed) {
  const watchers = [];
  try {
    for (const directory of SNAPSHOT_DIRECTORIES) {
      const watcher = fs.watch(path.join(sourceRoot, directory), { recursive: true }, (_event, filename) => {
        if (filename === null) { changed(null); return; }
        const relative = directory + "/" + String(filename).replaceAll("\\", "/");
        if (includedSourcePath(relative)) changed(relative);
      });
      watcher.on("error", failed);
      watchers.push(watcher);
    }
    const root = fs.watch(sourceRoot, (event, filename) => {
      if (filename === null) changed(null);
      else if (SNAPSHOT_FILES.includes(String(filename))) changed(String(filename));
      else if (event === "rename" && SNAPSHOT_DIRECTORIES.includes(String(filename))) {
        failed(new Error(`Source directory ${filename} was replaced; restart only the GUI preview`));
      }
    });
    root.on("error", failed);
    watchers.push(root);
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}

/** Publish complete files, retaining the previous source if replacement fails. */
function writeCompleteFile(file, data, { rename = fs.renameSync, platform = process.platform } = {}) {
  const temporary = path.join(path.dirname(file), ".ui-" + randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    try {
      rename(temporary, file);
    } catch (error) {
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      // Bun can map a Windows source so replacement fails while rename-away
      // still works. Never truncate a served module; stage, move and roll back.
      const previous = path.join(path.dirname(file), ".ui-previous-" + randomUUID() + ".tmp");
      rename(file, previous);
      try { rename(temporary, file); } catch (replacementError) {
        rename(previous, file);
        throw replacementError;
      }
      // A mapped old inode may remain until Bun releases it; the private
      // snapshot's shutdown cleanup removes any retained previous source.
      try { fs.rmSync(previous, { force: true }); } catch { /* published successfully */ }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}

function validateSource(source) {
  const sourceRoot = fs.realpathSync(path.resolve(source));
  if (!fs.statSync(sourceRoot).isDirectory()) throw new Error("Customization source must be a checkout directory");
  for (const relative of SNAPSHOT_DIRECTORIES) {
    const file = safePath(sourceRoot, relative);
    if (!fs.statSync(file).isDirectory()) throw new Error(`Customization source needs ${relative}/`);
  }
  for (const relative of [...SNAPSHOT_FILES, "app/index.html", "app/client.tsx", "app/globals.css", "server/ui.ts", "server/ui-link.ts"]) {
    if (!fs.statSync(safePath(sourceRoot, relative)).isFile()) throw new Error(`Customization source needs ${relative}`);
  }
  const dependencies = fs.realpathSync(path.join(sourceRoot, "node_modules"));
  if (!fs.statSync(dependencies).isDirectory()) throw new Error("Customization source needs installed node_modules; run npm install in the checkout");
  const resolve = module.require("node:module").createRequire(path.join(sourceRoot, "package.json")).resolve;
  for (const dependency of ["react", "react-dom", "bun-plugin-tailwind"]) {
    try {
      if (!fs.statSync(path.join(dependencies, dependency)).isDirectory()) throw new Error("Missing installed package");
      resolve(dependency);
    } catch { throw new Error(`Customization source needs installed ${dependency}; run npm install in the checkout`); }
  }
  return { sourceRoot, dependencies };
}

/** Private source-only snapshot. The sole deliberate link is installed node_modules. */
function createCustomizationWorkspace(source, { temporaryRoot = os.tmpdir(), writeFile = writeCompleteFile } = {}) {
  const { sourceRoot, dependencies } = validateSource(source);
  const snapshotRoot = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, "owui-")));
  const identity = fs.lstatSync(snapshotRoot);
  let closed = false;
  let baseline;
  let served;
  let observed;
  let published = "";
  const dependencyCache = new Map();
  const state = { enabled: true, sourceRoot, appliedRevision: 0, appliedFiles: [], deferredFiles: [], lastError: null };
  function status() { return { ...state, appliedFiles: [...state.appliedFiles], deferredFiles: [...state.deferredFiles] }; }
  function publish() {
    const json = JSON.stringify(state, null, 2) + "\n";
    if (json === published) return;
    writeCompleteFile(safePath(snapshotRoot, STATUS_FILE, true), json);
    published = json;
  }
  function cleanup() {
    if (closed) return;
    const info = fs.lstatSync(snapshotRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino || fs.realpathSync(snapshotRoot) !== snapshotRoot) {
      throw new Error("Refusing to remove a replaced customization snapshot");
    }
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    closed = true;
  }
  try {
    fs.chmodSync(snapshotRoot, 0o700);
    if (contained(sourceRoot, snapshotRoot)) throw new Error("Customization temporary workspace must be outside the source checkout");
    observed = scanSource(sourceRoot);
    baseline = new Map();
    for (const relative of SNAPSHOT_DIRECTORIES) fs.mkdirSync(path.join(snapshotRoot, relative), { mode: 0o700 });
    for (const [relative] of observed) {
      if (relative === STATUS_FILE) continue; // The launcher, never the checkout, owns public status.
      const entry = readSource(sourceRoot, relative);
      writeCompleteFile(safePath(snapshotRoot, relative, true), entry.data);
      observed.set(relative, { stamp: entry.stamp, digest: entry.digest });
      baseline.set(relative, entry.digest);
    }
    observed.delete(STATUS_FILE);
    served = new Map(baseline);
    fs.symlinkSync(dependencies, path.join(snapshotRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    publish();
  } catch (error) {
    cleanup();
    throw error;
  }

  // Keep the old renderer when its new local imports belong to a deferred
  // change. Do not widen the UI allowlist to pull backend/control code into HMR.
  function deferredDependencies(current) {
    const blocked = new Set([...new Set([...served.keys(), ...current.keys()])]
      .filter((name) => !isUiCustomizationFile(name) && served.get(name) !== current.get(name)?.digest));
    const graph = new Map();
    function visit(name) {
      if (graph.has(name) || !current.has(name) || !isUiCustomizationFile(name)) return;
      const entry = current.get(name);
      const imports = [];
      graph.set(name, imports);
      if (!/\.[cm]?[jt]sx?$/.test(name)) return;
      let cached = dependencyCache.get(name);
      if (cached?.digest !== entry.digest) {
        const source = (entry.data ?? readSource(sourceRoot, name).data).toString("utf8");
        // Conservative literal import/export/require scan; a false positive
        // defers an edit rather than publishing a partially updated module.
        cached = { digest: entry.digest, specifiers: [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]) };
        dependencyCache.set(name, cached);
      }
      for (const specifier of cached.specifiers) {
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const base = specifier.startsWith("@/") ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => base + suffix)];
        const target = candidates.find((candidate) => current.has(candidate) || served.has(candidate));
        if (!target || !current.has(target)) { blocked.add(name); continue; }
        imports.push(target);
        visit(target);
      }
    }
    for (const [name, entry] of current) if (isUiCustomizationFile(name) && served.get(name) !== entry.digest) visit(name);
    let changed;
    do {
      changed = false;
      for (const [name, imports] of graph) if (!blocked.has(name) && imports.some((target) => blocked.has(target))) {
        blocked.add(name);
        changed = true;
      }
    } while (changed);
    return blocked;
  }

  function sync(changes) {
    if (closed) throw new Error("Customization workspace is closed");
    const applied = [];
    const errors = [];
    try {
      const current = scanSource(sourceRoot, observed, changes);
      current.delete(STATUS_FILE);
      // Read the complete change set before touching any served file. An unreadable or linked source keeps the old view.
      for (const [relative, entry] of current) {
        const previous = observed.get(relative);
        if (previous?.stamp === entry.stamp) entry.digest = previous.digest;
        else Object.assign(entry, readSource(sourceRoot, relative));
      }
      const blocked = deferredDependencies(current);
      state.deferredFiles = [...blocked].filter((relative) => served.get(relative) !== current.get(relative)?.digest).sort().slice(0, LIST_LIMIT);
      for (const relative of new Set([...served.keys(), ...current.keys()])) {
        if (!isUiCustomizationFile(relative) || blocked.has(relative) || served.get(relative) === current.get(relative)?.digest) continue;
        try {
          const target = safePath(snapshotRoot, relative, true);
          const entry = current.get(relative);
          if (entry) {
            // Unchanged source metadata may still need a retry after a previous destination failure.
            const complete = entry.data ? entry : readSource(sourceRoot, relative);
            writeFile(target, complete.data);
            served.set(relative, complete.digest);
          } else {
            fs.unlinkSync(target);
            served.delete(relative);
          }
          applied.push(relative);
        } catch (error) { errors.push(`${relative}: ${error.message}`); }
      }
      observed = new Map([...current].map(([relative, entry]) => [relative, { stamp: entry.stamp, digest: entry.digest }]));
    } catch (error) { errors.push(error.message); }
    if (applied.length) {
      state.appliedRevision += 1;
      state.appliedFiles = applied.sort().slice(0, LIST_LIMIT);
    }
    state.lastError = errors.length ? errors.join("; ").slice(0, 2048) : null;
    publish();
    return status();
  }
  return { sourceRoot, snapshotRoot, status, sync, cleanup };
}

module.exports = { SNAPSHOT_DIRECTORIES, SNAPSHOT_FILES, isUiCustomizationFile, validRelativePath, writeCompleteFile, validateSource, createCustomizationWorkspace, watchCustomizationSource };
