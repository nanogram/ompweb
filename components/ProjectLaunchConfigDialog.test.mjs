import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ProjectLaunchConfigDialog } = await import("./ProjectLaunchConfigDialog.tsx");
afterEach(cleanup);

test("a stored invalid profile remains visible and cannot silently save as the default", async () => {
  const saved = [];
  render(createElement(ProjectLaunchConfigDialog, { projectPath: "/fixture", initialConfig: { profile: "bad profile", extraArgs: ["--verbose"] }, onClose() {}, onSave: async config => saved.push(config) }));
  const profile = screen.getByDisplayValue("bad profile");
  const save = screen.getByRole("button", { name: "Save configuration" });
  assert.equal(profile.getAttribute("aria-invalid"), "true");
  assert.equal(save.disabled, true);
  const user = userEvent.setup();
  await user.click(save);
  assert.deepEqual(saved, []);
  await user.clear(profile);
  await user.type(profile, "work");
  assert.equal(save.disabled, false);
  await user.click(save);
  assert.deepEqual(saved, [{ profile: "work", advisor: undefined, extraArgs: ["--verbose"] }]);
});
