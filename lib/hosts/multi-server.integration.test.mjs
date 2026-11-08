import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join(root, "tests", "fixtures");
const ID = "ba7c0e5e-0000-4000-8000-000000000001";

function timeoutError(detail, logs) {
  return new Error(`Timed out: ${detail}\n${logs().slice(-12_000)}`);
}

async function bounded(promise, detail, logs, timeout = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(detail, logs)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate, detail, logs, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await bounded(Promise.resolve().then(predicate), detail, logs, Math.max(1, deadline - Date.now()));
    if (result) return result;
    await sleep(30);
  }
  throw timeoutError(detail, logs);
}

async function requestJson(base, path, command, logs = () => "") {
  const controller = new AbortController();
  try {
    return await bounded((async () => {
      const response = await fetch(`${base}${path}`, {
        signal: controller.signal,
        ...(command && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 2000)}`);
      return body;
    })(), `${base}${path} (${command?.type ?? "GET"})`, logs);
  } catch (error) {
    throw new Error(`${base}${path} (${command?.type ?? "GET"}): ${error.message}\n${logs().slice(-12_000)}`, { cause: error });
  } finally {
    controller.abort();
  }
}

async function sessionStream(base, streams, diagnostics) {
  const controller = new AbortController();
  let response;
  try {
    response = await bounded(fetch(`${base}/api/events`, { signal: controller.signal }), `open SSE ${base}`, diagnostics);
    assert.equal(response.status, 200);
  } catch (error) {
    controller.abort();
    throw new Error(`${base}/api/events: ${error.message}`, { cause: error });
  }
  const frames = [];
  let failure;
  let ended = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const task = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      let at;
      while ((at = text.indexOf("\n\n")) !== -1) {
        const event = text.slice(0, at);
        text = text.slice(at + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) frames.push(JSON.parse(data));
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) failure = error; }).finally(() => { ended = true; });
  const log = () => JSON.stringify({ base, count: frames.length, ended, frames: frames.slice(-12), failure: failure?.message },
    (_, value) => typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)} (${value.length} chars)` : value);
  const stream = { frames, log, close: async () => {
    controller.abort();
    // Cancel the actual fetch reader, not a TextDecoderStream's downstream reader.
    await bounded(Promise.all([reader.cancel().catch(() => {}), task]), `close SSE ${base}`, log, 2000);
  } };
  // Own the reader before hello/subscribe can fail, including the second server's setup.
  streams.push(stream);
  const hello = await until(() => {
    if (failure) throw new Error(`SSE failed: ${log()}`, { cause: failure });
    if (ended) throw new Error(`SSE ended before hello: ${log()}`);
    return frames.find((f) => f.type === "hello");
  }, "SSE hello", log);
  await requestJson(base, "/api/events", { connectionId: hello.connectionId, subscribe: { id: "s1", channel: { kind: "session", sessionId: ID } } }, diagnostics);
  return stream;
}

function hasMessage(frames, role, text) {
  return frames.some((f) => f.type === "message_end" && f.message?.role === role &&
    (typeof f.message.content === "string" ? f.message.content === text : f.message.content?.some((c) => c.type === "text" && c.text === text)));
}

test("two real web servers share one host process and one live conversation", { timeout: 90_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ompweb-multi-server-"));
  const agentDir = join(scratch, "home", ".omp", "agent");
  const project = join(scratch, "project");
  const site = join(scratch, "site");
  const ompLog = join(scratch, "omp.jsonl");
  const shutdownFile = join(scratch, "shutdown");
  const children = [];
  const streams = [];
  let logs = "";
  const starts = () => existsSync(ompLog) ? readFileSync(ompLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const diagnostics = () => [
    `children: ${JSON.stringify(children.map(({ child, done, error }) => ({ pid: child.pid, done, code: child.exitCode, signal: child.signalCode, error: error?.message })))}`,
    `native: ${JSON.stringify(starts().slice(-12))}`,
    ...streams.map((stream) => stream.log()),
    logs,
  ].join("\n");
  const json = (base, path, command) => requestJson(base, path, command, diagnostics);
  const launch = (args, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const state = { child, output: "", done: false, error: undefined, exited: undefined };
    state.exited = new Promise((resolve) => {
      child.once("error", (error) => { state.error = error; state.done = true; resolve(); });
      child.once("exit", () => { state.done = true; resolve(); });
    });
    children.push(state);
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (chunk) => {
      state.output = (state.output + chunk).slice(-16_000);
      logs = (logs + `[${child.pid}] ${chunk}`).slice(-6000);
    });
    return state;
  };
  const stop = async (state) => {
    const { child, exited } = state;
    if (state.done) return;
    const signalTree = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch { child.kill(signal); }
    };
    if (process.platform === "win32") {
      // Kill the owned tree before its root disappears, including cmd.exe launchers.
      const reaper = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      const reaped = new Promise((resolve) => {
        reaper.once("error", resolve);
        reaper.once("exit", resolve);
      });
      try { await bounded(reaped, `taskkill ${child.pid}`, diagnostics, 2000); }
      catch { /* The direct kill below is the bounded fallback. */ }
      finally { if (reaper.exitCode === null && reaper.signalCode === null) reaper.kill("SIGKILL"); }
    } else signalTree("SIGTERM");
    try { await bounded(exited, `stop ${child.pid}`, diagnostics, 5000); }
    catch {
      if (process.platform === "win32") child.kill("SIGKILL");
      else signalTree("SIGKILL");
      await bounded(exited, `force stop ${child.pid}`, diagnostics, 2000);
    }
  };
  t.after(async () => {
    const errors = [];
    // Reader cancellation must never hold process teardown hostage.
    const closing = Promise.allSettled(streams.map((stream) => stream.close()));
    try {
      writeFileSync(shutdownFile, "");
      await until(() => {
        const entries = starts();
        return entries.filter((entry) => entry.type === "start").every((entry) => {
          if (entries.some((ended) => ended.type === "exit" && ended.pid === entry.pid)) return true;
          try { process.kill(entry.pid, 0); return false; }
          catch (error) { if (error.code === "ESRCH") return true; throw error; }
        });
      }, "native fixtures exit", diagnostics, 2000);
    } catch (error) { errors.push(error); }
    const stopping = await Promise.allSettled(children.slice().reverse().map(stop));
    for (const result of [...await closing, ...stopping]) if (result.status === "rejected") errors.push(result.reason);
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `Multi-server cleanup failed\n${diagnostics().slice(-12_000)}`);
  });
  mkdirSync(join(agentDir, "sessions", "-project"), { recursive: true });
  mkdirSync(project);
  mkdirSync(join(site, "dist"), { recursive: true });
  symlinkSync(join(root, "public"), join(site, "public"), "junction");
  writeFileSync(join(site, "dist", "index.html"), "<!doctype html><title>omp web</title><main id=\"root\"></main>");
  const sessionFile = join(agentDir, "sessions", "-project", `2026-01-01_${ID}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: ID, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  const fake = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
  const source = `import(${JSON.stringify(pathToFileURL(join(fixture, "multi-server-omp.mjs")).href)});\n`;
  if (process.platform === "win32") {
    writeFileSync(`${fake}.cjs`, source);
    writeFileSync(fake, `@"${process.execPath.replaceAll("%", "%%")}" "${fake.replaceAll("%", "%%")}.cjs" %*\r\n`);
  } else writeFileSync(fake, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const env = { ...process.env, HOME: join(scratch, "home"), USERPROFILE: join(scratch, "home"), PI_CODING_AGENT_DIR: agentDir,
    NODE_ENV: "production", OMP_WEB_OMP_BIN: fake, OMP_MULTI_SESSION_ID: ID, OMP_MULTI_SESSION_FILE: sessionFile, OMP_MULTI_LOG: ompLog,
    OMP_MULTI_RELEASE_FILE: join(scratch, "release-stream"),
    OMP_MULTI_SHUTDOWN_FILE: shutdownFile,
    OMP_WEB_DISCONNECT_DESTROY_MS: "1000" };
  for (const key of ["OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SECRET", "OMP_WEB_TRUSTED_HEADER_SHA256", "OMP_WEB_PACKAGE_DIR"]) delete env[key];
  const server = async () => {
    const state = launch([join(fixture, "multi-server-app.ts")], { OMP_WEB_PACKAGE_DIR: site });
    const port = await until(() => {
      if (state.done) throw new Error(`Web server exited before ready\n${diagnostics()}`);
      return /MULTI_SERVER_PORT=(\d+)/.exec(state.output)?.[1];
    }, "server ready", diagnostics);
    return { state, base: `http://127.0.0.1:${port}` };
  };
  const a = await server();
  const b = await server();
  const daemon = launch([join(root, "bin", "omp-web-host.js")]);
  await until(async () => {
    const [ah, bh] = await Promise.all([json(a.base, "/api/hosts"), json(b.base, "/api/hosts")]);
    return ah.hosts.some((h) => h.id === "local" && h.status === "online") && bh.hosts.some((h) => h.id === "local" && h.status === "online");
  }, "both servers linked to the same daemon", () => logs);
  const daemonPid = daemon.child.pid;
  await json(a.base, `/api/agent/${ID}`, { type: "get_state" });
  await json(b.base, `/api/agent/${ID}`, { type: "get_state" });
  const sa = await sessionStream(a.base, streams, diagnostics);
  const sb = await sessionStream(b.base, streams, diagnostics);
  await json(a.base, `/api/agent/${ID}`, { type: "prompt", message: "from A" });
  await until(() => hasMessage(sa.frames, "user", "from A") && hasMessage(sb.frames, "user", "from A"), "A prompt echoed on both", () => `${sa.log()}\n${sb.log()}\n${logs}`);
  await until(() => hasMessage(sa.frames, "assistant", "one two") && hasMessage(sb.frames, "assistant", "one two")
    && [sa, sb].every(({ frames }) => frames.some((f) => f.type === "session_settled")), "same assistant result on both", diagnostics);
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "from B" });
  await until(() => hasMessage(sa.frames, "user", "from B") && hasMessage(sb.frames, "user", "from B"), "B prompt echoed on both", () => logs);
  await until(() => [sa, sb].every(({ frames }) => frames.filter((f) => f.type === "agent_end").length >= 2
    && frames.filter((f) => f.type === "session_settled").length >= 2), "B turn settled", diagnostics);
  const pids = starts().filter((e) => e.type === "start" && e.resumed).map((e) => e.pid);
  assert.equal(pids.length, 1, `session must spawn once: ${JSON.stringify(pids)}`);
  assert.equal(daemon.child.pid, daemonPid);
  assert.equal(sa.frames.filter((f) => f.type === "tool_execution_end").length, 2);
  assert.equal(sb.frames.filter((f) => f.type === "tool_execution_end").length, 2);
  for (const { frames } of [sa, sb]) {
    const result = frames.find(f => f.type === "tool_execution_end" && f.toolCallId === "t2")?.result;
    assert.equal(result?.details?.largeResult, "x".repeat(1_100_000), "both peers reconstruct the chunked native tool result");
  }
  await json(a.base, `/api/agent/${ID}`, { type: "prompt", message: "ask" });
  await until(() => sa.frames.some((f) => f.type === "extension_ui_request" && f.method === "ask") && sb.frames.some((f) => f.type === "extension_ui_request" && f.method === "ask"), "one question on both", () => logs);
  const question = sb.frames.findLast((f) => f.type === "extension_ui_request" && f.method === "ask");
  await json(b.base, `/api/agent/${ID}`, { type: "extension_ui_response", id: question.id, answers: [{ id: "pick", selectedOptions: ["B"] }] });
  await until(() => sa.frames.some((f) => f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === question.id), "answer on B closes A dialog", () => `${sa.log()}\n${logs}`);
  // The HTTP write acknowledgement and A's peer cancel precede native consumption.
  await until(() => starts().some((e) => e.type === "answer" && e.id === question.id)
    && [sa, sb].every(({ frames }) => frames.filter((f) => f.type === "agent_end").length >= 3
      && frames.filter((f) => f.type === "session_settled").length >= 3),
    "native consumes the answer and both peers settle", diagnostics);
  assert.equal(starts().filter((e) => e.type === "answer" && e.id === question.id).length, 1);
  await json(a.base, `/api/agent/${ID}`, { type: "extension_ui_response", id: question.id, answers: [{ id: "pick", selectedOptions: ["A"] }] });
  await json(a.base, `/api/agent/${ID}`, { type: "get_state" });
  assert.equal(starts().filter((e) => e.type === "answer" && e.id === question.id).length, 1, "a late answer from A must not reach native twice");
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "slow" });
  await until(() => sb.frames.some((f) => f.type === "message_update" && f.messageId === "a4"), "stream starts before reconnect", () => logs);
  await stop(a.state);
  await sleep(1200);
  const a2 = await server();
  await until(async () => (await json(a2.base, "/api/hosts")).hosts.some((h) => h.id === "local" && h.status === "online"), "restarted server linked", () => logs);
  await json(a2.base, `/api/agent/${ID}`, { type: "get_state" });
  const sa2 = await sessionStream(a2.base, streams, diagnostics);
  await until(() => sa2.frames.some((f) => f.type === "message_update" && f.message?.content?.some((c) => c.text === "one")), "rejoined server receives current whole message", () => `${sa2.log()}\n${logs}`);
  writeFileSync(join(scratch, "release-stream"), "");
  await until(() => hasMessage(sa2.frames, "assistant", "one two")
    && sb.frames.filter((f) => f.type === "session_settled").length >= 4
    && sa2.frames.some((f) => f.type === "session_settled"), "rejoined stream finishes without missing text", diagnostics);
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "B after A restarts" });
  await until(() => hasMessage(sb.frames, "user", "B after A restarts"), "B still drives the same session", () => logs);
  assert.deepEqual(starts().filter((e) => e.type === "start" && e.resumed).map((e) => e.pid), pids);
  assert.equal(starts().filter((e) => e.type === "answer" && e.id === question.id).length, 1);
});
