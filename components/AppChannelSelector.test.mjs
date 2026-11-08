import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppChannelSelector, isAppChannelRestartComplete } from "./AppChannelSelector";
import { setLocale } from "../lib/i18n";

const fork = { channel: "fork", version: "0.6.0-n1", revision: null };
const main = { channel: "main", version: "0.6.0", revision: "b".repeat(40) };
const idle = { supported: true, active: fork, selected: fork, preparing: null, restartRequired: false, restarting: false, error: null };
const ready = { ...idle, selected: main, restartRequired: true };
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function renderSelector(t, handler, locale = "en") {
  sessionStorage.clear();
  setLocale(locale);
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const requests = [];
  const reloads = [];
  const intervals = new Map();
  let intervalId = 0;
  globalThis.setInterval = (callback) => { const id = ++intervalId; intervals.set(id, callback); return id; };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), ...options });
    return handler(String(url), options);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    sessionStorage.clear();
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClearInterval;
    setLocale("en");
  });
  await act(async () => root.render(createElement(AppChannelSelector, { reload: () => reloads.push(true) })));
  await flush();
  return {
    container, requests, intervals, reloads,
    async poll() { for (const callback of [...intervals.values()]) callback(); await flush(); },
    async choose(channel) { act(() => container.querySelector(`input[value="${channel}"]`).click()); await flush(); },
    async click(label) {
      const button = [...container.querySelectorAll("button")].find((value) => value.textContent === label);
      assert.ok(button, label);
      act(() => button.click());
      await flush();
    },
  };
}

test("only the confirmed target release triggers one browser reload after restart", async (t) => {
  let state = ready;
  const ui = await renderSelector(t, (_url, options) => {
    if (options.method === "POST") state = { ...ready, restarting: true };
    return Response.json(state);
  });
  await ui.click("Restart OMPweb");
  assert.equal(ui.reloads.length, 0);
  state = { ...idle, active: { ...main, revision: "c".repeat(40) }, selected: main };
  await ui.poll();
  assert.equal(ui.reloads.length, 0, "an HTTP recovery with the wrong revision is not confirmation");
  state = { ...idle, active: main, selected: main };
  await ui.poll();
  assert.equal(ui.reloads.length, 1);
  assert.equal(ui.intervals.size, 0);
  assert.equal(sessionStorage.getItem("ompweb-channel-restart"), null);
  await ui.poll();
  assert.equal(ui.reloads.length, 1);
});

test("two-way radio selection stages without restarting and separates running from next start", async (t) => {
  let state = idle;
  const ui = await renderSelector(t, (_url, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.action, "select");
      state = { ...idle, preparing: { channel: body.channel, stage: "building" } };
    }
    return Response.json(state);
  });
  assert.equal(ui.container.querySelector("fieldset legend").textContent, "Application version");
  assert.ok(ui.container.querySelector('input[value="fork"]').checked);
  assert.equal(ui.intervals.size, 0, "idle views should not poll");
  await ui.choose("main");
  assert.deepEqual(ui.requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body)), [{ action: "select", channel: "main" }]);
  assert.ok(ui.container.querySelector("fieldset").disabled);
  assert.match(ui.container.querySelector('[role="status"]').textContent, /building/);
  assert.equal(ui.intervals.size, 1);
  assert.ok(!ui.container.textContent.includes("Restart OMPweb"));
  state = ready;
  await ui.poll();
  assert.ok(ui.container.textContent.includes("Running: nanogram fork · v0.6.0-n1"));
  assert.ok(ui.container.textContent.includes("Next start: Main (upstream) · v0.6.0"));
  assert.equal(ui.intervals.size, 0);
  assert.ok(!ui.container.querySelector("fieldset").disabled);
  await ui.choose("fork");
  const last = ui.requests.filter((request) => request.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(last.body), { action: "select", channel: "fork" });
  assert.ok(ui.requests.every((request) => request.url === "/api/app-channel"));
});

test("preparation survives a closed view and exposes failures with selectable recovery", async (t) => {
  let state = { ...idle, preparing: { channel: "main", stage: "installing" } };
  const ui = await renderSelector(t, () => Response.json(state));
  assert.equal(ui.intervals.size, 1, "mounting during background preparation resumes observation");
  state = { ...idle, error: "Build failed; choose Main again to retry" };
  await ui.poll();
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /Build failed/);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.container.querySelector("fieldset").disabled, false);
  assert.ok([...ui.container.querySelectorAll("button")].some((button) => button.textContent === "Refresh version status"));
});

