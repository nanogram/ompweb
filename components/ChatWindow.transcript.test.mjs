import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { CommittedTranscript } = await import("./ChatWindow.tsx");
const { collectToolResults, planTranscriptRows, transcriptRowIndex } = await import("../lib/chat-transcript-plan.ts");
const { translate } = await import("../lib/i18n");
afterEach(cleanup);

const assistant = (text, extra = {}) => ({ role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }], ...extra });
function propsFor(messages, options = {}) {
  const refs = new Map();
  let lastAnchorIdx = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastAnchorIdx = index;
    if (message.role === "user" || message.role === "assistant") refs.set(index, refs.size);
  });
  return {
    messages, entryIds: messages.map((_, index) => `entry-${index}`),
    rows: planTranscriptRows(messages, { presentation: "focused" }),
    presentation: "focused", expandProcessDetails: false, revealFolded: false, selectedMessageIndex: null,
    conversationMeta: { toolResultsMap: collectToolResults(messages), lastAnchorIdx, visibleRefIndexByMessage: refs },
    messageRefs: { current: [] }, isStreaming: false, sessionBusy: false, isCompacting: false,
    externalRunActive: false, isNew: true, forkingEntryId: null, editingEntryId: null,
    handleFork() {}, handleEdit: async () => true, modelNames: {}, toolCallsDefaultCollapsed: true,
    hideToolActivity: true, expandThinkingByDefault: false, hideThinkingBlock: false,
    visibleCount: 40, nearBottom: true, sentinelRef: { current: null }, handleLoadMoreClick() {},
    hasOlder: false, loadingOlder: false, olderHistoryError: false, handleLoadOlder() {}, ...options,
  };
}

const completed = () => [
  { role: "user", content: "Please investigate" },
  assistant("Intermediate needle"),
  assistant("The final answer", { stopReason: "stop" }),
];

test("focused process details are interactive and search mounts the folded hit", () => {
  const props = propsFor(completed());
  const view = render(React.createElement(CommittedTranscript, props));
  assert.equal(view.queryByText("Intermediate needle"), null);
  assert.ok(view.getByText("The final answer"));
  const toggle = view.getByRole("button", { name: /Process details/ });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  assert.ok(view.getByText("Intermediate needle"));
  fireEvent.click(toggle);
  assert.equal(view.queryByText("Intermediate needle"), null);
  view.rerender(React.createElement(CommittedTranscript, { ...props, revealFolded: true }));
  assert.ok(view.getByText("Intermediate needle"));
  assert.equal(view.getByRole("button", { name: /Process details/ }).getAttribute("aria-expanded"), "true");
  assert.ok(view.container.querySelector('[data-message-text][data-entry-id="entry-1"]'), "the sidebar search can target the mounted intermediate entry");
});

test("selected folded entries and expanded-by-default details remain reachable", () => {
  const props = propsFor(completed(), { selectedMessageIndex: 1 });
  const view = render(React.createElement(CommittedTranscript, props));
  assert.ok(view.container.querySelector('[data-message-index="1"]'));
  assert.ok(view.getByText("Intermediate needle"));
  view.rerender(React.createElement(CommittedTranscript, { ...props, selectedMessageIndex: null, expandProcessDetails: true }));
  assert.ok(view.getByText("Intermediate needle"));
});

test("unfinished and provider-error output is visible without opening details", () => {
  for (const stopReason of ["aborted", "error", "length", undefined]) {
    const messages = [{ role: "user", content: "go" }, assistant("Work in progress"), assistant("Preserve this output", { stopReason, ...(stopReason === "error" ? { errorMessage: "Provider failure" } : {}) })];
    const view = render(React.createElement(CommittedTranscript, propsFor(messages)));
    assert.ok(view.getByText("Work in progress"));
    assert.ok(view.getByText("Preserve this output"));
    if (stopReason === "error") assert.ok(view.getByText("Provider failure"));
    view.unmount();
  }
});

