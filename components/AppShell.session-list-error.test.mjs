import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { SessionListLoadError } = await import("./AppShell-layout.tsx");
const { translate } = await import("@/lib/i18n");

test("mobile shell load failures remain actionable while the drawer is hidden and disappear after recovery", async () => {
  let retries = 0;
  const props = { error: "fixture host temporarily unavailable", visible: true, onRetry: () => retries++ };
  try {
    const view = render(React.createElement(SessionListLoadError, props));
    assert.match(screen.getByRole("alert").textContent, /fixture host temporarily unavailable/);
    await userEvent.setup().click(screen.getByRole("button", { name: translate("sessionSidebar.refresh") }));
    assert.equal(retries, 1);
    view.rerender(React.createElement(SessionListLoadError, { ...props, error: null }));
    assert.equal(screen.queryByRole("alert"), null);
    view.rerender(React.createElement(SessionListLoadError, { ...props, visible: false }));
    assert.equal(screen.queryByRole("alert"), null);
  } finally { cleanup(); }
});
