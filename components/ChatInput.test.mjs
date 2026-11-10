import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { ChatInput, ModelErrorBanner } = await import("./ChatInput.tsx");
const { setDraft, clearDraft } = await import("@/lib/draft-store");


test("shows Queue instead of Stop for typed text during a run", () => {
  const draftKey = "chat-input-queue-action-test";
  setDraft(draftKey, { value: "Continue after the current run", images: [], files: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        async onSend() { return { status: "accepted" }; },
        onAbort() {},
        onFollowUp() {},
        isStreaming: true,
        draftKey,
      }),
    );

    assert.match(html, />(Queue|chatInput\.queue)</);
    assert.match(html, /title="(Queue this message after the agent finishes|chatInput\.queueMessage)"/);
    assert.doesNotMatch(html, />(Stop|chatInput\.stop)</);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("formats structured Claude low-priority state in the browser locale", () => {
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3_600;
  const time = new Date(resetsAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      isStreaming: false,
      usageLimit: { stage: "low_priority", resetsAtSec, allowanceLeftPercent: 62 },
    }),
  );
  assert.match(html, new RegExp(`low priority until ${time.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} · 62% left`));
});

test("formats every Claude usage-limit stage", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const shortReset = nowSec + 3_600;
  const longReset = nowSec + 86_400;
  const shortTime = new Date(shortReset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const longTime = new Date(longReset * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const rows = [
    [{ stage: "low_priority", resetsAtSec: shortReset }, `low priority until ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: false }, "limit reached · wrapping up"],
    [{ stage: "wrap_up", resetsAtSec: shortReset, extraUsage: false }, `limit reached · wrapping up · resets ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: true }, "limit reached · wrap-up, then extra usage"],
    [{ stage: "low_priority", resetsAtSec: longReset }, `low priority until ${longTime}`],
  ];
  for (const [usageLimit, label] of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { async onSend() { return { status: "accepted" }; }, isStreaming: false, usageLimit }),
    );
    assert.ok(html.includes(label), `${JSON.stringify(usageLimit)} should render ${label}`);
  }
});

test("never renders a null percentage, an invalid date, or a past reset clock", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const pastSec = nowSec - 3_600;
  const rows = [
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: null },
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: Number.NaN },
    { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: undefined, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: null },
    { stage: "low_priority", resetsAtSec: pastSec, allowanceLeftPercent: 62 },
    { stage: "wrap_up", resetsAtSec: null, extraUsage: false },
    { stage: "wrap_up", resetsAtSec: pastSec, extraUsage: false },
  ];
  for (const usageLimit of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { async onSend() { return { status: "accepted" }; }, isStreaming: false, usageLimit }),
    );
    const label = `${JSON.stringify(usageLimit)} -> ${html}`;
    // "null" / "NaN" / "Invalid Date" reaching the label is the bug this pins:
    // every one of them is a value the user would plan their session around.
    assert.ok(!html.includes("Invalid Date"), `invalid date rendered: ${label}`);
    assert.ok(!html.includes("null%"), `null percentage rendered: ${label}`);
    assert.ok(!html.includes("NaN%"), `NaN percentage rendered: ${label}`);
    // A reset already in the past must not render a plausible wrong clock.
    if (usageLimit.resetsAtSec === pastSec) {
      assert.ok(!html.includes(new Date(pastSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        `past reset clock rendered: ${label}`);
    }
  }
  // The allowance is still worth showing when the reset time is unusable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        async onSend() { return { status: "accepted" }; },
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
      }),
    ),
    /low priority · 62% left/,
  );
  // ...and something is still shown when neither is usable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        async onSend() { return { status: "accepted" }; },
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null },
      }),
    ),
    /class="composer-usage-limit-badge"[^>]*>low priority</,
  );
});




test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      goalState: {
        enabled: true,
        mode: "active",
        goal: {
          id: "goal-1",
          objective: "Ship the active goal bar",
          status: "active",
          tokensUsed: 42,
          timeUsedSeconds: 60,
          createdAt: 0,
          updatedAt: 0,
        },
      },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
      onAdvisorChange() {},
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  // The advisor toggle moved into the plus menu: no pressed toggle inline,
  // but the plus trigger renders for the same props.
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("shows the advisor thunder indicator with the reviewing model and reasoning", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: true,
      advisorActive: true,
      advisorModel: { name: "GPT-5.6 Luna", reasoning: "xhigh" },
    }),
  );

  assert.match(html, /aria-label="[^"]*GPT-5\.6 Luna[^"]*xhigh[^"]*"/);
});

test("renders single queued prompt in compact bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First follow-up task"],
        steering: [],
      },
    }),
  );

  assert.match(html, /First follow-up task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.match(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("keeps editing and deletion but hides Steer for a single queued steer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      onPromoteQueuedToSteer() {},
      isStreaming: true,
      queuedMessages: {
        followUp: [],
        steering: ["Already prioritized task"],
      },
    }),
  );

  assert.match(html, /Already prioritized task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.doesNotMatch(html, />(Steer|chatInput\.queuedSteerAction)</);
});





test("exposes tool presets through the plus menu when a handler is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: false,
      toolPreset: "full",
      onToolPresetChange() {},
    }),
  );

  // No inline preset trigger remains; the plus trigger carries the menu.
  assert.doesNotMatch(html, /aria-label="Change tool preset: full"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
  assert.match(html, /aria-haspopup="menu"/);
});

test("plus trigger renders without change handlers", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: false,
    }),
  );

  assert.doesNotMatch(html, /Change tool preset/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("renders live status bar attached to the composer top edge when statusText is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});

test("omits live status bar when statusText is absent or null", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: false,
      statusText: null,
    }),
  );

  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(html, /Waiting for model/);
});

test("renders both queued prompts and attached status bar together", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
      queuedMessages: {
        steer: [],
        followUp: ["Next prompt to run"],
      },
    }),
  );

  assert.match(html, /Next prompt to run/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});

test("renders retry banner with countdown when delayMs and startedAt are provided", () => {
  const now = Date.now();
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      async onSend() { return { status: "accepted" }; },
      retryInfo: {
        attempt: 2,
        maxAttempts: 5,
        delayMs: 10000,
        startedAt: now,
      },
    }),
  );

  assert.match(html, /Retrying \(2\/5\) in 10s…/);
});
