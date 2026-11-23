#!/usr/bin/env node
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");

async function main() {
  await Promise.all([
    build({
      entryPoints: [path.join(ROOT, "src/main/main.ts")],
      outfile: path.join(ROOT, "dist/main/main.cjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      sourcemap: false,
      external: ["electron"]
    }),
    build({
      entryPoints: [path.join(ROOT, "src/preload/preload.ts")],
      outfile: path.join(ROOT, "dist/preload/preload.cjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      sourcemap: false,
      external: ["electron"]
    })
  ]);
  console.log("Built Electron main and preload bundles -> apps/desktop/dist/{main,preload}/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
