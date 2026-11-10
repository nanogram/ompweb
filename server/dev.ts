// Dev entry (`npm run dev`): API plus the SPA from Bun's HTML import with HMR, bundled in memory; never reads dist/.
import html from "../app/index.html";
import { buildEventStreamWorker, clientEnv } from "./client-env";
import { register } from "../instrumentation.node";

declare global {
  var __ompWebRegistered: Promise<void> | undefined;
  var __ompWebDevServer: Bun.Subprocess | undefined;
}

export async function startDevelopment() {
  const root = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  // A new worker hash during --hot re-evaluation must not start a second listener.
  const worker = await buildEventStreamWorker(root);
  const env = clientEnv(root, worker, { uiCustomization: process.env.OMP_WEB_UI_CUSTOMIZATION === "1" });
  if (Object.keys(env).some((name) => process.env[name] === undefined)) {
    // Bun inlines OMP_WEB_PUBLIC_* from its initial environment, so re-run the
    // same entry once with them set. This also preserves the UI-only entry.
    const child = (globalThis.__ompWebDevServer ??= Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
      env: { ...process.env, ...env },
      stdio: ["inherit", "inherit", "inherit"],
    }));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
    process.exit(await child.exited);
  }

  Object.assign(process.env, { NODE_ENV: "development" });
  // API modules read NODE_ENV at evaluation; static import would run them
  // before the development environment is initialized.
  const { parseListenArgs, startServer } = await import("./app");
  const server = startServer({ ...parseListenArgs(Bun.argv.slice(2), 30178), dev: true, root, html, worker });
  globalThis.__ompWebRegistered ??= register();
  await globalThis.__ompWebRegistered;
  console.log(`[omp-web] Ready on ${server.url.origin}`);
  return server;
}

if (import.meta.main) await startDevelopment();
