import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, within } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { QueueProgressPanel } = await import("./QueueProgressPanel.tsx");

afterEach(cleanup);

const item = (text, status, extra = {}) => ({
  id: `id-${text}`, text, queue: "followUp", status, queuedAt: 0, actionable: status === "queued", ...extra,
});

function panel(items, props = {}) {
  const calls = [];
  const view = render(React.createElement(QueueProgressPanel, {
    items,
    actionPending: false,
    canRemove: true,
    canPromote: true,
    promoteBlocked: false,
    onAction: (entry, action) => calls.push([action, entry.text]),
    onDelete: (entry) => calls.push(["delete", entry.text]),
    onDismiss: () => calls.push(["dismiss"]),
    ...props,
  }));
  return { ...view, calls };
}

const statusOf = (container) => [...container.querySelectorAll("[data-queue-item]")].map((row) => `${row.textContent.match(/(two|three|four)/)?.[0]}:${row.dataset.queueItem}`);

test("header counts done items; the list shows each status with durations and actions only for pending items", async () => {
  const user = userEvent.setup();
  const items = [
    item("two", "done", { startedAt: 1_000, finishedAt: 13_000 }),
    item("three", "running", { startedAt: 13_000 }),
    item("four", "queued"),
  ];
  const { container, calls } = panel(items);
  const queries = within(container);
  assert.match(container.querySelector("[data-queue-progress]").textContent, /^1 of 3 done$/);
  // Collapsed, the header previews the running item.
  assert.equal(container.querySelectorAll("[data-queue-item]").length, 0);
  assert.match(container.textContent, /three/);
  assert.ok(container.querySelector('[data-queue-status="running"] .animate-spin'), "the running item spins");

  await user.click(queries.getByRole("button", { name: /Show all queued prompts/ }));
  assert.deepEqual(statusOf(container), ["two:done", "three:running", "four:queued"]);
  assert.ok(queries.getByRole("img", { name: "Done" }));
  assert.ok(queries.getByRole("img", { name: "Pending" }));
  assert.equal(queries.getByTitle("Took 12s").textContent, "12s");
  // Edit/Delete/Steer exist for the pending item only.
  assert.equal(queries.getAllByRole("button", { name: "Edit", exact: true }).length, 1);
  await user.click(queries.getByRole("button", { name: "Delete", exact: true }));
  await user.click(queries.getByRole("button", { name: "Steer", exact: true }));
  assert.deepEqual(calls, [["delete", "four"], ["steer", "four"]]);
  assert.equal(queries.queryByRole("button", { name: /Dismiss/ }), null, "no dismiss while the batch runs");
});

test("failed and cancelled items are counted; a finished batch collapses to a dismissible summary", async () => {
  const user = userEvent.setup();
  const running = [item("two", "done", { startedAt: 0, finishedAt: 5_000 }), item("three", "running"), item("four", "queued")];
  const { container, calls, rerender } = panel(running);
  const queries = within(container);
  await user.click(queries.getByRole("button", { name: /Show all queued prompts/ }));
  assert.equal(container.querySelectorAll("[data-queue-item]").length, 3);

  const finished = [item("two", "done", { startedAt: 0, finishedAt: 5_000 }), item("three", "failed"), item("four", "cancelled")];
  rerender(React.createElement(QueueProgressPanel, {
    items: finished, actionPending: false, canRemove: true, canPromote: true, promoteBlocked: false,
    onAction() {}, onDelete() {}, onDismiss: () => calls.push(["dismiss"]),
  }));
  assert.equal(container.querySelectorAll("[data-queue-item]").length, 0, "the summary replaces the open list");
  assert.equal(container.querySelector("[data-queue-progress]").textContent, "1 of 3 done · 1 failed · 1 cancelled");
  await user.click(queries.getByRole("button", { name: /Dismiss/ }));
  assert.deepEqual(calls, [["dismiss"]]);

  // The header itself still opens the list (Dismiss replaced the Show-all text button).
  await user.click(container.querySelector("button[aria-expanded]"));
  assert.deepEqual(statusOf(container), ["two:done", "three:failed", "four:cancelled"]);
  assert.ok(queries.getByRole("img", { name: "Failed" }));
  assert.ok(queries.getByRole("img", { name: "Cancelled" }));
});

test("a single item shows inline: pending with its actions, finished with dismiss", () => {
  const { container, rerender } = panel([item("two", "queued")]);
  const queries = within(container);
  assert.deepEqual(statusOf(container), ["two:queued"]);
  assert.ok(queries.getByRole("button", { name: "Edit", exact: true }));
  rerender(React.createElement(QueueProgressPanel, {
    items: [item("two", "done", { startedAt: 0, finishedAt: 2_000 })], actionPending: false, canRemove: true, canPromote: true,
    promoteBlocked: false, onAction() {}, onDelete() {}, onDismiss() {},
  }));
  assert.deepEqual(statusOf(container), ["two:done"]);
  assert.equal(queries.queryByRole("button", { name: "Edit", exact: true }), null);
  assert.ok(queries.getByRole("button", { name: /Dismiss/ }));
});

test("a pending item omp no longer holds cannot be edited", () => {
  const { container } = panel([item("two", "queued", { actionable: false })]);
  assert.equal(within(container).queryByRole("button", { name: "Edit", exact: true }), null);
});
