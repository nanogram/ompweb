import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { ComposerPanels } = await import("./ComposerPanels.tsx");

const noop = () => {};

test("renders nothing when there are no tasks or subagents", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [],
    onSelectSubagent: noop,
  })), "");
});

test("attaches todo plan and subagent roster with live states", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [
      { id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 },
      { id: "s2", agent: "worker", status: "completed", task: "Write the code", index: 1 },
    ],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));

  assert.match(html, /Tasks/);
  assert.match(html, /Wire panels/);
  assert.match(html, /Subagents/);
  assert.match(html, /scout/);
  assert.match(html, /Map the surface/);
  assert.match(html, /worker/);
  assert.match(html, /aria-label="1 running · 2 total"/);
  assert.doesNotMatch(html, />1 running · 2 total</);
});


test("live chips show current tool, telemetry, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      detached: true,
      progress: {
        currentTool: "read",
        lastIntent: "Inspect foo.ts",
        tokens: 2200,
        cost: 0.0041,
        contextTokens: 8000,
        contextWindow: 32000,
        resolvedModel: "provider/gpt-x:high",
      },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));

  assert.match(html, /Map the surface/);
  assert.match(html, /read — Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="2\.2k tok"/);
  assert.match(html, /data-subagent-metric="8k\/32k ctx"/);
  assert.match(html, /data-subagent-metric="gpt-x"/);
  assert.doesNotMatch(html, />2\.2k tok</);
  assert.doesNotMatch(html, />8k\/32k ctx</);
  assert.match(html, /⤴/);
});

test("retrying chips surface retry state instead of the activity line", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "worker",
      status: "started",
      task: "Write the code",
      index: 0,
      progress: { retryState: { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 1 } },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /data-subagent-metric="retrying 2\/5"/);
  assert.doesNotMatch(html, />retrying 2\/5</);
});

test("coexists with composer layout and keeps todo progress summary accessible", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Checklist item 1", status: "pending" }, { content: "Checklist item 2", status: "completed" }] }],
    subagents: [],
    onSelectSubagent: noop,
  }));
  assert.match(html, /Tasks/);
  assert.match(html, /1\/2 complete/);
});

test("settled and history-only rosters do not reserve composer space", () => {
  for (const subagent of [
    { status: "completed" },
    { status: "failed" },
    { status: "aborted" },
    { status: "started", source: "history" },
  ]) {
    assert.equal(renderToStaticMarkup(React.createElement(ComposerPanels, {
      todoPhases: [],
      subagents: [{ id: "s1", agent: "scout", task: "Earlier work", index: 0, ...subagent }],
      onSelectSubagent: noop,
      defaultExpanded: true,
    })), "");
  }
});

test("chips show agent source, nested count, and async marker", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      agentSource: "user",
      detached: true,
      progress: {
        lastIntent: "Inspect foo.ts",
        inflightTaskDetails: { progress: [{ id: "g1", agent: "task" }, { id: "g2", agent: "task" }] },
      },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="user"/);
  assert.match(html, /data-subagent-metric="2 nested"/);
  assert.match(html, /⤴/);
});

test("history chips mark detached async spawns", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Async audit",
      index: 0,
      source: "history",
      detached: true,
    },
    { id: "s2", agent: "worker", status: "started", task: "Current work", index: 1 }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.match(html, /⤴/);
});


test("zero context tokens never print a null gauge", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{
      id: "s1",
      agent: "scout",
      status: "started",
      task: "Map the surface",
      index: 0,
      progress: { currentTool: "read", contextTokens: 0, contextWindow: 32000 },
    }],
    onSelectSubagent: noop,
    defaultExpanded: true,
  }));
  assert.doesNotMatch(html, /null/);
  assert.match(html, /read/);
});

test("completed subagents nest under a collapsed Completed group", () => {
  // Roster expanded from storage, as after a user opened it; the completed
  // group itself must still start collapsed.
  globalThis.window = { localStorage: { getItem: () => "false", setItem: () => {} } };
  try {
    const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
      todoPhases: [],
      subagents: [
        { id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 },
        { id: "s2", agent: "worker", status: "completed", task: "Write the code", index: 1 },
        { id: "s3", agent: "worker", status: "failed", task: "Break the build", index: 2 },
        { id: "s4", agent: "scout", status: "started", task: "Old snapshot", index: 3, source: "history" },
      ],
      onSelectSubagent: noop,
    }));
    assert.match(html, /Map the surface/);
    assert.match(html, /Completed \(3\)/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /Write the code/);
    assert.doesNotMatch(html, /Break the build/);
    assert.doesNotMatch(html, /Old snapshot/);
  } finally {
    delete globalThis.window;
  }
});

test("a side question keeps Copy for the earlier answer when its follow-up ended without text", () => {
  const record = {
    id: "b1", leafId: null, question: "what is 2+2", answer: "It is 4.", status: "complete", createdAt: 1, updatedAt: 2,
    followUps: [{ question: "and 3+3?", answer: "", status: "cancelled", createdAt: 3, updatedAt: 4 }],
  };
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [],
    onSelectSubagent: noop,
    btw: { record, onCancel: noop, onFollowUp: async () => true, onClose: noop },
  }));
  assert.match(html, /It is 4\./);
  assert.match(html, /Cancelled/);
  assert.match(html, />Copy answer</);
});

test("merges live status into the todo header row when tasks exist (#245)", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [{ name: "Implementation", tasks: [{ content: "Wire panels", status: "in_progress" }] }],
    subagents: [{ id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
    liveStatus: "Waiting for model...",
  }));
  // Hosted exactly once: by the todo row, not duplicated in the subagent row.
  // (The string itself appears twice in markup — text plus title — so count
  // the role="status" host elements instead.)
  assert.equal((html.match(/role="status"/g) || []).length, 1);
  assert.match(html, /Tasks/);
});

test("merges live status into the subagent header row when no tasks exist (#245)", () => {
  const html = renderToStaticMarkup(React.createElement(ComposerPanels, {
    todoPhases: [],
    subagents: [{ id: "s1", agent: "scout", status: "started", task: "Map the surface", index: 0 }],
    onSelectSubagent: noop,
    liveStatus: "Waiting for model...",
  }));
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /Subagents/);
});
