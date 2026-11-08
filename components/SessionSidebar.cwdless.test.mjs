import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, within, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
afterEach(cleanup);

test("cwd-less sessions are clickable but never become launchable workspace options", async (t) => {
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url) === "/api/sessions") return Response.json({ sessions: [{ id: "no-cwd", path: "/fixture/session.jsonl", cwd: "", projectRoot: "", projectKey: "", name: "Orphaned chat", firstMessage: "Inspect this transcript", messageCount: 1, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z" }] });
    if (String(url) === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  });
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  t.after(() => {
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  });
  const opened = [];
  const options = [];
  const selections = [];
  render(createElement(SessionSidebar, {
    selectedSessionId: null, selectedCwd: "/previous", skipInitialProjectSelection: true,
    onSelectSession: session => opened.push(session.id),
    onCwdChange: cwd => selections.push(cwd),
    onWorkspaceOptionsChange: projects => options.push(projects),
    addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
  }));
  const unknown = await screen.findByRole("region", { name: "Unknown workspace" });
  await userEvent.setup().click(within(unknown).getByText("Orphaned chat"));
  assert.deepEqual(opened, ["no-cwd"]);
  await waitFor(() => assert.equal(selections.at(-1), null));
  assert.equal(options.some(projects => projects.some(project => project.path === "")), false);
  assert.equal(within(unknown).queryByRole("button", { name: /launch configuration/i }), null);
});
