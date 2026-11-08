import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { RestoreLastChatSetting } = await import("./SettingsConfig.tsx");
const { getRestoreLastChat } = await import("@/lib/workspace-memory");
const { translate } = await import("@/lib/i18n");

test("reopen-last-chat setting defaults off and persists only in this browser", async (t) => {
  window.localStorage.removeItem("omp-web:restore-last-chat");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (...args) => { requests.push(args); return Response.json({}); });
  try {
    const user = userEvent.setup();
    render(React.createElement(RestoreLastChatSetting));
    const control = screen.getByRole("switch", { name: translate("settingsConfig.restoreLastChat") });
    assert.equal(control.getAttribute("aria-checked"), "false");
    await user.click(control);
    assert.equal(getRestoreLastChat(), true);
    cleanup();
    render(React.createElement(RestoreLastChatSetting));
    assert.equal(screen.getByRole("switch", { name: translate("settingsConfig.restoreLastChat") }).getAttribute("aria-checked"), "true");
    await user.click(screen.getByRole("switch", { name: translate("settingsConfig.restoreLastChat") }));
    assert.equal(getRestoreLastChat(), false);
    assert.equal(requests.length, 0);
  } finally {
    cleanup();
    window.localStorage.removeItem("omp-web:restore-last-chat");
  }
});
