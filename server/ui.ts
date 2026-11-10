// Launched only by bin/omp-web-ui.js from its frozen customization workspace.
import { parseArgs } from "node:util";
import { isLoopbackHost } from "../lib/hosts/host-login";
import { startDevelopment } from "./dev";
import { attachUiHostLink } from "./ui-link";

if (process.execArgv.some(arg => arg === "--hot" || arg === "--watch" || arg.startsWith("--hot=") || arg.startsWith("--watch="))) {
  throw new Error("UI customization must not hot-reload the API or session runtime");
}
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" } } });
const listen = { port: values.port === undefined ? 30178 : Number(values.port), hostname: values.hostname ?? "127.0.0.1" };
if (!isLoopbackHost(listen.hostname) || !Number.isInteger(listen.port) || listen.port < 1 || listen.port > 65535) {
  throw new Error("UI customization requires a loopback hostname and a port from 1 to 65535");
}
const hostname = listen.hostname.includes(":") && !listen.hostname.startsWith("[") ? `[${listen.hostname}]` : listen.hostname;
await attachUiHostLink(`http://${hostname}:${listen.port}`, { primary: process.env.OMP_WEB_UI_PRIMARY_LINK === "1" });
Object.assign(process.env, { OMP_WEB_UI_CUSTOMIZATION: "1", OMP_WEB_DISABLE_AUTOUPDATE: "1" });
// Bun's HTML-import HMR is independent of --hot. dev.ts initializes the normal,
// auth-gated API once; only synchronized display/style modules change afterward.
await startDevelopment();
