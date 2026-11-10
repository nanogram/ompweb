import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { nodeBinary } from "./update-fixture.test-helper.mjs";

// The copied updater runs on Node, not Bun's Windows filesystem implementation.
test("Windows update status stays complete while an independent reader briefly denies replacement", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ow-status-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "status.json");
  const previous = { operation: { id: "reader-lock", target: "ompweb", version: "1.0.0", state: "running" } };
  const next = { operation: { ...previous.operation, state: "succeeded" } };
  const script = `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeHostUpdateJson } from ${JSON.stringify(new URL("./update-worker.ts", import.meta.url).href)};
const file=${JSON.stringify(file)}, previous=${JSON.stringify(previous)}, next=${JSON.stringify(next)};
writeHostUpdateJson(file, previous);
const reader=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop';$f=[IO.File]::Open($env:OMP_STATUS_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('locked');[Console]::Out.Flush();Start-Sleep -Milliseconds 500}finally{$f.Dispose()}"],{env:{...process.env,OMP_STATUS_LOCK_FILE:file},windowsHide:true,stdio:["ignore","pipe","pipe"]});
const exited=new Promise(resolve=>reader.once("exit",resolve));
try {
  await new Promise((resolve,reject)=>{
    let output="";
    const timer=setTimeout(()=>reject(new Error("reader did not acquire its handle")),15000);
    reader.stdout.on("data",chunk=>{output+=chunk;if(output.includes("locked")){clearTimeout(timer);resolve();}});
    reader.once("error",error=>{clearTimeout(timer);reject(error);});
    reader.once("exit",code=>{clearTimeout(timer);if(!output.includes("locked"))reject(new Error("reader exited before locking: "+code));});
  });
  assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),previous);
  writeHostUpdateJson(file,next);
} finally {
  if(reader.exitCode===null&&reader.signalCode===null){reader.kill();}
  await exited;
}
`;
  await promisify(execFile)(nodeBinary(), ["--input-type=module", "-e", script], { windowsHide: true, timeout: 25000 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
  assert.deepEqual(readdirSync(root), ["status.json"]);
});
