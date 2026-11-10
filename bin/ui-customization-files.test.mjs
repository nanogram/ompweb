import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SNAPSHOT_DIRECTORIES, SNAPSHOT_FILES, writeCompleteFile, createCustomizationWorkspace, isUiCustomizationFile, validRelativePath, validateSource } = require("./ui-customization-files.js");
const dependencies = fileURLToPath(new URL("../node_modules", import.meta.url));

function fixture(t) {
  const work = mkdtempSync(path.join(tmpdir(), "owui-files-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = path.join(work, "source");
  mkdirSync(source);
  for (const name of SNAPSHOT_DIRECTORIES) mkdirSync(path.join(source, name));
  for (const name of SNAPSHOT_FILES) writeFileSync(path.join(source, name), "{}\n");
  function put(relative, content = "initial\n") {
    const file = path.join(source, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  for (const name of ["app/index.html", "app/client.tsx", "app/globals.css", "server/ui.ts", "server/ui-link.ts"]) put(name);
  symlinkSync(dependencies, path.join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { work, source, put, create: (options = {}) => createCustomizationWorkspace(source, { temporaryRoot: work, ...options }) };
}

function text(workspace, relative) { return readFileSync(path.join(workspace.snapshotRoot, relative), "utf8"); }

test("only explicit display/style paths opt in; execution, control, tests and traversal never do", () => {
  for (const relative of ["app/globals.css", "app/fonts/theme.css", "components/theme.css", "public/custom.css", "components/MarkdownBody.tsx", "components/MarkdownCode.tsx", "components/MessageView.tsx", "components/MessageView-image.tsx", "components/MessageView-tool-format.ts", "components/MessageCopyActions.tsx", "components/ChatInput-banners.tsx", "lib/markdown.ts", "lib/syntax-highlight.ts", "components/display/new.tsx", "components/display/nested/new.css", "lib/display/nested/new.js"]) {
    assert.equal(isUiCustomizationFile(relative), true, relative);
  }
  for (const relative of ["components/ComposerPanels.tsx", "components/TodoList.tsx"]) {
    assert.equal(isUiCustomizationFile(relative), true, relative);
  }
  for (const relative of ["app/api/route.ts", "app/api/theme.css", "app/API/theme.css", "app/client.tsx", "server/app.ts", "bin/omp-web.js", "hooks/useAgentSession.ts", "lib/omp/rpc.ts", "lib/hosts/link.ts", "lib/event-stream-worker.ts", "lib/browser-link.ts", "lib/message-outbox.ts", "components/ChatInput.tsx", "components/ChatWindow.tsx", "components/AppShell.tsx", "components/Other.tsx", "lib/config.ts", "package.json", "tsconfig.json", "lib/display/theme.css", "components/display/unsafe.test.tsx", "components/MessageView-tool.test.tsx", "components/display/__tests__/view.tsx", "components/display/.env", "components/../app/globals.css", "/app/globals.css", "components\\display\\x.tsx", "components/display/x.tsx:stream", "components/display./x.tsx"]) {
    assert.equal(isUiCustomizationFile(relative), false, relative);
  }
  for (const relative of ["../outside", "a//b", "a/./b", "C:/outside", "a\\b", "a/../b", "a/b ", "a/b\0", "a/CON.tsx", "a/nul", "a/LPT1.css"]) assert.equal(validRelativePath(relative), false, relative);
});

test("snapshot copies runtime sources, omits private/test trees and links rather than copies dependencies", (t) => {
  const f = fixture(t);
  for (const name of ["app/.env", "public/.env.local", "lib/.cache/token", "server/auth/token", "lib/history/session.jsonl", "lib/auth.json", "lib/credentials.json", "bin/example.test.mjs", "components/display/card.spec.tsx", "hooks/__fixtures__/secret.ts"]) f.put(name, "must not copy");
  f.put("components/MessageView.tsx", "initial renderer");
  const routes = ["app/api/auth/accounts/provider/route.ts", "app/api/notifications/history/route.ts", "app/api/notifications/test/route.ts"];
  for (const name of routes) f.put(name, "export const GET = () => new Response('runtime route');");
  f.put("public/ui-customization.json", '{"leaked":"checkout-owned secret"}');
  const workspace = f.create();
  assert.equal(text(workspace, "components/MessageView.tsx"), "initial renderer");
  for (const name of routes) assert.equal(text(workspace, name), "export const GET = () => new Response('runtime route');");
  for (const name of ["app/.env", "public/.env.local", "lib/.cache", "server/auth", "lib/history", "lib/auth.json", "lib/credentials.json", "bin/example.test.mjs", "components/display/card.spec.tsx", "hooks/__fixtures__"]) assert.equal(existsSync(path.join(workspace.snapshotRoot, name)), false, name);
  assert.equal(lstatSync(path.join(workspace.snapshotRoot, "node_modules")).isSymbolicLink(), true);
  assert.equal(realpathSync(path.join(workspace.snapshotRoot, "node_modules")), realpathSync(dependencies));
  assert.ok(path.basename(workspace.snapshotRoot).length < 32);
  const sourceStatus = JSON.parse(text(workspace, "public/ui-customization.json"));
  assert.deepEqual(sourceStatus, { enabled: true, sourceRoot: realpathSync(f.source), appliedRevision: 0, appliedFiles: [], deferredFiles: [], lastError: null });
  workspace.cleanup();
  workspace.cleanup();
  assert.equal(existsSync(workspace.snapshotRoot), false);
  assert.equal(existsSync(path.join(f.source, "components/MessageView.tsx")), true);
  assert.equal(existsSync(dependencies), true);
});

test("applies actual allowed edits, additions and deletions while deferring critical changes until restart", (t) => {
  const f = fixture(t);
  const deferred = ["app/api/route.ts", "app/client.tsx", "server/app.ts", "bin/runtime.js", "hooks/session.ts", "lib/omp/rpc.ts", "lib/hosts/link.ts", "lib/event-stream-worker.ts", "lib/message-outbox.ts", "components/ChatInput.tsx", "components/ChatWindow.tsx", "components/AppShell.tsx", "package.json", "tsconfig.json"];
  for (const name of deferred) f.put(name, "initial\n");
  // Keep the metadata usable during source validation.
  f.put("package.json", '{"name":"ui-files-fixture"}\n');
  f.put("components/MessageView.tsx", "old view");
  f.put("components/old.css", "old style");
  const workspace = f.create();
  for (const name of deferred) f.put(name, name === "package.json" ? '{"name":"changed"}\n' : "changed critical\n");
  f.put("components/MessageView.tsx", "new view");
  f.put("components/display/cards/New.tsx", "new display module");
  f.put("lib/display/format.ts", "new formatter");
  unlinkSync(path.join(f.source, "components/old.css"));
  const state = workspace.sync();
  assert.equal(text(workspace, "components/MessageView.tsx"), "new view");
  assert.equal(text(workspace, "components/display/cards/New.tsx"), "new display module");
  assert.equal(text(workspace, "lib/display/format.ts"), "new formatter");
  assert.equal(existsSync(path.join(workspace.snapshotRoot, "components/old.css")), false);
  for (const name of deferred) assert.equal(text(workspace, name), name === "package.json" ? '{"name":"ui-files-fixture"}\n' : "initial\n", name);
  assert.deepEqual(state.deferredFiles, deferred.sort());
  assert.deepEqual(state.appliedFiles, ["components/MessageView.tsx", "components/display/cards/New.tsx", "components/old.css", "lib/display/format.ts"]);
  assert.equal(state.appliedRevision, 1);
  assert.equal(state.lastError, null);
  assert.deepEqual(JSON.parse(text(workspace, "public/ui-customization.json")), state);
  assert.equal(workspace.sync().appliedRevision, 1, "unchanged polls do not claim new revisions");
  f.put("components/old.css", "recreated style");
  unlinkSync(path.join(f.source, "components/display/cards/New.tsx"));
  unlinkSync(path.join(f.source, "server/app.ts"));
  f.put("server/new-control.ts", "new control module");
  const second = workspace.sync();
  assert.equal(text(workspace, "components/old.css"), "recreated style");
  assert.equal(existsSync(path.join(workspace.snapshotRoot, "components/display/cards/New.tsx")), false);
  assert.equal(text(workspace, "server/app.ts"), "initial\n");
  assert.equal(existsSync(path.join(workspace.snapshotRoot, "server/new-control.ts")), false);
  assert.ok(second.deferredFiles.includes("server/app.ts"));
  assert.ok(second.deferredFiles.includes("server/new-control.ts"));
  f.put("hooks/session.ts", "initial\n");
  assert.equal(workspace.sync().deferredFiles.includes("hooks/session.ts"), false, "reverting a critical edit clears its deferred notice");
});

test("failed atomic replacement leaves the old served file and surfaces an error, then retries", (t) => {
  const f = fixture(t);
  f.put("components/MessageView.tsx", "old complete file");
  let fail = true;
  const workspace = f.create({ writeFile(file, data) {
    writeCompleteFile(file, data, { rename(from, to) {
      if (fail) throw new Error("replacement denied");
      renameSync(from, to);
    } });
  } });
  f.put("components/MessageView.tsx", "new complete file");
  const failed = workspace.sync();
  assert.equal(text(workspace, "components/MessageView.tsx"), "old complete file");
  assert.equal(failed.appliedRevision, 0);
  assert.match(failed.lastError, /MessageView.tsx: replacement denied/);
  assert.match(JSON.parse(text(workspace, "public/ui-customization.json")).lastError, /replacement denied/);
  assert.deepEqual(readdirSync(path.join(workspace.snapshotRoot, "components")), ["MessageView.tsx"]);
  fail = false;
  const recovered = workspace.sync();
  assert.equal(text(workspace, "components/MessageView.tsx"), "new complete file");
  assert.equal(recovered.appliedRevision, 1);
  assert.equal(recovered.lastError, null);
});

test("Windows mapped modules publish complete replacements and restore the old file if publication fails", (t) => {
  const f = fixture(t);
  const file = path.join(f.source, "components/MessageView.tsx");
  writeFileSync(file, "previous renderer");
  let failPublication = false;
  const rename = (from, to) => {
    if (from.includes(".ui-") && !from.includes(".ui-previous-") && to === file) {
      if (existsSync(to)) throw Object.assign(new Error("mapped destination"), { code: "EPERM" });
      if (failPublication) throw Object.assign(new Error("publication denied"), { code: "EIO" });
    }
    renameSync(from, to);
  };
  writeCompleteFile(file, "complete replacement", { rename, platform: "win32" });
  assert.equal(readFileSync(file, "utf8"), "complete replacement");
  failPublication = true;
  assert.throws(() => writeCompleteFile(file, "must not leak", { rename, platform: "win32" }), /publication denied/);
  assert.equal(readFileSync(file, "utf8"), "complete replacement");
  assert.deepEqual(readdirSync(path.dirname(file)), ["MessageView.tsx"]);
});

test("incremental batches retain prior deferred work and synchronize directory additions and deletions", (t) => {
  const f = fixture(t);
  f.put("app/api/route.ts", "original API");
  const workspace = f.create();
  f.put("app/api/route.ts", "deferred API");
  f.put("components/display/nested/Card.tsx", "first complete card");
  let state = workspace.sync(["app/api/route.ts", "components/display"]);
  assert.equal(text(workspace, "app/api/route.ts"), "original API");
  assert.equal(text(workspace, "components/display/nested/Card.tsx"), "first complete card");
  assert.deepEqual(state.deferredFiles, ["app/api/route.ts"]);
  f.put("components/display/nested/Card.tsx", "second complete card");
  state = workspace.sync(["components/display/nested/Card.tsx"]);
  assert.equal(text(workspace, "components/display/nested/Card.tsx"), "second complete card");
  assert.deepEqual(state.deferredFiles, ["app/api/route.ts"]);
  rmSync(path.join(f.source, "components/display/nested"), { recursive: true });
  state = workspace.sync(["components/display/nested"]);
  assert.equal(existsSync(path.join(workspace.snapshotRoot, "components/display/nested/Card.tsx")), false);
  assert.deepEqual(state.deferredFiles, ["app/api/route.ts"]);
  assert.equal(state.lastError, null);
  assert.match(workspace.sync(["../outside"]).lastError, /Unsafe customization change/);
});

test("rejects source directory links and never follows a file link replacing an allowed file", (t) => {
  const f = fixture(t);
  const outside = path.join(f.work, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.tsx"), "outside secret");
  symlinkSync(outside, path.join(f.source, "components/display"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.create(), /Symbolic links/);
  rmSync(path.join(f.source, "components/display"), { recursive: true, force: true });
  f.put("components/MessageView.tsx", "old trusted renderer");
  const workspace = f.create();
  unlinkSync(path.join(f.source, "components/MessageView.tsx"));
  try { symlinkSync(path.join(outside, "secret.tsx"), path.join(f.source, "components/MessageView.tsx"), "file"); } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows file symlinks require Developer Mode or symlink privilege"); return; }
    throw error;
  }
  const state = workspace.sync();
  assert.equal(text(workspace, "components/MessageView.tsx"), "old trusted renderer");
  assert.match(state.lastError, /Symbolic links/);
  assert.equal(state.appliedRevision, 0);
  assert.equal(readFileSync(path.join(outside, "secret.tsx"), "utf8"), "outside secret");
});

test("refuses a symlinked snapshot parent without modifying its external target", (t) => {
  const f = fixture(t);
  f.put("components/display/Card.tsx", "old card");
  const workspace = f.create();
  const outside = path.join(f.work, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "Card.tsx"), "external card");
  rmSync(path.join(workspace.snapshotRoot, "components/display"), { recursive: true });
  symlinkSync(outside, path.join(workspace.snapshotRoot, "components/display"), process.platform === "win32" ? "junction" : "dir");
  f.put("components/display/Card.tsx", "new card");
  assert.match(workspace.sync().lastError, /Symbolic links/);
  assert.equal(readFileSync(path.join(outside, "Card.tsx"), "utf8"), "external card");
  workspace.cleanup();
  assert.equal(readFileSync(path.join(outside, "Card.tsx"), "utf8"), "external card");
});

test("validates complete checkout inputs and refuses temporary snapshots inside the source", (t) => {
  const f = fixture(t);
  unlinkSync(path.join(f.source, "app/index.html"));
  assert.throws(() => validateSource(f.source));
  f.put("app/index.html", "<!doctype html>");
  assert.throws(() => f.create({ temporaryRoot: f.source }), /outside the source checkout/);
  assert.equal(readdirSync(f.source).some((name) => name.startsWith("owui-")), false);
  rmSync(path.join(f.source, "node_modules"), { force: true, recursive: true });
  assert.throws(() => validateSource(f.source));
  mkdirSync(path.join(f.source, "node_modules"));
  assert.throws(() => validateSource(f.source), /installed react/);
});


test("a display update waits for a new deferred dependency instead of breaking the served bundle", (t) => {
  const f = fixture(t);
  f.put("components/MarkdownBody.tsx", "export const body = 'previous';");
  const workspace = f.create();
  f.put("components/MarkdownBody.tsx", "export { menu as body } from './FileLinkMenu';");
  f.put("components/FileLinkMenu.tsx", "export const menu = 'new menu';");
  f.put("components/display/Independent.tsx", "export const independent = true;");
  const state = workspace.sync();
  assert.equal(text(workspace, "components/MarkdownBody.tsx"), "export const body = 'previous';");
  assert.equal(existsSync(path.join(workspace.snapshotRoot, "components/FileLinkMenu.tsx")), false);
  assert.ok(state.deferredFiles.includes("components/MarkdownBody.tsx"));
  assert.equal(text(workspace, "components/display/Independent.tsx"), "export const independent = true;");
  f.put("components/MarkdownBody.tsx", "export const body = 'independent update';");
  workspace.sync(["components/MarkdownBody.tsx"]);
  assert.equal(text(workspace, "components/MarkdownBody.tsx"), "export const body = 'independent update';");
});

test("display dependency fences propagate through allowed modules and retry after a deferred edit is reverted", (t) => {
  const f = fixture(t);
  f.put("lib/config.ts", "export const label = 'old';");
  f.put("components/display/Label.tsx", "export { label } from '@/lib/config';");
  f.put("components/MarkdownBody.tsx", "export { label } from './display/Label';");
  const workspace = f.create();
  f.put("lib/config.ts", "export const label = 'new';");
  f.put("components/display/Label.tsx", "export { label as title } from '@/lib/config';");
  f.put("components/MarkdownBody.tsx", "export { title } from './display/Label';");
  const state = workspace.sync();
  assert.equal(text(workspace, "components/MarkdownBody.tsx"), "export { label } from './display/Label';");
  assert.ok(state.deferredFiles.includes("components/display/Label.tsx"));
  f.put("lib/config.ts", "export const label = 'old';");
  workspace.sync(["lib/config.ts"]);
  assert.equal(text(workspace, "components/MarkdownBody.tsx"), "export { title } from './display/Label';");
  assert.equal(text(workspace, "components/display/Label.tsx"), "export { label as title } from '@/lib/config';");
});
