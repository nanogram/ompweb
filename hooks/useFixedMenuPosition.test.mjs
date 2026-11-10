import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { act } from "react";
import { cleanup, renderHook } from "@testing-library/react/pure.js";
import { useFixedMenuPosition } from "./useFixedMenuPosition.ts";

let viewport, resizeAnchor;
const viewportDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
beforeEach(() => {
  viewport = Object.assign(new window.EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(callback) { resizeAnchor = callback; }
    observe() {}
    disconnect() {}
  } });
  document.documentElement.style.setProperty("--ui-scale", "1");
});
afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-scale");
  if (viewportDescriptor) Object.defineProperty(window, "visualViewport", viewportDescriptor);
  else delete window.visualViewport;
  if (observerDescriptor) Object.defineProperty(globalThis, "ResizeObserver", observerDescriptor);
  else delete globalThis.ResizeObserver;
});
function anchorAt(top = 700, left = 16) {
  const element = document.createElement("div");
  let rect = { top, left, bottom: 830, width: 358, height: 830 - top };
  element.getBoundingClientRect = () => rect;
  return { ref: { current: element }, move(next) { rect = { ...rect, ...next }; } };
}
function above(anchor) {
  return renderHook(() => useFixedMenuPosition(true, anchor.ref, 520, { placement: "above", height: 420 }));
}

test("an above-composer picker shrinks into the space above a tall draft instead of covering it", () => {
  const anchor = anchorAt(250);
  const { result } = above(anchor);
  assert.equal(result.current.top, 8);
  assert.equal(result.current.height, 238);
  assert.equal(result.current.top + result.current.height, 246);
  assert.ok(result.current.left + result.current.width <= viewport.width - 8);
});

test("composer growth and mobile keyboard changes retain the gap above the composer", () => {
  const anchor = anchorAt();
  const { result } = above(anchor);
  assert.equal(result.current.top + result.current.height, 696);
  anchor.move({ top: 180, height: 650 });
  act(() => resizeAnchor());
  assert.equal(result.current.top + result.current.height, 176);
  viewport.height = 350;
  viewport.offsetTop = 30;
  anchor.move({ top: 200, bottom: 340, height: 140 });
  act(() => viewport.dispatchEvent(new window.Event("resize")));
  assert.equal(result.current.top, 38);
  assert.equal(result.current.top + result.current.height, 196);
});

test("scaled coordinates keep above menus clear while default below menus retain their placement", () => {
  document.documentElement.style.setProperty("--ui-scale", "1.25");
  const anchor = anchorAt(600);
  const { result } = above(anchor);
  assert.equal((result.current.top + result.current.height) * 1.25, 595);
  const below = renderHook(() => useFixedMenuPosition(true, anchor.ref, 160));
  assert.equal(below.result.current.top * 1.25, 835);
  assert.equal(below.result.current.height, undefined);
});
