import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};

/** Render the real System panel and record its HTTP boundary. */
async function renderSystemTab(t, { appUpdate = null, onRequestAppUpdate = noop }) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url) === "/api/app-channel") {
      const active = { channel: "fork", version: "0.6.0-n1", revision: null };
      return Response.json({ supported: false, active, selected: active, preparing: null, restartRequired: false, restarting: false, error: null, reason: "Use the Node launcher" });
    }
    return Response.json({});
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(SettingsConfig, {
      activeTab: "system",
      toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
      hideToolActivity: false, onHideToolActivityChange: noop,
      expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
      providerUsageVisible: false, onProviderUsageVisibleChange: noop,
      scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
      openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
      cwd: null, remoteHost: false, sessionId: null,
      onModelsSaved: noop, onPluginsReloaded: noop,
      appUpdate, onRefreshAppUpdate: async () => appUpdate,
      onRequestAppUpdate, onSelectTab: noop, onClose: noop,
    }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, requests };
}

const buttonLabels = (container) => [...container.querySelectorAll("button")].map((button) => button.textContent.trim());

test("System keeps web-server updates but never checks or updates the host runtime", async (t) => {
  let requested = false;
  const { container, requests } = await renderSystemTab(t, {
    appUpdate: { currentVersion: "0.6.0-n1", availableVersion: "0.7.0", updateAvailable: true, selfUpdateSupported: true },
    onRequestAppUpdate: () => { requested = true; },
  });
  const updateButton = [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Update and restart");
  assert.ok(updateButton);
  act(() => updateButton.click());
  assert.equal(requested, true);
  assert.ok(!requests.includes("/api/omp-update"), requests.join(", "));
});

test("a binary install's ompweb update links the release page instead of showing a command", async (t) => {
  const releases = "https://github.com/kahme247/ompweb/releases/latest";
  const appUpdate = { currentVersion: "0.6.0-n1", availableVersion: "0.7.0", updateAvailable: true, selfUpdateSupported: false };
  const { container: binary } = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "binary", updateCommand: releases } });
  const link = binary.querySelector(`a[href="${releases}"]`);
  assert.ok(link, "no link to the release page");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /\bnoopener\b/);
  assert.ok(![...binary.querySelectorAll("code")].some((code) => code.textContent === releases), "the release page is shown as a command");

  const { container: npm } = await renderSystemTab(t, { appUpdate: { ...appUpdate, installMethod: "npm", updateCommand: "npm install -g @kahme247/ompweb" } });
  assert.ok([...npm.querySelectorAll("code")].some((code) => code.textContent === "npm install -g @kahme247/ompweb"), "the npm command is gone");
});

test("disabled package updates preserve version visibility without invoking self-update", async (t) => {
  let requested = false;
  const { container } = await renderSystemTab(t, {
    appUpdate: { currentVersion: "0.6.0-n1", availableVersion: null, updateAvailable: false, updatesDisabled: true, selfUpdateSupported: false },
    onRequestAppUpdate: () => { requested = true; },
  });
  assert.ok(container.textContent.includes("0.6.0-n1"));
  assert.ok(!buttonLabels(container).includes("Update and restart"));
  const refresh = container.querySelector('button[aria-label="Check ompweb updates"]');
  assert.equal(refresh?.disabled, true);
  const radios = [...container.querySelectorAll('input[type="radio"]')];
  assert.equal(radios.length, 2);
  assert.ok(radios.every((radio) => radio.closest("fieldset").disabled));
  assert.equal(requested, false);
});
