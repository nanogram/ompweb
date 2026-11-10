import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import React, { act } from "react";
const { render, screen, within, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ChatInput } = await import("./ChatInput.tsx");
const { composerModelPreference } = await import("@/lib/composer-model-preference");
const { clearDraft } = await import("@/lib/draft-store");

const catalog = [
  { provider: "alpha", id: "shared", name: "Research model" },
  { provider: "beta", id: "shared", name: "Custom model" },
  { provider: "beta", id: "plain", name: "Plain model" },
];
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = async () => new Response(JSON.stringify({ composerModelKeys: null }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  await composerModelPreference.refresh();
});
afterEach(() => {
  cleanup();
  clearDraft("combined-model-reasoning");
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = originalFetch;
  delete window.HTMLElement.prototype.scrollIntoView;
});

function mount(overrides = {}) {
  let props = {
    draftKey: "combined-model-reasoning",
    async onSend() { return { status: "accepted" }; },
    isStreaming: false,
    model: { provider: "alpha", modelId: "shared" },
    modelList: catalog,
    thinkingLevel: "high",
    availableThinkingLevels: ["low", "high"],
    onModelChange() {},
    onThinkingLevelChange() {},
    ...overrides,
  };
  const view = render(React.createElement(ChatInput, props));
  return {
    update(next) { props = { ...props, ...next }; view.rerender(React.createElement(ChatInput, props)); },
  };
}
function trigger() {
  return screen.getByRole("button", { name: /Research model/i });
}
function reasoning() { return screen.getByRole("menu", { name: /^(Reasoning|chatInput\.reasoningLabel)$/i }); }
function models() { return screen.getByRole("menu", { name: /^(Models|chatInput\.modelsLabel)$/i }); }
async function open(user) {
  const button = trigger();
  await user.click(button);
  assert.ok(screen.getByRole("dialog"));
  return button;
}
function row(pane, name) { return within(pane).getByRole("menuitemradio", { name }); }

for (const mobile of [false, true]) {
  test(`combined picker exposes current reasoning and both panes ${mobile ? "on mobile" : "on desktop"}`, async () => {
    const original = window.matchMedia;
    window.matchMedia = () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} });
    try {
      const user = userEvent.setup();
      mount();
      await open(user);
      assert.equal(row(reasoning(), /^high$/i).getAttribute("aria-checked"), "true");
      assert.ok(row(models(), /Research model/));
      await user.click(row(reasoning(), /^low$/i));
      assert.equal(screen.queryByRole("dialog"), null);
    } finally { window.matchMedia = original; }
  });
}

test("model choice remains open and authoritative metadata replaces the prior model's reasoning", async () => {
  const user = userEvent.setup();
  const choices = [];
  const view = mount({ onModelChange: (provider, modelId) => choices.push([provider, modelId]) });
  await open(user);
  await user.click(row(models(), /Custom model/));
  assert.deepEqual(choices, [["beta", "shared"]]);
  assert.ok(screen.getByRole("dialog"));
  view.update({ model: { provider: "beta", modelId: "shared" }, thinkingLevel: "ultra", availableThinkingLevels: ["ultra", "constructor"], thinkingLevelMap: { ultra: "Deep research", constructor: "Provider maximum" } });
  assert.equal(within(reasoning()).queryByRole("menuitemradio", { name: /^high$/i }), null);
  assert.equal(row(reasoning(), /Deep research/).getAttribute("aria-checked"), "true");
  const levels = [];
  view.update({ onThinkingLevelChange: (level) => levels.push(level) });
  await user.click(row(reasoning(), /Provider maximum/));
  assert.deepEqual(levels, ["constructor"]);
  assert.equal(screen.queryByRole("dialog"), null);
});

