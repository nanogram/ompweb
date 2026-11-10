import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { UiCustomizationStatus } from "./UiCustomizationStatus.tsx";

const initial = {
  enabled: true, sourceRoot: "F:/private/display-source", appliedRevision: 3,
  appliedFiles: ["components/MessageView.tsx"], deferredFiles: [], lastError: null,
};

async function mount(t, handler, hidden = false) {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const timers = new Map();
  const requests = [];
  let id = 0;
  let state = hidden ? "hidden" : "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  // Let DOM events (including <details> toggle) use the real event loop;
  // only advance delayed polling here.
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (!delay) return originalTimeout(callback, delay, ...args);
    const key = ++id;
    timers.set(key, callback);
    return key;
  };
  globalThis.clearTimeout = (key) => { if (!timers.delete(key)) originalClear(key); };
  globalThis.fetch = (url, options) => {
    requests.push({ url, ...options });
    return handler(url, options);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const flush = async () => { await act(async () => { await new Promise((resolve) => originalTimeout(resolve, 0)); }); };
  t.after(() => {
    if (!unmounted) act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete document.visibilityState;
  });
  await act(async () => root.render(createElement(StrictMode, null, createElement(UiCustomizationStatus))));
  await flush();
  return {
    container, requests, timers, flush,
    async poll() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
      await flush();
    },
    async visibility(value) {
      state = value;
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    },
    unmount() { act(() => root.unmount()); unmounted = true; },
  };
}

test("status exposes applied source, deferred work and errors without native restart controls", async (t) => {
  let status = initial;
  const ui = await mount(t, async () => Response.json(status));
  assert.match(ui.container.querySelector('[role="status"]').textContent, /3/);
  const details = ui.container.querySelector("details");
  act(() => { details.open = true; });
  assert.ok(ui.container.textContent.includes(initial.sourceRoot));
  assert.ok(ui.container.textContent.includes(initial.appliedFiles[0]));
  status = { ...initial, appliedRevision: 4, deferredFiles: ["hooks/useAgentSession.ts"], lastError: "Source copy failed: access denied" };
  await ui.poll();
  assert.ok(ui.container.textContent.includes(status.deferredFiles[0]));
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /access denied/);
  status = { ...initial, appliedRevision: 5 };
  await ui.poll();
  assert.equal(ui.container.querySelector('[role="alert"]'), null);
  assert.equal(ui.container.querySelector("button, input, form"), null);
  assert.equal(ui.timers.size, 1, "StrictMode must leave only one poll scheduled");
  ui.unmount();
  assert.equal(ui.timers.size, 0);
  const count = ui.requests.length;
  await ui.visibility("visible");
  assert.equal(ui.requests.length, count, "unmount removes the visibility listener");
});

test("failed HTTP and malformed status are visible, retain last source, and recover", async (t) => {
  let response = () => Response.json(initial);
  const ui = await mount(t, async () => response());
  response = () => new Response("offline", { status: 503 });
  await ui.poll();
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /503/);
  assert.ok(ui.container.textContent.includes(initial.sourceRoot));
  response = () => Response.json({ enabled: true });
  await ui.poll();
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /Invalid/);
  response = () => { throw new Error("Connection interrupted"); };
  await ui.poll();
  assert.match(ui.container.querySelector('[role="alert"]').textContent, /Connection interrupted/);
  response = () => Response.json(initial);
  await ui.poll();
  assert.equal(ui.container.querySelector('[role="alert"]'), null);
});

test("polling is visible-only, cancels in-flight reads, and ignores late responses after cleanup", async (t) => {
  const pending = [];
  const ui = await mount(t, (_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal })), true);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.timers.size, 0);
  await ui.visibility("visible");
  assert.equal(ui.requests.length, 1);
  await ui.poll();
  assert.equal(ui.requests.length, 1, "an unresolved request cannot overlap another poll");
  await ui.visibility("hidden");
  assert.equal(pending[0].signal.aborted, true);
  await act(async () => pending[0].resolve(Response.json(initial)));
  await ui.flush();
  assert.equal(ui.timers.size, 0);
  assert.ok(!ui.container.textContent.includes(initial.sourceRoot), "hidden response was discarded");
  await ui.visibility("visible");
  assert.equal(ui.requests.length, 2);
  await act(async () => pending[1].resolve(Response.json(initial)));
  await ui.flush();
  assert.equal(ui.timers.size, 1);
  await ui.visibility("hidden");
  assert.equal(ui.timers.size, 0);
  await ui.visibility("visible");
  ui.unmount();
  assert.equal(pending[2].signal.aborted, true);
  await act(async () => pending[2].resolve(Response.json({ ...initial, lastError: "late error" })));
  await ui.flush();
  assert.equal(ui.container.textContent, "");
  assert.equal(ui.timers.size, 0);
});
