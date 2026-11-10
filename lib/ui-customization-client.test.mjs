import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import React, { StrictMode, act } from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { ChatInput } = await import("../components/ChatInput.tsx");
const { clearDraft, getDraft, setDraft } = await import("./draft-store.ts");
const { createComposerHmrPreservation, serializeCssHmrUpdates } = await import("./ui-customization-client.ts");
const { composerModelPreference } = await import("./composer-model-preference.ts");

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  globalThis.fetch = async (url) => {
    if (new URL(url, window.location.href).pathname === "/api/web-settings") {
      return Response.json({ composerModelKeys: null });
    }
    throw new Error(`Unexpected HMR fixture request: ${url}`);
  };
  await composerModelPreference.refresh();
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("overlapping stylesheet updates apply the newest CSS without modification-lock failures", async (t) => {
  t.after(serializeCssHmrUpdates());
  const sheet = new window.CSSStyleSheet();
  await Promise.all([
    sheet.replace(".sample { color: red; }"),
    sheet.replace(".sample { color: blue; }"),
    sheet.replace(".sample { color: lime; }"),
  ]);
  assert.equal(sheet.cssRules.length, 1);
  assert.equal(sheet.cssRules[0].style.color, "lime");
});

test("a native replacement failure stays observable without blocking the next update", async (t) => {
  const sheet = new window.CSSStyleSheet();
  const existing = sheet.replace(".sample { color: red; }");
  t.after(serializeCssHmrUpdates());
  const failed = sheet.replace(".sample { color: blue; }");
  const recovered = sheet.replace(".sample { color: lime; }");
  await assert.rejects(failed, { name: "NotAllowedError" });
  await Promise.all([existing, recovered]);
  assert.equal(sheet.cssRules[0].style.color, "lime");
});

test("hot reload does not make document-owned stylesheets replaceable", async (t) => {
  t.after(serializeCssHmrUpdates());
  const style = document.createElement("style");
  style.textContent = ".sample { color: red; }";
  document.head.append(style);
  t.after(() => style.remove());
  await assert.rejects(style.sheet.replace(".sample { color: blue; }"), { name: "NotAllowedError" });
  assert.equal(style.sheet.cssRules[0].style.color, "red");
});

function setup(t) {
  const key = "ui-customization-draft";
  const value = "a long unsent draft\nwith several lines\nand a selected phrase";
  const files = [{ name: "notes.txt", mimeType: "text/plain", content: "keep in memory", size: 14 }];
  setDraft(key, { value, images: [], files });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = (frame) => frames.delete(frame);
  const controller = createComposerHmrPreservation();
  const calls = [];
  const composer = (generation) => React.createElement(StrictMode, null,
    React.createElement(ChatInput, {
      key: generation, draftKey: key, isStreaming: true,
      onSend: async () => { calls.push("send"); return { status: "accepted" }; },
      onAbort: () => calls.push("abort"),
    }));
  const view = render(composer(0));
  const textarea = () => view.container.querySelector(".chat-input-shell textarea");
  textarea().focus();
  textarea().setSelectionRange(7, 19, "backward");
  textarea().scrollTop = 37;
  textarea().scrollLeft = 9;
  t.after(() => {
    controller.cancel();
    cleanup();
    clearDraft(key);
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
    delete window.matchMedia;
    window.history.replaceState(null, "", "/");
  });
  return {
    controller, view, textarea, calls, key, value, files,
    replace() { view.rerender(composer(1)); },
    async frame() {
      await act(async () => { await Promise.resolve(); });
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(0));
      });
    },
  };
}

test("Bun's update interval restores a real StrictMode composer remount from the existing draft store", async (t) => {
  const ui = setup(t);
  const original = ui.textarea();
  const parent = original.closest('[role="group"]').parentElement;
  parent.scrollTop = 88;
  ui.controller.beforeUpdate();
  // Bun's afterUpdate can precede React's committed DOM replacement.
  ui.controller.afterUpdate();
  await ui.frame();
  assert.equal(document.activeElement, original);
  // Chromium emits focusout while the focused node is still connected,
  // just before React removes it. JSDOM does not emit it for removal.
  original.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  ui.replace();
  assert.notEqual(ui.textarea(), original);
  await ui.frame();
  assert.equal(document.activeElement, ui.textarea());
  assert.equal(ui.textarea().value, ui.value);
  assert.deepEqual([ui.textarea().selectionStart, ui.textarea().selectionEnd, ui.textarea().selectionDirection], [7, 19, "backward"]);
  assert.deepEqual([ui.textarea().scrollTop, ui.textarea().scrollLeft, parent.scrollTop], [37, 9, 88]);
  assert.deepEqual(getDraft(ui.key).files, ui.files);
  assert.deepEqual(ui.calls, [], "display replacement must not send or abort a native task");
});

