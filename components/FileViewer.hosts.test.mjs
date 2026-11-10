import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import React from "react";
import test, { afterEach } from "node:test";
// DOM and browser fakes must exist before importing Testing Library and the component.
const { act, render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");
const { FileViewer } = await import("./FileViewer.tsx");
const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.Worker = originalWorker; delete window.matchMedia; });
const workers = [];
class FakeWorker {
  onmessage = null;
  onerror = null;
  posted = [];
  constructor() { workers.push(this); }
  postMessage(message) { this.posted.push(message); }
}
function browser() {
  globalThis.Worker = FakeWorker;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
const props = (hostId) => ({ filePath: "/same/report.txt", cwd: "/same", hostId });

test("a file viewer renders bytes from its owning host", async () => {
  browser();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get("hostId");
    return Response.json({ content: host === "host-a" ? "Alpha document" : "Wrong machine", language: "text", size: 14 });
  };
  const view = render(React.createElement(FileViewer, props("host-a")));
  await waitFor(() => assert.ok(view.container.textContent.includes("Alpha document")));
});

test("an older read cannot replace the same path after its host changes", async () => {
  browser();
  let releaseAlpha;
  let started;
  const alphaStarted = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get("hostId");
    if (host === "host-b") return Response.json({ content: "Beta document", language: "text", size: 13 });
    started();
    return { ok: true, json: () => new Promise((resolve) => { releaseAlpha = () => resolve({ content: "Late alpha", language: "text", size: 10 }); }) };
  };
  const view = render(React.createElement(FileViewer, props("host-a")));
  await alphaStarted;
  view.rerender(React.createElement(FileViewer, props("host-b")));
  await waitFor(() => assert.ok(view.container.textContent.includes("Beta document")));
  releaseAlpha();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(view.container.textContent.includes("Beta document"));
  assert.ok(!view.container.textContent.includes("Late alpha"));
});

for (const ext of ["MP4", "MOV", "webm"]) test(`${ext} opens a scoped streamed video player instead of fetching text`, () => {
  browser();
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return Response.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
  };
  const filePath = `/same/generated.${ext}`;
  const view = render(React.createElement(FileViewer, { filePath, hostId: "host-a", sourceSessionId: "source-session" }));
  const video = view.container.querySelector("video");
  assert.ok(video);
  assert.equal(video.controls, true);
  assert.equal(video.preload, "metadata");
  assert.equal(video.hasAttribute("playsinline"), true);
  assert.equal(view.container.querySelector("audio"), null);
  const read = new URL(video.getAttribute("src"), "http://localhost");
  assert.equal(read.searchParams.get("type"), "read");
  assert.equal(read.searchParams.get("hostId"), "host-a");
  assert.equal(read.searchParams.get("sessionId"), "source-session");
  assert.equal(decodeURIComponent(read.pathname).endsWith(filePath), true);
  const download = new URL(view.getByRole("link", { name: "Download file" }).getAttribute("href"), "http://localhost");
  assert.equal(download.pathname, read.pathname);
  assert.equal(download.searchParams.get("type"), "download");
  assert.equal(download.searchParams.get("hostId"), "host-a");
  assert.equal(download.searchParams.get("sessionId"), "source-session");
  const subscription = workers[0].posted.findLast((message) => message.op === "open");
  assert.deepEqual(subscription.channel, { kind: "file", path: filePath, hostId: "host-a", sessionId: "source-session" });
  assert.deepEqual(fetched, [], "the browser media element, not the bounded JSON text reader, owns loading");
});

test("video decode failure keeps download available and a file change retries the same owning identity", () => {
  browser();
  const filePath = "/same/generated.mp4";
  const viewerProps = { filePath, hostId: "host-a", sourceSessionId: "source-session" };
  const view = render(React.createElement(FileViewer, viewerProps));
  const first = view.container.querySelector("video");
  fireEvent.error(first);
  assert.match(view.getByRole("alert").textContent, /browser|codec/i);
  assert.ok(view.getByRole("link", { name: "Download file" }));
  const subscription = workers[0].posted.findLast((message) => message.op === "open");
  act(() => workers[0].onmessage({ data: { id: subscription.id, type: "message", data: JSON.stringify({ type: "change", size: 512 * 1024 }) } }));
  assert.equal(view.queryByRole("alert"), null);
  assert.ok(view.container.textContent.includes("512.0 KB"));
  const refreshed = view.container.querySelector("video");
  assert.notEqual(refreshed, first);
  const url = new URL(refreshed.getAttribute("src"), "http://localhost");
  assert.equal(url.searchParams.get("v"), "1");
  assert.equal(url.searchParams.get("hostId"), "host-a");
  assert.equal(url.searchParams.get("sessionId"), "source-session");
  view.rerender(React.createElement(FileViewer, { ...viewerProps, active: false }));
  assert.ok(workers[0].posted.some((message) => message.op === "close" && message.id === subscription.id));
});

test("non-video media and documents retain their existing renderer and URL modes", () => {
  browser();
  for (const [name, selector, type] of [
    ["photo.png", "img", "read"],
    ["audio.mp3", "audio", "read"],
    ["audio.weba", "audio", "read"],
    ["report.pdf", "iframe", "read"],
    ["report.docx", "iframe", "preview"],
  ]) {
    const view = render(React.createElement(FileViewer, { filePath: `/same/${name}`, hostId: "host-a", sourceSessionId: "source-session", active: false }));
    const element = view.container.querySelector(selector);
    assert.ok(element, name);
    assert.equal(view.container.querySelector("video"), null, name);
    const url = new URL(element.getAttribute("src"), "http://localhost");
    assert.equal(url.searchParams.get("type"), type, name);
    assert.equal(url.searchParams.get("hostId"), "host-a", name);
    assert.equal(url.searchParams.get("sessionId"), "source-session", name);
    view.unmount();
  }
});
