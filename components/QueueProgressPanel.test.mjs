import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, within } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { QueueProgressPanel } = await import("./QueueProgressPanel.tsx");
const { QueueProgressLedger, buildQueuePanelItems } = await import("../lib/queue-progress.ts");

afterEach(cleanup);

const queue = (followUp = [], steering = []) => ({ followUp, steering });
function panel(items, props = {}) {
  const calls = [];
  const defaults = {
    actionPending: false, canRemove: true, canPromote: true, promoteBlocked: false,
    onAction: (entry, action) => calls.push([action, entry.kind, entry.text]),
    onDelete: (entry) => calls.push(["delete", entry.kind, entry.text]),
    ...props,
  };
  const view = render(React.createElement(QueueProgressPanel, { ...defaults, items }));
  return { ...view, calls, update: (next) => view.rerender(React.createElement(QueueProgressPanel, { ...defaults, items: next })) };
}

test("native pending follow-ups can be edited, deleted and steered; steers cannot be promoted again", async () => {
  const user = userEvent.setup();
  const { container, calls } = panel(buildQueuePanelItems(null, queue(["follow"], ["steer"])));
  const queries = within(container);
  assert.ok(container.querySelector("button[aria-expanded]").textContent.includes("steer"), "the preview follows native steering priority");
  assert.equal(container.querySelector("button[aria-expanded]").textContent.includes("follow"), false);
  await user.click(queries.getByRole("button", { name: /Show all queued prompts/ }));
  const rows = [...container.querySelectorAll("[data-queue-item]")];
  assert.equal(rows.length, 2);
  const steer = within(rows.find((row) => row.textContent.includes("steer")));
  const follow = within(rows.find((row) => row.textContent.includes("follow")));
  assert.equal(steer.queryByRole("button", { name: "Steer", exact: true }), null);
  await user.click(steer.getByRole("button", { name: "Edit", exact: true }));
  await user.click(follow.getByRole("button", { name: "Delete", exact: true }));
  await user.click(follow.getByRole("button", { name: "Steer", exact: true }));
  assert.deepEqual(calls, [["edit", "steer", "steer"], ["delete", "follow-up", "follow"], ["steer", "follow-up", "follow"]]);
});

test("native consumption removes a steer from the panel and the last consumed message hides it despite ledger history", async () => {
  let id = 0;
  const ledger = new QueueProgressLedger({ epoch: "panel", createId: () => String(++id) });
  ledger.observeQueue(queue(["later"], ["consumed steer"]), 1);
  const { container, update } = panel(buildQueuePanelItems(ledger.snapshot(), queue(["later"], ["consumed steer"])));
  const user = userEvent.setup();
  await user.click(within(container).getByRole("button", { name: /Show all queued prompts/ }));
  assert.ok(within(container).getByText("consumed steer"));
  // The native queue frame can precede its ledger update and transcript echo.
  update(buildQueuePanelItems(ledger.snapshot(), queue(["later"])));
  assert.equal(within(container).queryByText("consumed steer"), null);
  assert.ok(within(container).getByText("later"));
  ledger.observeQueue(queue(["later"]), 2);
  ledger.observeUserMessage("consumed steer", 3);
  update(buildQueuePanelItems(ledger.snapshot(), queue(["later"])));
  assert.equal(within(container).queryByText("consumed steer"), null);
  ledger.observeQueue(queue(), 4);
  ledger.observeUserMessage("later", 5);
  ledger.observeRunEnd("completed", 6);
  update(buildQueuePanelItems(ledger.snapshot(), queue()));
  assert.equal(container.querySelector('[aria-label="Queued prompts"]'), null);
});

test("equal pending occurrences are retained, but only the first can invoke text-based queue commands", async () => {
  const user = userEvent.setup();
  const { container, calls } = panel(buildQueuePanelItems(null, queue(["again", "again"])));
  await user.click(within(container).getByRole("button", { name: /Show all queued prompts/ }));
  assert.equal(within(container).getAllByText("again").length, 2);
  assert.equal(within(container).getAllByRole("button", { name: "Delete", exact: true }).length, 1);
  await user.click(within(container).getByRole("button", { name: "Delete", exact: true }));
  assert.deepEqual(calls, [["delete", "follow-up", "again"]]);
});

test("queue actions remain disabled while a native mutation is pending", () => {
  const { container } = panel(buildQueuePanelItems(null, queue(["pending"])), { actionPending: true });
  const queries = within(container);
  for (const name of ["Edit", "Delete", "Steer"]) assert.equal(queries.getByRole("button", { name, exact: true }).disabled, true);
});
