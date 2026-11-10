import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { act, cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput.tsx");
const { SlowModeControlSetting } = await import("./SettingsConfig.tsx");
const { setSlowModeControlVisible } = await import("@/lib/composer-prefs");
const enModule = await import("@/lib/i18n/locales/en.json");
const en = enModule.default ?? enModule;

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  setSlowModeControlVisible(true);
});
afterEach(() => {
  cleanup();
  setSlowModeControlVisible(false);
  localStorage.clear();
  delete window.matchMedia;
});

function renderSlow(props) {
  const changes = [];
  render(React.createElement(ChatInput, {
    async onSend() { return { status: "accepted" }; },
    onAbort() {},
    isStreaming: false,
    slowModeSupported: true,
    slowModeScope: "session",
    onSlowModeChange: (enabled) => { changes.push(enabled); },
    ...props,
  }));
  return { changes, button: screen.getByRole("button", { name: en["chatInput.slowLabel"] }) };
}

for (const enabled of [true, false]) {
  test(`clicking the ${enabled ? "pressed" : "unpressed"} Slow toggle asks for ${!enabled}`, async () => {
    const user = userEvent.setup();
    const { changes, button } = renderSlow({ slowModeEnabled: enabled });
    assert.equal(button.getAttribute("aria-pressed"), String(enabled));
    await user.click(button);
    assert.deepEqual(changes, [!enabled]);
  });
}

test("the Slow toggle is disabled and inert while a run streams", async () => {
  const user = userEvent.setup();
  const { changes, button } = renderSlow({ slowModeEnabled: false, isStreaming: true });
  assert.equal(button.disabled, true);
  await user.click(button);
  assert.deepEqual(changes, []);
});

test("the Slow tooltip states the scope omp reports", () => {
  const titles = {};
  for (const scope of ["global", "session", undefined]) {
    const { button } = renderSlow({ slowModeScope: scope });
    titles[String(scope)] = button.getAttribute("title");
    cleanup();
  }
  assert.equal(titles.global, en["chatInput.slowTitleGlobal"]);
  assert.equal(titles.session, en["chatInput.slowTitleSession"]);
  assert.notEqual(titles.global, titles.session);
  // A supported model without a reported scope never claims a shared setting.
  assert.equal(titles.undefined, en["chatInput.slowTitleSession"]);
});

test("the visibility setting starts hidden, persists across remounts, and never changes native slow mode", async () => {
  setSlowModeControlVisible(false);
  window.localStorage.removeItem("omp-web:slow-mode-control-visible");
  const user = userEvent.setup();
  const nativeChanges = [];
  const props = {
    async onSend() { return { status: "accepted" }; }, onAbort() {}, isStreaming: false,
    slowModeSupported: true, slowModeEnabled: true, slowModeScope: "global",
    onSlowModeChange: (value) => nativeChanges.push(value),
  };
  const mount = () => render(React.createElement(React.Fragment, null,
    React.createElement(SlowModeControlSetting), React.createElement(ChatInput, props)));
  const visibility = () => screen.getByRole("switch", { name: en["settingsConfig.slowModeControl"] });
  const snail = () => screen.queryByRole("button", { name: en["chatInput.slowLabel"] });
  mount();
  assert.equal(visibility().getAttribute("aria-checked"), "false");
  assert.equal(snail(), null, "a supported, enabled native mode does not override hidden UI");
  await user.click(visibility());
  assert.equal(snail().getAttribute("aria-pressed"), "true");
  cleanup();
  mount();
  assert.equal(visibility().getAttribute("aria-checked"), "true");
  assert.equal(snail().getAttribute("aria-pressed"), "true", "remount restores visibility without changing native state");
  await user.click(visibility());
  assert.equal(snail(), null);
  await user.click(visibility());
  act(() => {
    window.localStorage.setItem("omp-web:slow-mode-control-visible", "off");
    window.dispatchEvent(new window.StorageEvent("storage", { key: "omp-web:slow-mode-control-visible", newValue: "off" }));
  });
  assert.equal(visibility().getAttribute("aria-checked"), "false");
  assert.equal(snail(), null, "another tab's choice also updates mounted readers");
  assert.deepEqual(nativeChanges, [], "visibility is not a native /slow mutation");
});

test("showing the control never bypasses native model capability detection", () => {
  const props = {
    async onSend() { return { status: "accepted" }; }, isStreaming: false,
    slowModeEnabled: true, onSlowModeChange() {},
  };
  const view = render(React.createElement(ChatInput, { ...props, slowModeSupported: false }));
  assert.equal(screen.queryByRole("button", { name: en["chatInput.slowLabel"] }), null);
  view.rerender(React.createElement(ChatInput, { ...props, slowModeSupported: true }));
  assert.equal(screen.getByRole("button", { name: en["chatInput.slowLabel"] }).getAttribute("aria-pressed"), "true");
});