test("explicit web restart reconnects across repeated outages and supports rollback retry", async (t) => {
  let state = ready;
  let offline = false;
  const ui = await renderSelector(t, (_url, options) => {
    if (options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), { action: "restart" });
      state = { ...ready, restarting: true };
      return Response.json(state, { status: 202 });
    }
    if (offline) throw new Error("Server reconnecting");
    return Response.json(state);
  });
  assert.equal(ui.intervals.size, 0);
  await ui.click("Restart OMPweb");
  assert.equal(ui.intervals.size, 1);
  assert.ok(sessionStorage.getItem("ompweb-channel-restart"));
  offline = true;
  await ui.poll();
  await ui.poll();
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /reconnecting/);
  assert.equal(ui.intervals.size, 1, "repeated identical network failures must not stop reconnect polling");
  offline = false;
  state = { ...ready, error: "Candidate failed to start; previous web version restored" };
  await ui.poll();
  assert.equal(ui.intervals.size, 0);
  assert.equal(sessionStorage.getItem("ompweb-channel-restart"), null);
  assert.ok(!ui.container.querySelector("fieldset").disabled);
  await ui.click("Restart OMPweb");
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 2);
});

test("a lost restart response keeps reconnecting instead of silently abandoning the switch", async (t) => {
  const ui = await renderSelector(t, (_url, options) => {
    if (options.method === "POST") throw new Error("Connection closed during restart");
    return Response.json(ready);
  });
  await ui.click("Restart OMPweb");
  assert.equal(ui.intervals.size, 1);
  assert.ok(sessionStorage.getItem("ompweb-channel-restart"));
  await ui.poll();
  assert.equal(ui.intervals.size, 1);
});

test("unsupported launches are disabled but disclose the running release and actionable reason", async (t) => {
  const ui = await renderSelector(t, () => Response.json({ ...idle, supported: false, reason: "Start with the production Node launcher" }));
  assert.equal(ui.container.querySelector("fieldset").disabled, true);
  assert.match(ui.container.querySelector('[role="note"]').textContent, /Node launcher/);
  assert.ok(ui.container.textContent.includes(fork.version));
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.requests.length, 1);
});

for (const locale of ["en", "ja", "zh-CN", "zh-TW"]) {
  test(`${locale} renders both labeled choices and can select upstream`, async (t) => {
    const ui = await renderSelector(t, () => Response.json(idle), locale);
    const radios = [...ui.container.querySelectorAll('input[type="radio"]')];
    assert.equal(radios.length, 2);
    assert.ok(radios.every((radio) => radio.closest("label").textContent.trim().length > 0));
    assert.ok(!ui.container.textContent.includes("appChannel."));
    assert.ok(document.getElementById(ui.container.querySelector("fieldset").getAttribute("aria-describedby")));
    await ui.choose("main");
    assert.deepEqual(JSON.parse(ui.requests.at(-1).body), { action: "select", channel: "main" });
  });
}

test("reload confirmation requires the exact active and selected release, not merely an HTTP recovery", () => {
  const complete = { ...idle, active: main, selected: main };
  assert.equal(isAppChannelRestartComplete(complete, main), true);
  for (const status of [ready, { ...complete, restarting: true }, { ...complete, restartRequired: true }, { ...complete, preparing: { channel: "main", stage: "building" } }, { ...complete, error: "rolled back" }, { ...complete, active: { ...main, revision: "c".repeat(40) } }, { ...complete, selected: fork }]) {
    assert.equal(isAppChannelRestartComplete(status, main), false);
  }
});

test("a failed initial status load exposes manual recovery without idle polling", async (t) => {
  let failed = true;
  const ui = await renderSelector(t, () => {
    if (failed) return Response.json({ error: "Manager unavailable; refresh to reconnect" }, { status: 503 });
    return Response.json(idle);
  });
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /Manager unavailable/);
  assert.equal(ui.intervals.size, 0);
  failed = false;
  await ui.click("Refresh version status");
  assert.equal(ui.container.querySelector('[role="alert"]'), null);
  assert.equal(ui.container.querySelector("fieldset").disabled, false);
});

test("rejected selection preserves the existing choice and displays the actionable server error", async (t) => {
  const ui = await renderSelector(t, (_url, options) => options.method === "POST"
    ? Response.json({ error: "Preparation is busy; refresh and retry" }, { status: 409 })
    : Response.json(idle));
  await ui.choose("main");
  assert.ok(ui.container.querySelector('input[value="fork"]').checked);
  assert.equal(ui.container.querySelector("fieldset").disabled, false);
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /Preparation is busy/);
  assert.equal(ui.requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(ui.intervals.size, 0);
  assert.equal(sessionStorage.getItem("ompweb-channel-restart"), null);
});
