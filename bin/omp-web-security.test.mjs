import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyPassword } = require("./omp-web-password-hash.js");
const binDir = fileURLToPath(new URL(".", import.meta.url));

/** Run the launcher against a stub `server/main.ts` that records the environment it was started with. */
async function launch(env, args = []) {
  const pkg = await mkdtemp(join(tmpdir(), "ompweb-launch-"));
  try {
    await mkdir(join(pkg, "bin"));
    for (const name of await readdir(binDir)) {
      if (name.endsWith(".js")) await copyFile(join(binDir, name), join(pkg, "bin", name));
    }
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: "1.0.0-n1", repository: { url: "git+https://github.com/nanogram/ompweb.git" } }));
    await mkdir(join(pkg, "lib", "omp"), { recursive: true });
    await mkdir(join(pkg, "lib", "hosts"), { recursive: true });
    await copyFile(fileURLToPath(new URL("../lib/omp/paths.ts", import.meta.url)), join(pkg, "lib", "omp", "paths.ts"));
    await copyFile(fileURLToPath(new URL("../lib/hosts/link-protocol.ts", import.meta.url)), join(pkg, "lib", "hosts", "link-protocol.ts"));
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(pkg, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const temporary = join(pkg, "tmp");
    await mkdir(temporary);
    await mkdir(join(pkg, "dist"));
    await writeFile(join(pkg, "dist", "index.html"), "<!doctype html>");
    await mkdir(join(pkg, "server"));
    const dump = join(pkg, "server-env.json");
    // The fixture and its supervisor use the same installed Bun/Jiti dependencies
    // as the real production launcher, with a private agent and temporary directory.
    await writeFile(join(pkg, "server", "main.ts"), `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));`);
    const result = spawnSync("node", [join(pkg, "bin", "omp-web.js"), "--no-open", "-p", "0", ...args], {
      env: { PATH: [dirname(process.execPath), process.env.PATH].join(delimiter), HOME: pkg, USERPROFILE: pkg, PI_CODING_AGENT_DIR: join(pkg, "agent"), TMP: temporary, TEMP: temporary, ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    const serverEnv = await readFile(dump, "utf8").then(JSON.parse, () => null);
    return { status: result.status, stderr: result.stderr, serverEnv };
  } finally {
    await rm(pkg, { recursive: true, force: true });
  }
}

test("launcher refuses unauthenticated non-loopback binds", async () => {
  const { status, stderr, serverEnv } = await launch({}, ["-H", "0.0.0.0"]);
  assert.equal(status, 1);
  assert.match(stderr, /Refusing to listen on 0\.0\.0\.0 without a password hash/);
  assert.equal(serverEnv, null);
});

test("launcher hands the server a hash of a plaintext OMP_WEB_PASSWORD, never the plaintext", async () => {
  const { stderr, serverEnv } = await launch({ OMP_WEB_PASSWORD: "s3cret pw" });
  assert.ok(serverEnv, stderr);
  assert.equal(serverEnv.OMP_WEB_PASSWORD, undefined);
  const hash = serverEnv.OMP_WEB_PASSWORD_HASH;
  assert.equal(verifyPassword("s3cret pw", hash), true);
  assert.ok(!stderr.includes("s3cret pw"), stderr);
});

test("launcher refuses a plaintext OMP_WEB_PASSWORD next to a hash", async () => {
  const { hashPassword } = require("./omp-web-password-hash.js");
  const { status, serverEnv } = await launch({ OMP_WEB_PASSWORD: "s3cret pw", OMP_WEB_PASSWORD_HASH: hashPassword("other") });
  assert.equal(status, 1);
  assert.equal(serverEnv, null);
});
