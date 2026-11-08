import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");
const { translate } = await import("../lib/i18n");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const props = {
  activeTab: "system",
  toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false, onHideToolActivityChange: noop,
  neverFoldActivity: false, onNeverFoldActivityChange: noop,
  showToolCallsUnfolded: false, onShowToolCallsUnfoldedChange: noop,
  expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop,
  providerUsageVisible: false, onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
  cwd: null, remoteHost: false, sessionId: null,
  onModelsSaved: noop, onPluginsReloaded: noop,
  appUpdate: null, onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
};

for (const [field, label] of [
  ["autoResumeSessions", "settingsConfig.autoResumeSessions"],
  ["agentToolsEnabled", "settingsConfig.agentTools"],
]) {
  test(`${field} cannot start an overlapping save and recovers after a rejected save`, async (t) => {
    const previousFetch = globalThis.fetch;
    const stored = { autoResumeSessions: false, agentToolsEnabled: false, uploadRetentionDays: 30 };
    const pending = [];
    globalThis.fetch = async (url, init) => {
      if (String(url) !== "/api/web-settings") return Response.json({}, { status: 404 });
      if (init?.method !== "PUT") return Response.json(stored);
      const change = JSON.parse(init.body);
      return new Promise((resolve) => pending.push((status) => {
        if (status < 400) Object.assign(stored, change);
        resolve(Response.json({}, { status }));
      }));
    };
    t.after(() => {
      for (const finish of pending.splice(0)) finish(500);
      cleanup();
      globalThis.fetch = previousFetch;
    });
    const { container } = render(createElement(SettingsConfig, props));
    await settle();
    const control = within(container).getByRole("switch", { name: translate(label) });
    fireEvent.click(control);
    await settle();
    assert.equal(control.disabled, true);
    assert.equal(control.getAttribute("aria-checked"), "true");
    fireEvent.click(control);
    await settle();
    assert.equal(pending.length, 1, "a disabled setting must not create competing persisted writes");
    await act(async () => pending.shift()(500));
    await settle();
    assert.equal(control.disabled, false);
    assert.equal(control.getAttribute("aria-checked"), "false", "rejection restores the last confirmed value");
    assert.equal(stored[field], false);

    fireEvent.click(control);
    await settle();
    await act(async () => pending.shift()(200));
    await settle();
    assert.equal(control.disabled, false);
    assert.equal(control.getAttribute("aria-checked"), "true");
    assert.equal(stored[field], true, "the next user change can persist after the rejected save");
  });
}
