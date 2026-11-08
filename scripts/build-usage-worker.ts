import path from "node:path";

/** Release workers run from disk, not the executable's embedded module graph.
 * Bundle every non-builtin dependency (notably YAML) so the release needs no
 * source tree or node_modules beyond its unrelated static KaTeX assets. */
export function buildUsageWorker(root: string, outdir: string): Promise<Bun.BuildOutput> {
  return Bun.build({
    entrypoints: [path.join(root, "lib", "usage-worker.ts")],
    outdir,
    naming: "usage-worker.js",
    target: "bun",
    format: "esm",
    packages: "bundle",
    splitting: false,
    minify: true,
    metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
  });
}
