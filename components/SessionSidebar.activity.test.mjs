import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { SessionItem, SessionTreeItem, ProjectRow } = await import("./SessionSidebar-rows.tsx");
const { projectActivityCounts } = await import("../lib/project-ordering.ts");
const { translate } = await import("@/lib/i18n");
const completedLabel = () => translate("sessionSidebar.activity.completed");
afterEach(cleanup);
const session = { id: "outcome", path: "/fixture/chat.jsonl", cwd: "/repo", name: "Outcome chat", firstMessage: "test", messageCount: 1, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", activityStatus: "completed" };
const activity = (status, updatedAt = 1) => ({ id: session.id, cwd: session.cwd, status, updatedAt });
const noop = () => {};

test("rows distinguish viewed success, persistent question/error, live idle and disk fallback", () => {
  const props = { session, isSelected: false, isUnread: true, onClick: noop, relativeTimeNow: Date.now() };
  const view = render(React.createElement(SessionItem, props));
  assert.ok(screen.getByLabelText(completedLabel()));
  view.rerender(React.createElement(SessionItem, { ...props, isSelected: true }));
  assert.equal(screen.queryByLabelText(completedLabel()), null);
  view.rerender(React.createElement(SessionItem, { ...props, activity: { ...activity("waiting_input"), detail: "Choose a branch" }, isRunning: true, isSelected: true }));
  const question = screen.getByRole("img", { name: `${translate("sessionSidebar.activity.waiting_input")}: Choose a branch` });
  assert.equal(question.getAttribute("title"), `${translate("sessionSidebar.activity.waiting_input")}: Choose a branch`);
  assert.equal(screen.queryByLabelText(translate("sessionSidebar.agentRunningAria")), null);
  assert.equal(screen.queryByLabelText(completedLabel()), null);
  view.rerender(React.createElement(SessionItem, { ...props, activity: { ...activity("quota"), detail: "Rate limit" }, isSelected: true }));
  const quota = screen.getByRole("img", { name: `${translate("sessionSidebar.activity.quota")}: Rate limit` });
  assert.equal(quota.getAttribute("title"), `${translate("sessionSidebar.activity.quota")}: Rate limit`);
  for (const status of ["idle", "interrupted"]) {
    view.rerender(React.createElement(SessionItem, { ...props, activity: activity(status) }));
    assert.equal(screen.queryByLabelText(completedLabel()), null);
  }
});

test("a fork child follows activity and viewed transitions when its unchanged root is memoized", () => {
  const child = { session, children: [] };
  const node = { session: { ...session, id: "parent", name: "Parent", activityStatus: "idle" }, children: [child] };
  const props = { node, selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set([session.id]), exitedSessions: new Map(), sessionActivities: new Map(), relativeTimeNow: Date.now(), onSelectSession: noop, depth: 0 };
  const view = render(React.createElement(SessionTreeItem, props));
  assert.ok(screen.getByLabelText(completedLabel()));
  view.rerender(React.createElement(SessionTreeItem, { ...props, selectedSessionId: session.id }));
  assert.equal(screen.queryByLabelText(completedLabel()), null);
  view.rerender(React.createElement(SessionTreeItem, { ...props, sessionActivities: new Map([[session.id, activity("error")]]) }));
  assert.ok(screen.getByLabelText(translate("sessionSidebar.activity.error")));
});

test("folder trailing outcomes use error over question over unread success, never operational running", () => {
  const sessions = [session, { ...session, id: "question" }, { ...session, id: "failure" }];
  const props = { project: { path: "/repo" }, isActive: false, isExpanded: false, tree: [], hiddenCount: 0, selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), sessionActivities: new Map(), exitedSessions: new Map(), relativeTimeNow: Date.now(), onActivate: noop, onToggleExpand: noop, onRemoveProject: noop, onEditLaunchConfig: noop, onUpdatePresentation: noop, onDragProjectChange: noop, onDropProject: noop, onMoveProject: noop, pinnable: false, onTogglePin: noop, isDragTarget: false, removeBusy: false, onSelectSession: noop };
  const counts = (activities, unread = [session.id]) => projectActivityCounts(sessions, [], unread, [], new Map(activities)).get("/repo");
  const view = render(React.createElement(ProjectRow, { ...props, activity: counts([]) }));
  assert.ok(screen.getByRole("status", { name: completedLabel() }));
  view.rerender(React.createElement(ProjectRow, { ...props, activity: counts([["question", { ...activity("waiting_input"), id: "question" }]]) }));
  assert.ok(screen.getByRole("status", { name: translate("sessionSidebar.activity.waiting_input") }));
  view.rerender(React.createElement(ProjectRow, { ...props, activity: counts([["question", { ...activity("waiting_input"), id: "question" }], ["failure", { ...activity("error"), id: "failure" }]]) }));
  assert.ok(screen.getByRole("status", { name: translate("sessionSidebar.activity.error") }));
  view.rerender(React.createElement(ProjectRow, { ...props, activity: projectActivityCounts(sessions, sessions.map(s => s.id), []).get("/repo") }));
  assert.equal(screen.queryByRole("status"), null);
});

test("the mounted sidebar clears viewed completion until another unseen run completes", async (t) => {
  let current = activity("running", 1);
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  t.after(() => { globalThis.Worker = previousWorker; });
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url) === "/api/sessions") return Response.json({ sessions: [session], sessionActivities: [current], runningSessionIds: current.status === "running" ? [session.id] : [] });
    if (String(url) === "/api/projects") return Response.json({ projects: [{ path: "/repo" }] });
    return Response.json({});
  });
  const props = { selectedSessionId: null, selectedCwd: "/repo", onSelectSession: noop, addProjectOpen: false, setAddProjectOpen: noop, usageVisible: false };
  const view = render(React.createElement(SessionSidebar, { ...props, refreshKey: 0 }));
  await screen.findByText("Outcome chat");
  current = activity("completed", 2);
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 1 }));
  await waitFor(() => assert.ok(screen.getAllByLabelText(completedLabel()).length));
  view.rerender(React.createElement(SessionSidebar, { ...props, selectedSessionId: session.id, refreshKey: 1 }));
  await waitFor(() => assert.equal(screen.queryByLabelText(completedLabel()), null));
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 2 }));
  await waitFor(() => assert.equal(screen.queryByLabelText(completedLabel()), null));
  current = activity("running", 3);
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 3 }));
  await screen.findByLabelText(translate("sessionSidebar.agentRunningAria"));
  current = activity("completed", 4);
  view.rerender(React.createElement(SessionSidebar, { ...props, refreshKey: 4 }));
  await waitFor(() => assert.ok(screen.getAllByLabelText(completedLabel()).length));
});
