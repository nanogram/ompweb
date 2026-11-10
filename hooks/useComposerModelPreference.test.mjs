import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");

// This is the real old browser cache, read before the shared client is initialized.
localStorage.setItem("omp-composer-models", JSON.stringify(["desktop:chosen"]));
const { useComposerModelPreference } = await import("./useComposerModelPreference.ts");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

function Viewer() {
  const preference = useComposerModelPreference();
  return createElement("div", null,
    createElement("output", null, JSON.stringify(preference.keys)),
    preference.error ? createElement("p", { role: "alert" }, preference.error) : null,
    createElement("button", { disabled: !preference.ready || preference.loading || preference.saving, onClick: () => void preference.save(null) }, "Show all"),
  );
}

test("mount migrates the desktop cache; focus, foreground and storage events fetch authority without publishing stale caches", async (t) => {
  const previousFetch = globalThis.fetch;
  let stored;
  let fail = false;
  const writes = [];
  globalThis.fetch = async (_url, init) => {
    if (fail) return Response.json({ error: "Preferences unavailable" }, { status: 503 });
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body);
      writes.push(body);
      if (!body.composerModelKeysIfUnset || stored === undefined) stored = body.composerModelKeys;
    }
    return Response.json(stored === undefined ? {} : { composerModelKeys: stored });
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    localStorage.removeItem("omp-composer-models");
  });
  const { container } = render(createElement(Viewer));
  await settle();
  assert.deepEqual(stored, ["desktop:chosen"]);
  assert.equal(writes.length, 1);
  assert.equal(container.querySelector("output").textContent, '["desktop:chosen"]');

  stored = ["mobile:chosen"];
  await act(async () => window.dispatchEvent(new Event("focus")));
  await settle();
  assert.equal(container.querySelector("output").textContent, '["mobile:chosen"]');

  stored = [];
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await settle();
  assert.equal(container.querySelector("output").textContent, "[]");
  assert.equal(writes.length, 1);

  localStorage.setItem("omp-composer-models", JSON.stringify(["stale:model"]));
  await act(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: "omp-composer-models" })));
  await settle();
  assert.equal(container.querySelector("output").textContent, "[]");
  assert.equal(writes.length, 1, "an existing viewer never publishes storage changes as shared saves");

  fail = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await settle();
  assert.match(within(container).getByRole("alert").textContent, /Preferences unavailable/);
  assert.equal(container.querySelector("output").textContent, "[]");
  fail = false;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await settle();
  assert.equal(within(container).queryByRole("alert"), null);
  fireEvent.click(within(container).getByRole("button", { name: "Show all" }));
  await settle();
  assert.equal(stored, null, "only an explicit user action can publish all models");
});