test("a pending native model change blocks both panes until metadata is applied and the promise resolves", async () => {
  const user = userEvent.setup();
  let resolveChange;
  const pending = new Promise((resolve) => { resolveChange = resolve; });
  const changes = [];
  const view = mount({ onModelChange: () => pending, onThinkingLevelChange: (level) => changes.push(level) });
  await open(user);
  await user.click(row(models(), /Plain model/));
  for (const item of screen.getAllByRole("menuitemradio")) assert.equal(item.disabled, true);
  await user.click(row(reasoning(), /^high$/i));
  assert.deepEqual(changes, []);
  view.update({ model: { provider: "beta", modelId: "plain" }, thinkingLevel: "off", availableThinkingLevels: ["off"] });
  await act(async () => { resolveChange(); await pending; });
  await waitFor(() => assert.equal(row(reasoning(), /^off$/i).disabled, false));
  assert.ok(reasoning().contains(document.activeElement), "keyboard selection continues in the selected model's reasoning pane after native acknowledgement");
  assert.equal(within(reasoning()).queryByRole("menuitemradio", { name: /^high$/i }), null);
  assert.equal(within(reasoning()).queryByRole("menuitemradio", { name: /^low$/i }), null);
  await user.click(row(reasoning(), /^auto$/i));
  assert.deepEqual(changes, ["auto"]);
});

for (const fromReasoning of [false, true]) {
  test(`Escape closes without abort and restores trigger focus from ${fromReasoning ? "reasoning" : "models"}`, async () => {
    const user = userEvent.setup();
    let aborted = false;
    mount({ onAbort() { aborted = true; } });
    const button = await open(user);
    if (fromReasoning) row(reasoning(), /^high$/i).focus();
    else assert.equal(document.activeElement, row(models(), /Research model/));
    await user.keyboard("{Escape}");
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(document.activeElement, button);
    assert.equal(aborted, false);
  });
}

test("starting a stream dismisses the picker and prevents model and reasoning mutations", async () => {
  const user = userEvent.setup();
  const mutations = [];
  const view = mount({ onModelChange: (...args) => mutations.push(args), onThinkingLevelChange: (level) => mutations.push(level) });
  const button = await open(user);
  view.update({ isStreaming: true });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await user.click(button);
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(mutations, []);
});

test("reasoning remains reachable without permission to change models", async () => {
  const user = userEvent.setup();
  const chosen = [];
  mount({ onModelChange: undefined, onThinkingLevelChange: (level) => chosen.push(level) });
  await open(user);
  for (const item of within(models()).getAllByRole("menuitemradio")) assert.equal(item.disabled, true);
  await user.click(row(reasoning(), /^low$/i));
  assert.deepEqual(chosen, ["low"]);
});

test("keyboard navigation stays within panes and crosses with arrow keys", async () => {
  const user = userEvent.setup();
  mount();
  await open(user);
  assert.equal(document.activeElement, row(models(), /Research model/));
  await user.keyboard("{End}");
  assert.equal(document.activeElement, within(models()).getAllByRole("menuitemradio").at(-1));
  await user.keyboard("{Home}");
  assert.equal(document.activeElement, within(models()).getAllByRole("menuitemradio")[0]);
  await user.keyboard("{ArrowRight}");
  assert.ok(reasoning().contains(document.activeElement));
  await user.keyboard("{End}");
  assert.equal(document.activeElement, within(reasoning()).getAllByRole("menuitemradio").at(-1));
  await user.keyboard("{ArrowLeft}");
  assert.ok(models().contains(document.activeElement));
});

test("an unmapped provider-defined effort does not inherit an Object prototype alias", async () => {
  const user = userEvent.setup();
  mount({ thinkingLevel: "constructor", availableThinkingLevels: ["off", "constructor"], thinkingLevelMap: {} });
  assert.match(trigger().getAttribute("aria-label"), /constructor/);
  await open(user);
  assert.equal(row(reasoning(), /^constructor$/).getAttribute("aria-checked"), "true");
});

test("a catalog failure preserves live-model reasoning and keyboard access", async () => {
  const user = userEvent.setup();
  const chosen = [];
  mount({ modelList: [], modelNames: {}, modelError: "Catalog unavailable", onThinkingLevelChange: (level) => chosen.push(level) });
  await user.click(screen.getByRole("button", { name: /Change model:/i }));
  assert.equal(row(reasoning(), /^high$/i).getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, row(reasoning(), /^high$/i));
  await user.keyboard("{Home}{ArrowDown}{Enter}");
  assert.deepEqual(chosen, ["low"]);
  assert.equal(screen.queryByRole("dialog"), null);
});