test("ordinary composer remounts and updates begun outside the composer never take focus", async (t) => {
  const ui = setup(t);
  ui.replace();
  await ui.frame();
  assert.notEqual(document.activeElement, ui.textarea());
  const button = document.createElement("button");
  document.body.append(button);
  t.after(() => button.remove());
  button.focus();
  ui.controller.beforeUpdate();
  ui.controller.afterUpdate();
  await ui.frame();
  assert.equal(document.activeElement, button);
});

for (const boundary of ["navigation", "URL change", "focus elsewhere", "blur", "pointer", "typing", "changed draft", "cancelled update"]) {
  test(`${boundary} during HMR must not restore an old selection or steal focus`, async (t) => {
    const ui = setup(t);
    ui.controller.beforeUpdate();
    if (boundary === "blur") {
      ui.textarea().blur();
      await Promise.resolve();
    }
    ui.replace();
    const replacement = ui.textarea();
    let expectedFocus = document.activeElement;
    if (boundary === "navigation") window.dispatchEvent(new Event("omp:navigate"));
    if (boundary === "URL change") window.history.replaceState(null, "", "/?session=another");
    if (boundary === "focus elsewhere") {
      const button = document.createElement("button");
      document.body.append(button);
      t.after(() => button.remove());
      button.focus();
      expectedFocus = button;
    }
    if (boundary === "pointer") document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    if (boundary === "typing") replacement.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    if (boundary === "changed draft") fireEvent.change(replacement, { target: { value: "new edit after replacement" } });
    if (boundary === "cancelled update") ui.controller.cancel();
    replacement.setSelectionRange(2, 2);
    ui.controller.afterUpdate();
    await ui.frame();
    assert.equal(document.activeElement, expectedFocus);
    assert.equal(replacement.selectionStart, 2);
    assert.equal(replacement.value, boundary === "changed draft" ? "new edit after replacement" : ui.value);
    assert.deepEqual(ui.calls, []);
  });
}

test("a focused replacement with a newer value is never overwritten even without an input event", async (t) => {
  const ui = setup(t);
  ui.controller.beforeUpdate();
  ui.replace();
  // Settle mount-owned preference hydration before simulating a newer DOM owner.
  await act(async () => { await composerModelPreference.refresh(); });
  // Programmatic hydration/edit: no DOM input event accompanies this value.
  ui.textarea().value = "new owner text";
  ui.controller.afterUpdate();
  await ui.frame();
  assert.equal(ui.textarea().value, "new owner text");
  assert.notEqual(document.activeElement, ui.textarea());
});

test("an intact composer is not reset, and cleanup cancels a queued restoration", async (t) => {
  const ui = setup(t);
  ui.controller.beforeUpdate();
  ui.controller.afterUpdate();
  await ui.frame();
  ui.textarea().setSelectionRange(1, 1);
  window.dispatchEvent(new Event("omp:navigate"));
  ui.replace();
  await ui.frame();
  assert.notEqual(document.activeElement, ui.textarea());
  ui.textarea().focus();
  ui.controller.beforeUpdate();
  ui.view.rerender(React.createElement("div", { className: "chat-input-shell" }, React.createElement("textarea", { defaultValue: ui.value })));
  ui.controller.afterUpdate();
  ui.controller.cancel();
  await ui.frame();
  assert.notEqual(document.activeElement, ui.textarea());
});

test("an expired Bun update cannot focus a composer mounted much later", async (t) => {
  const ui = setup(t);
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let id = 0;
  globalThis.setTimeout = (callback) => { const key = ++id; timers.set(key, callback); return key; };
  globalThis.clearTimeout = (key) => timers.delete(key);
  try {
    ui.controller.beforeUpdate();
    ui.controller.afterUpdate();
    for (const callback of [...timers.values()]) callback();
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  }
  ui.replace();
  await ui.frame();
  assert.notEqual(document.activeElement, ui.textarea());
});
