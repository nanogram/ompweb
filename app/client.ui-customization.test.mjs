import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

test("the flag-zero browser entry starts no customization status polling", async (t) => {
  const previousFlag = process.env.OMP_WEB_PUBLIC_UI_CUSTOMIZATION;
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const nativeCssReplace = window.CSSStyleSheet.prototype.replace;
  const requests = [];
  process.env.OMP_WEB_PUBLIC_UI_CUSTOMIZATION = "0";
  window.history.replaceState(null, "", "/login");
  Object.defineProperty(globalThis, "location", { configurable: true, value: window.location });
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({}); };
  document.body.innerHTML = '<div id="root"></div>';
  t.after(() => {
    if (previousFlag === undefined) delete process.env.OMP_WEB_PUBLIC_UI_CUSTOMIZATION;
    else process.env.OMP_WEB_PUBLIC_UI_CUSTOMIZATION = previousFlag;
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = "";
  });
  await act(async () => { await import("./client.tsx"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => { await Promise.resolve(); });
  assert.ok(document.querySelector("#web-password"), "the real browser entry rendered");
  assert.equal(document.querySelector('[data-search-id="ui-customization"]'), null);
  assert.equal(requests.filter((url) => url === "/ui-customization.json").length, 0);
  assert.equal(window.CSSStyleSheet.prototype.replace, nativeCssReplace, "production must not patch stylesheet APIs");
});
