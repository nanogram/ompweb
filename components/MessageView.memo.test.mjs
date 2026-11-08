import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");
const { MessageView, SafeMarkdownBody, areMessageViewPropsEqual, haveSameRelevantToolResults } = await import("./MessageView.tsx");
afterEach(cleanup);

const message = { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: "item-id", toolCallId: "call-id", toolName: "bash", input: { command: "echo test" } }] };
const result = (text) => ({ role: "toolResult", toolCallId: "call-id", content: [{ type: "text", text }] });

test("unrelated results do not invalidate a message, but its own live output does", () => {
  const first = result("Initial output");
  const map = new Map([["call-id", first], ["item-id", result("Wrong legacy lookup")]]);
  const unrelated = new Map(map).set("item-id", result("Unrelated update"));
  assert.equal(haveSameRelevantToolResults(message, map, unrelated), true);
  assert.equal(areMessageViewPropsEqual({ message, toolResults: map }, { message, toolResults: unrelated }), true);
  const updated = new Map(map).set("call-id", result("Updated output"));
  assert.equal(haveSameRelevantToolResults(message, map, updated), false);
  const props = { message, toolResults: map, isStreaming: true, toolCallsDefaultCollapsed: false };
  const view = render(React.createElement(MessageView, props));
  assert.match(view.container.textContent, /Initial output/);
  assert.doesNotMatch(view.container.textContent, /Wrong legacy lookup/);
  view.rerender(React.createElement(MessageView, { ...props, toolResults: updated }));
  assert.match(view.container.textContent, /Updated output/);
  assert.doesNotMatch(view.container.textContent, /Initial output/);
});

test("all message props, callbacks, deferred source indices and live metrics invalidate memoization", () => {
  const base = { message };
  const variants = {
    message: { ...message }, isStreaming: true, modelNames: {}, cwd: "/new", onOpenFile() {},
    entryId: "new", forkEntryId: "new", forkEditsPrompt: true, onFork() {}, forking: true,
    forkDisabled: true, onEdit: async () => true, editing: true, editDisabled: true,
    showTimestamp: true, prevTimestamp: 42, sessionId: "new", toolCallsDefaultCollapsed: false,
    expandThinkingByDefault: true, hideThinking: true, sourceBlockIndices: [0], liveTokensPerSecond: 5,
  };
  for (const [key, value] of Object.entries(variants)) {
    assert.equal(areMessageViewPropsEqual(base, { ...base, [key]: value }), false, `added ${key}`);
    assert.equal(areMessageViewPropsEqual({ ...base, [key]: value }, base), false, `removed ${key}`);
  }
  assert.equal(areMessageViewPropsEqual({ ...base, sourceBlockIndices: [1, 2] }, { ...base, sourceBlockIndices: [1, 2] }), true);
  assert.equal(areMessageViewPropsEqual({ ...base, sourceBlockIndices: [1, 2] }, { ...base, sourceBlockIndices: [2, 1] }), false);
  assert.equal(haveSameRelevantToolResults({ role: "assistant", content: null }, new Map(), new Map()), true);
});

test("memoized markdown still updates content, styling, streaming and image preferences", () => {
  const view = render(React.createElement(SafeMarkdownBody, { className: "before", isStreaming: true }, "First reply"));
  assert.ok(view.getByText("First reply"));
  view.rerender(React.createElement(SafeMarkdownBody, { className: "after", isStreaming: false }, "Second reply"));
  assert.ok(view.getByText("Second reply"));
  assert.equal(view.queryByText("First reply"), null);
  assert.ok(view.container.querySelector(".markdown-body.after"));
  view.rerender(React.createElement(SafeMarkdownBody, { suppressImages: true }, "![preview](https://example.com/picture.png)"));
  assert.equal(view.container.querySelector("img"), null);
  view.rerender(React.createElement(SafeMarkdownBody, { suppressImages: false }, "![preview](https://example.com/picture.png)"));
  assert.ok(view.container.querySelector("img"));
});
