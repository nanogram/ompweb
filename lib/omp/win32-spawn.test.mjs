import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcProcess } from "./rpc-process.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };

test("a spaced Windows launcher preserves cwd and literal argument boundaries", windows, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp launcher "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake omp.cmd");
  const argsFile = join(dir, "args.json");
  const cwd = join(dir, "workspace & files");
  mkdirSync(cwd);
  writeFileSync(join(dir, "record.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
  writeFileSync(bin, `@"${process.execPath.replaceAll("%", "%%")}" "%~dp0record.cjs" %*\r\n`);
  const extra = ["--model", "provider/model with spaces", "", 'literal "quote"', "x&y|z", "trailing\\", "%OMP_WINSPAWN_SENTINEL%", "!literal!"];
  const { promise, resolve } = Promise.withResolvers();
  new RpcProcess({
    cwd,
    extraArgs: extra,
    env: { OMP_WINSPAWN_SENTINEL: "must-not-expand" },
    dependencies: { resolveOmpBin: () => bin },
    onExit: resolve,
  });
  const result = await promise;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), ["--mode", "rpc-ui", "--cwd", cwd, ...extra]);
});

test("a version probe can execute a launcher whose path contains spaces", windows, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp version "));
  const bin = join(dir, "fake omp.cmd");
  writeFileSync(bin, "@echo off\r\necho omp/99.9.9-win\r\n");
  const previous = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const { getOmpVersion } = await import("./omp-cli.ts?spaced-version");
  assert.equal(await getOmpVersion(), "omp/99.9.9-win");
});
