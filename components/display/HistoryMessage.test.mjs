import assert from "node:assert/strict";
import "../../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, render } = await import("@testing-library/react/pure.js");
const { HistoryMessage } = await import("./HistoryMessage.tsx");
const { MarkdownBody } = await import("../MarkdownBody.tsx");
afterEach(cleanup);

function viewport(t) {
  const original = globalThis.IntersectionObserver;
  const observers = [];
  globalThis.IntersectionObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  t.after(() => { cleanup(); globalThis.IntersectionObserver = original; });
  return (visible) => act(() => {
    for (const observer of observers) observer.callback([...observer.targets].map((target) => ({ target, isIntersecting: visible })));
  });
}
const text = "**Saved reply** with [reference](https://example.com).";
const message = (props = {}) => React.createElement(HistoryMessage, { messageIndex: 4, ...props }, React.createElement(MarkdownBody, null, text));

test("offscreen source stays searchable and enhances once when approached", (t) => {
  const intersect = viewport(t);
  const view = render(React.createElement("div", { role: "log" }, message()));
  assert.ok(view.getByText(text));
  assert.equal(view.queryByRole("link"), null);
  intersect(true);
  assert.equal(view.getByRole("link", { name: "reference" }).href, "https://example.com/");
  intersect(false);
  assert.ok(view.getByRole("link", { name: "reference" }), "scrolling away must not discard enhanced content or its state");
});

test("initial rich work waits for readiness without hiding the newest source or later reverting it", (t) => {
  viewport(t);
  const view = render(message({ ready: false, immediate: true }));
  assert.ok(view.getByText(text));
  assert.equal(view.queryByRole("link"), null);
  view.rerender(message({ ready: true, immediate: true }));
  assert.ok(view.getByRole("link", { name: "reference" }));
  view.rerender(message({ ready: true, immediate: false }));
  assert.ok(view.getByRole("link", { name: "reference" }), "new work must not downgrade previously viewed history");
});

test("an explicit reveal enhances outside the viewport and unmount releases pending observations", (t) => {
  const intersect = viewport(t);
  const view = render(message());
  intersect(false);
  assert.equal(view.queryByRole("link"), null);
  view.rerender(message({ immediate: true }));
  assert.ok(view.getByRole("link", { name: "reference" }));
  view.unmount();
  intersect(true);
  const replacement = render(message());
  assert.equal(replacement.queryByRole("link"), null, "another entry cannot inherit visibility from an unmounted row");
});

for (const atBottom of [false, true]) {
  test(`enhancing history above the viewport preserves ${atBottom ? "bottom following" : "the viewed entry"}`, (t) => {
    const intersect = viewport(t);
    const view = render(React.createElement("div", { role: "log" },
      message(),
      message({ messageIndex: 5, immediate: true }),
    ));
    const root = view.getByRole("log");
    const [older, anchor] = root.querySelectorAll("[data-message-index]");
    const olderHeight = () => older.dataset.historyRendering === "rich" ? 200 : 100;
    let scrollTop = 0;
    Object.defineProperties(root, {
      clientHeight: { get: () => 100 },
      scrollHeight: { get: () => olderHeight() + 300 },
      scrollTop: {
        get: () => scrollTop,
        set: (value) => { scrollTop = Math.max(0, Math.min(value, root.scrollHeight - root.clientHeight)); },
      },
    });
    root.getBoundingClientRect = () => ({ top: 10, bottom: 110 });
    older.getBoundingClientRect = () => ({ top: 10 - scrollTop, bottom: 10 - scrollTop + olderHeight() });
    anchor.getBoundingClientRect = () => ({ top: 10 - scrollTop + olderHeight(), bottom: 310 - scrollTop + olderHeight() });
    root.scrollTop = atBottom ? 300 : 150;
    const offset = anchor.getBoundingClientRect().top - root.getBoundingClientRect().top;
    intersect(true);
    if (atBottom) assert.equal(root.scrollHeight - root.scrollTop - root.clientHeight, 0);
    else assert.equal(anchor.getBoundingClientRect().top - root.getBoundingClientRect().top, offset);
  });
}
