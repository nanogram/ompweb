import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildUsageWorker } from "../scripts/build-usage-worker.ts";
import { getUsageWorkerPath, runUsageReportInWorker } from "./usage-report-worker.ts";

// Exercise the actual release bundler and runtime resolver together, outside
// the checkout. A copied TS entry alone cannot pass: YAML and the parser/DB
// imports must all be available without a source tree or installed packages.
test("the release worker bundle computes custom YAML-priced usage outside the checkout", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), "omp-usage-release-"));
  const packageDir = join(dir, "release");
  const agentDir = join(dir, "agent");
  const hostileCwd = join(dir, "unrelated-project");
  const keys = ["OMP_WEB_PACKAGE_DIR", "OMP_WEB_USAGE_WORKER", "PI_CODING_AGENT_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  try {
    const result = await buildUsageWorker(root, join(packageDir, "lib"));
    assert.equal(result.success, true, result.logs.map(String).join("\n"));
    const worker = join(packageDir, "lib", "usage-worker.js");
    assert.ok(existsSync(worker));
    mkdirSync(join(agentDir, "sessions", "project"), { recursive: true });
    mkdirSync(join(hostileCwd, "lib"), { recursive: true });
    writeFileSync(join(hostileCwd, "lib", "usage-worker.ts"), "throw new Error('cwd worker executed');\n");
    writeFileSync(join(agentDir, "models.yml"), `providers:
  release-test:
    models:
      - id: bundled-model
        cost:
          input: 2
          output: 4
`);
    const timestamp = new Date().toISOString();
    writeFileSync(join(agentDir, "sessions", "project", "one.jsonl"), [
      { type: "session", version: 3, id: "release-session", cwd: "/release/project", timestamp },
      { type: "message", id: "e1", timestamp, message: {
        role: "assistant", provider: "release-test", model: "bundled-model", usage: { input: 1_000, output: 500 },
      } },
    ].map(JSON.stringify).join("\n") + "\n");
    process.env.OMP_WEB_PACKAGE_DIR = packageDir;
    delete process.env.OMP_WEB_USAGE_WORKER;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(hostileCwd);
    assert.equal(getUsageWorkerPath(), worker);
    const report = await runUsageReportInWorker({ range: "all" });
    assert.equal(report.summary.inputTokens, 1_000);
    assert.equal(report.summary.outputTokens, 500);
    assert.equal(report.summary.totalCost, 0.004);
    assert.equal(report.scanInfo.usageRecordsCount, 1);
    assert.equal(report.stale, false);
    assert.equal(report.scannedAt, report.scanInfo.scannedAt);
    // Removal before restoring env also catches leaked Windows DB handles.
    rmSync(agentDir, { recursive: true, force: true });
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
