import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen, within } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { OmpWebTitle } = await import("./SessionSidebar-chrome.tsx");
const { translate } = await import("@/lib/i18n");
afterEach(cleanup);

for (const withCommit of [false, true]) {
  test(`version popup opens ${withCommit ? "with" : "without"} Git metadata`, async (t) => {
    const values = {
      OMP_WEB_PUBLIC_APP_VERSION: "1.2.3-example.1",
      OMP_WEB_PUBLIC_COMMIT_HASH: withCommit ? "0123456789abcdef0123456789abcdef01234567" : undefined,
      OMP_WEB_PUBLIC_COMMIT_DATE: withCommit ? "2026-01-02" : undefined,
    };
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const restore = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    t.after(restore);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    render(React.createElement(OmpWebTitle));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: translate("sessionSidebar.showAppVersion") }));
    const popup = await screen.findByRole("dialog");
    assert.ok(within(popup).getByText(`v${values.OMP_WEB_PUBLIC_APP_VERSION}`));
    if (withCommit) {
      assert.ok(within(popup).getByText(values.OMP_WEB_PUBLIC_COMMIT_HASH));
      assert.ok(within(popup).getByText(values.OMP_WEB_PUBLIC_COMMIT_DATE));
    }
    await user.click(screen.getByRole("button", { name: translate("sessionSidebar.showAppName") }));
    assert.equal(screen.queryByRole("dialog"), null);
  });
}
