import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");
const minimap = await import("./useChatMinimapPreference.ts");
const transcript = await import("./useTranscriptPreference.ts");
afterEach(() => { cleanup(); window.localStorage.clear(); });

test("outline and transcript preferences preserve the existing desktop/mobile presentation by default", () => {
  window.localStorage.setItem(minimap.STORAGE_KEY_DESKTOP, "invalid");
  window.localStorage.setItem(transcript.TRANSCRIPT_PRESENTATION_KEY, "invalid");
  assert.deepEqual(minimap.storedChatMinimapPreference(), { desktopMode: "rail", mobileFab: false });
  assert.deepEqual(transcript.storedTranscriptPreference(), { presentation: "classic", expandProcessDetails: false });
});

test("settings controls update every mounted transcript immediately and react to other-tab changes", () => {
  const first = renderHook(() => [minimap.useChatMinimapPreference(), transcript.useTranscriptPreference()]);
  const second = renderHook(() => [minimap.useChatMinimapPreference(), transcript.useTranscriptPreference()]);
  act(() => {
    first.result.current[0].setDesktopMode("fab");
    first.result.current[0].setMobileFab(true);
    first.result.current[1].setPresentation("focused");
    first.result.current[1].setExpandProcessDetails(true);
  });
  assert.equal(second.result.current[0].desktopMode, "fab");
  assert.equal(second.result.current[0].mobileFab, true);
  assert.equal(second.result.current[1].presentation, "focused");
  assert.equal(second.result.current[1].expandProcessDetails, true);
  act(() => {
    window.localStorage.clear();
    window.dispatchEvent(new window.StorageEvent("storage", { key: null }));
  });
  assert.equal(second.result.current[0].desktopMode, "rail");
  assert.equal(second.result.current[1].presentation, "classic");
  assert.equal(second.result.current[1].expandProcessDetails, false);
});

test("storage-denied preference changes remain usable and persist together when storage recovers", () => {
  const hook = renderHook(() => [minimap.useChatMinimapPreference(), transcript.useTranscriptPreference()]);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const original = prototype.setItem;
  prototype.setItem = () => { throw new Error("Storage denied"); };
  try {
    act(() => {
      hook.result.current[0].setDesktopMode("off");
      hook.result.current[1].setPresentation("focused");
    });
    assert.equal(hook.result.current[0].desktopMode, "off");
    assert.equal(hook.result.current[1].presentation, "focused");
  } finally { prototype.setItem = original; }
  act(() => {
    hook.result.current[0].setMobileFab(true);
    hook.result.current[1].setExpandProcessDetails(true);
  });
  assert.equal(window.localStorage.getItem(minimap.STORAGE_KEY_DESKTOP), "off");
  assert.equal(window.localStorage.getItem(transcript.TRANSCRIPT_PRESENTATION_KEY), "focused");
});
