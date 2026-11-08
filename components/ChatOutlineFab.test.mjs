import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { ChatOutlineFab } = await import("./ChatOutlineFab.tsx");
const { ChatMinimap } = await import("./ChatMinimap.tsx");
window.matchMedia = globalThis.matchMedia;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
afterEach(cleanup);

const messages = [
  { role: "user", content: "First prompt" },
  { role: "assistant", content: [{ type: "text", text: "Reply" }] },
  { role: "toolResult", toolCallId: "x", content: [] },
  { role: "user", content: "Older unmounted target" },
];
const props = () => ({ messages, scrollContainer: { current: null }, messageRefs: { current: [] }, nearBottom: false, isMobile: true });

test("FAB navigates an unmounted prompt through the renderer callback, not a guessed scroll position", () => {
  const jumps = [];
  const view = render(React.createElement(ChatOutlineFab, { ...props(), onEnsureVisible: (...args) => jumps.push(args) }));
  const opener = view.getByRole("button", { name: "Conversation outline" });
  fireEvent.click(opener);
  assert.equal(opener.getAttribute("aria-expanded"), "true");
  assert.ok(view.getByRole("dialog", { name: "Outline" }));
  fireEvent.click(view.getByRole("button", { name: "Jump to: Older unmounted target" }));
  assert.deepEqual(jumps, [[3, true]], "tool-result entries must not shift source message indices");
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.activeElement, opener);
  assert.equal(opener.style.width, "44px", "the mobile control retains a touch-sized target");
});

test("outline Escape respects IME and closes without triggering the global abort shortcut", () => {
  const view = render(React.createElement(ChatOutlineFab, { ...props(), onEnsureVisible() {} }));
  const opener = view.getByRole("button", { name: "Conversation outline" });
  fireEvent.click(opener);
  const dialog = view.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
  assert.ok(view.getByRole("dialog"));
  let aborted = false;
  const abort = () => { aborted = true; };
  window.addEventListener("keydown", abort);
  try { fireEvent.keyDown(dialog, { key: "Escape" }); }
  finally { window.removeEventListener("keydown", abort); }
  assert.equal(aborted, false);
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.activeElement, opener);
});

test("desktop rail uses the identical exact-message jump callback for lazy history", () => {
  const jumps = [];
  const view = render(React.createElement(ChatMinimap, { ...props(), onEnsureVisible: (...args) => jumps.push(args) }));
  fireEvent.click(view.getByRole("button", { name: "Jump to: Older unmounted target" }));
  assert.deepEqual(jumps, [[3, true]]);
});
