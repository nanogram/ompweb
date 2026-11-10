import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, createElement, StrictMode } from "react";
import { cleanup, renderHook } from "@testing-library/react/pure.js";
import { useAutoComposer } from "./useAutoComposer.ts";

afterEach(cleanup);
const wrapper = ({ children }) => createElement(StrictMode, null, children);
const view = (initialProps) => renderHook(({ owner, running, waiting = false }) => useAutoComposer(owner, running, waiting), { initialProps, wrapper });

test("running collapses by default, explicit expansion survives updates, and settlement resets the next run", () => {
  const props = { owner: "session-a", running: false };
  const { result, rerender } = view(props);
  assert.equal(result.current.minimized, false);
  rerender({ ...props, running: true });
  assert.equal(result.current.minimized, true);
  act(() => result.current.expand());
  assert.equal(result.current.minimized, false);
  rerender({ ...props, running: true });
  assert.equal(result.current.minimized, false);
  rerender(props);
  assert.equal(result.current.minimized, false);
  rerender({ ...props, running: true });
  assert.equal(result.current.minimized, true);
});

test("a different session never inherits the previous running session's expansion", () => {
  const { result, rerender } = view({ owner: "session-a", running: true });
  act(() => result.current.expand());
  rerender({ owner: "session-b", running: true });
  assert.equal(result.current.minimized, true);
  rerender({ owner: "new-workspace", running: false });
  assert.equal(result.current.minimized, false);
  rerender({ owner: "session-a", running: true });
  assert.equal(result.current.minimized, true);
});

test("questions and approvals remain expanded while native run ownership waits, then resume collapsed", () => {
  const props = { owner: "session-a", running: true };
  const { result, rerender } = view(props);
  assert.equal(result.current.minimized, true);
  rerender({ ...props, waiting: true });
  assert.equal(result.current.minimized, false);
  rerender(props);
  assert.equal(result.current.minimized, true);
  act(() => result.current.expand());
  rerender({ ...props, waiting: true });
  rerender(props);
  assert.equal(result.current.minimized, true);
});
