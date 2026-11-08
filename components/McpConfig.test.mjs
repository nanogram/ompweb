import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { McpConfig } = await import("./McpConfig.tsx");
afterEach(cleanup);

test("MCP switches persist the named action and reload without sending a model prompt", async (t) => {
  let disabled = true;
  const actions = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method === "PATCH") {
      const action = JSON.parse(options.body);
      actions.push(action);
      if (action.action === "enable") disabled = false;
      return Response.json({ success: true });
    }
    const inventory = [{ name: "demo", source: "User level", sourcePath: "/fixture/mcp.json", status: disabled ? "disabled" : "configured", type: "stdio" }];
    return Response.json({ servers: [], inventory, liveServers: inventory });
  });
  render(createElement(McpConfig, { cwd: null, sessionId: "fixture-session" }));
  const toggle = await screen.findByRole("switch", { name: "Enable demo" });
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await userEvent.setup().click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "true"));
  assert.deepEqual(actions[0], { sessionId: "fixture-session", action: "enable", name: "demo" });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, false));
  await userEvent.setup().click(screen.getByRole("button", { name: "Reload MCP" }));
  await waitFor(() => assert.equal(actions.length, 2));
  assert.deepEqual(actions[1], { sessionId: "fixture-session", action: "reload" });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, false));
});

test("MCP management cannot mutate configuration without a selected session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ inventory: [{ name: "demo", source: "User level", status: "configured" }] }));
  render(createElement(McpConfig, { cwd: null }));
  assert.equal((await screen.findByRole("switch", { name: "Enable demo" })).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Reload MCP" }).disabled, true);
});

test("an externally removed selection clears the editor, but refreshing an add draft keeps it", async (t) => {
  let servers = [{ name: "alpha", config: { type: "stdio", command: "alpha-cmd", args: [] } }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ servers, path: "/fixture/.omp/mcp.json" }));
  render(createElement(McpConfig, { cwd: "/fixture" }));
  const user = userEvent.setup();
  await user.click(await screen.findByText("alpha"));
  assert.equal(screen.getByDisplayValue("alpha").tagName, "INPUT");
  servers = [];
  await user.click(screen.getByRole("button", { name: "Refresh live MCP status" }));
  await waitFor(() => assert.equal(document.querySelector("input.mcp-config-input").value, ""));
  assert.equal(document.querySelector("textarea.mcp-config-input").value.includes("alpha-cmd"), false);
  await user.type(document.querySelector("input.mcp-config-input"), "draft");
  await user.click(screen.getByRole("button", { name: "Refresh live MCP status" }));
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Refresh live MCP status" }).disabled, false));
  assert.equal(document.querySelector("input.mcp-config-input").value, "draft");
});

test("the keyed workspace lifetime discards the old workspace's editor", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const cwd = new URL(String(url), "http://fixture").searchParams.get("cwd");
    const name = cwd === "/a" ? "alpha" : "beta";
    return Response.json({ servers: [{ name, config: { type: "stdio", command: `${name}-cmd` } }] });
  });
  const view = render(createElement(McpConfig, { key: "/a", cwd: "/a" }));
  await userEvent.setup().click(await screen.findByText("alpha"));
  view.rerender(createElement(McpConfig, { key: "/b", cwd: "/b" }));
  await screen.findByText("beta");
  assert.equal(document.querySelector("input.mcp-config-input").value, "");
  assert.equal(document.querySelector("textarea.mcp-config-input").value.includes("alpha-cmd"), false);
});
