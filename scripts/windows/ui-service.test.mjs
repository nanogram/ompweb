import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const { buildUiConfig, routeFromStatus, otherRoutes } = createRequire(import.meta.url)("./ui-service.cjs");
const sourceRoot = path.resolve("source checkout");
const publicUrl = "https://desktop.example.ts.net:8445";

function serveConfig() {
  return {
    TCP: { "8445": { HTTPS: true }, "8446": { HTTPS: true }, "22": { TCPForward: "127.0.0.1:22" } },
    Web: {
      "desktop.example.ts.net:8445": { Handlers: { "/": { Proxy: "http://127.0.0.1:30177" }, "/other/": { Proxy: "http://127.0.0.1:3000" } } },
      "desktop.example.ts.net:8446": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } },
    },
    AllowFunnel: { "desktop.example.ts.net:8445": false },
  };
}

test("UI promotion preserves primary bind, autostart and unrelated configuration without mutating the original", () => {
  const previous = { port: 30178, hostname: "localhost", mode: "start", autostart: false, autoRestart: true, openBrowserOnLaunch: true, custom: { retained: "private setting" } };
  const copy = structuredClone(previous);
  const config = buildUiConfig(previous, { sourceRoot, publicUrl });
  assert.deepEqual(previous, copy);
  assert.deepEqual(config, { ...previous, mode: "ui", uiSource: sourceRoot, uiPublicUrl: publicUrl, uiProxyPort: 30179 });
});

test("saved UI ingress settings survive a later deploy without overrides", () => {
  const saved = { port: 65535, hostname: "127.0.0.1", uiSource: sourceRoot, uiPublicUrl: publicUrl + "/", uiProxyPort: 31000 };
  const next = buildUiConfig(saved, { sourceRoot });
  assert.equal(next.uiProxyPort, 31000);
  assert.equal(next.uiPublicUrl, publicUrl);
  assert.equal(buildUiConfig({ port: 65535 }, { sourceRoot, publicUrl }).uiProxyPort, 65534);
});

test("promotion refuses broad binds, invalid ingress and public origin credentials or paths", () => {
  for (const hostname of ["0.0.0.0", "::", "192.168.1.2"]) assert.throws(() => buildUiConfig({ hostname }, { sourceRoot }), /loopback/);
  for (const port of [0, 65536, "30177", 30177.5]) assert.throws(() => buildUiConfig({ port }, { sourceRoot }), /integer/);
  for (const url of ["http://desktop.example.ts.net", "https://user:password@desktop.example.ts.net", publicUrl + "/subpath", publicUrl + "?token=private", publicUrl + "#fragment"]) {
    assert.throws(() => buildUiConfig({}, { sourceRoot, publicUrl: url }), /HTTPS origin/);
  }
  assert.throws(() => buildUiConfig({ port: 30177 }, { sourceRoot, publicUrl, proxyPort: 30177 }), /differ/);
  assert.throws(() => buildUiConfig({}, { sourceRoot, proxyPort: 30179 }), /requires/);
});

test("Tailscale snapshot selects only the explicitly configured HTTPS root proxy", () => {
  const config = serveConfig();
  const before = structuredClone(config);
  assert.deepEqual(routeFromStatus(config, publicUrl), { publicUrl, endpoint: "desktop.example.ts.net:8445", port: 8445, target: "http://127.0.0.1:30177" });
  assert.deepEqual(config, before);
  assert.throws(() => routeFromStatus(config, "https://another.example.ts.net:8445"), /existing proxy/);
});

test("Tailscale ownership fingerprint ignores only the selected UI handler, never neighboring services", () => {
  const original = serveConfig();
  const route = routeFromStatus(original, publicUrl);
  const changed = structuredClone(original);
  changed.Web[route.endpoint].Handlers["/"].Proxy = "http://127.0.0.1:30179";
  assert.equal(otherRoutes(original, route), otherRoutes(changed, route));
  changed.Web[route.endpoint].Handlers["/other/"].Proxy = "http://127.0.0.1:5000";
  assert.notEqual(otherRoutes(original, route), otherRoutes(changed, route));
  const secondPort = structuredClone(original);
  secondPort.Web["desktop.example.ts.net:8446"].Handlers["/"].Proxy = "http://127.0.0.1:8000";
  assert.notEqual(otherRoutes(original, route), otherRoutes(secondPort, route));
  const tcp = structuredClone(original);
  tcp.TCP["22"].TCPForward = "127.0.0.1:2222";
  assert.notEqual(otherRoutes(original, route), otherRoutes(tcp, route));
});

test("Tailscale promotion cannot replace static content, a non-loopback proxy, Funnel, or a TCP route", () => {
  const changes = [
    (config) => { config.Web["desktop.example.ts.net:8445"].Handlers["/"] = { Path: "C:\\private" }; },
    (config) => { config.Web["desktop.example.ts.net:8445"].Handlers["/"].Proxy = "http://remote.example.test:30177"; },
    (config) => { config.AllowFunnel["desktop.example.ts.net:8445"] = true; },
    (config) => { config.TCP["8445"] = { TCPForward: "127.0.0.1:30177" }; },
  ];
  for (const change of changes) {
    const config = serveConfig();
    change(config);
    assert.throws(() => routeFromStatus(config, publicUrl));
  }
});