test("a lazy jump widens the renderer's exact row plan for every folding preference", () => {
  const messages = Array.from({ length: 12 }, (_, index) => [
    { role: "user", content: `Prompt ${index}` },
    assistant(`Progress ${index}`, { content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: `Progress ${index}` }] }),
    assistant(`Answer ${index}`, { stopReason: "stop" }),
  ]).flat();
  for (const options of [{}, { neverFold: true }, { showThinking: true }, { hideThinking: true }, { showToolCalls: true }]) {
    const rows = planTranscriptRows(messages, { ...options, presentation: "focused" });
    const props = propsFor(messages, { rows, visibleCount: 4 });
    const view = render(React.createElement(CommittedTranscript, props));
    assert.equal(view.queryByText("Prompt 0"), null);
    const needed = rows.length - transcriptRowIndex(rows, 0);
    view.rerender(React.createElement(CommittedTranscript, { ...props, visibleCount: needed, nearBottom: false }));
    assert.ok(view.getByText("Prompt 0"));
    assert.ok(view.container.querySelector('[data-message-index="0"]'));
    view.unmount();
  }
});

test("tool-only failures and cancellations keep a visible status outside the fold", () => {
  for (const [stopReason, label] of [
    ["aborted", "Generation interrupted"],
    ["error", "The agent stopped without returning a response. Please retry and check the provider configuration if this continues."],
  ]) {
    const messages = [
      { role: "user", content: "go" },
      assistant("", { stopReason, content: [{ type: "toolCall", toolCallId: "call", toolName: "bash", input: { command: "echo test" } }] }),
    ];
    const view = render(React.createElement(CommittedTranscript, propsFor(messages)));
    assert.ok(view.getByText(label), stopReason);
    fireEvent.click(view.getByRole("button", { name: /Process details/ }));
    assert.equal(view.getAllByText(label).length, 1, "expanding tool activity does not duplicate the end status");
    view.unmount();
  }
});

test("finishing a continued turn closes its new progress history without hiding the new final reply", () => {
  const messages = completed();
  const view = render(React.createElement(CommittedTranscript, propsFor(messages)));
  fireEvent.click(view.getByRole("button", { name: /Process details/ }));
  assert.ok(view.getByText("Intermediate needle"));
  const continued = [...messages, assistant("More work"), assistant("Updated final answer", { stopReason: "stop" })];
  view.rerender(React.createElement(CommittedTranscript, propsFor(continued)));
  assert.equal(view.queryByText("Intermediate needle"), null);
  assert.equal(view.queryByText("The final answer"), null, "the old answer is now expandable progress");
  assert.ok(view.getByText("Updated final answer"));
});

test("local render pages precede the accessible remote older-history control and retry", () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({ role: "user", content: `saved prompt ${index}` }));
  let local = 0;
  let remote = 0;
  const props = propsFor(messages, {
    hasOlder: true,
    handleLoadMoreClick() { local += 1; },
    handleLoadOlder() { remote += 1; },
  });
  const view = render(React.createElement(CommittedTranscript, props));
  fireEvent.click(view.getByRole("button", { name: translate("chatWindow.scrollUpToLoad", { count: 20 }) }));
  assert.equal(local, 1);
  assert.equal(remote, 0);
  view.rerender(React.createElement(CommittedTranscript, { ...props, visibleCount: 100 }));
  fireEvent.click(view.getByRole("button", { name: translate("chatWindow.loadOlderMessages") }));
  assert.equal(remote, 1);
  view.rerender(React.createElement(CommittedTranscript, { ...props, visibleCount: 100, loadingOlder: true }));
  const busy = view.getByRole("button", { name: translate("chatWindow.loadingOlderMessages") });
  assert.equal(busy.disabled, true);
  assert.equal(busy.getAttribute("aria-busy"), "true");
  view.rerender(React.createElement(CommittedTranscript, { ...props, visibleCount: 100, olderHistoryError: true }));
  fireEvent.click(view.getByRole("button", { name: translate("chatWindow.retryOlderMessages") }));
  assert.equal(remote, 2);
  assert.ok(view.getByText("saved prompt 59"), "a failed remote page cannot hide saved text");
});


test("prepending persisted entries preserves the open process details of an existing turn", () => {
  const messages = completed();
  const ids = ["prompt", "progress", "answer"];
  const view = render(React.createElement(CommittedTranscript, propsFor(messages, { entryIds: ids })));
  fireEvent.click(view.getByRole("button", { name: /Process details/ }));
  assert.ok(view.getByText("Intermediate needle"));
  const earlier = [{ role: "user", content: "Earlier prompt" }, assistant("Earlier final", { stopReason: "stop" })];
  view.rerender(React.createElement(CommittedTranscript, propsFor([...earlier, ...messages], {
    entryIds: ["earlier-prompt", "earlier-answer", ...ids], visibleCount: 100, nearBottom: false,
  })));
  assert.ok(view.getByText("Intermediate needle"));
  assert.ok(view.getByText("The final answer"));
});

