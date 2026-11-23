#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const APP_VERSION = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.1.0";

async function main() {
  await Promise.all([
    build({
      entryPoints: [path.join(ROOT, "src/main/main.ts")],
      outfile: path.join(ROOT, "dist/main/main.cjs"),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      sourcemap: false,
      external: ["electron"]
    }),
    build({
      entryPoints: [path.join(ROOT, "src/preload/preload.ts")],
      outfile: path.join(ROOT, "dist/preload/preload.cjs"),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      sourcemap: false,
      external: ["electron"],
      define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
      }
    })
  ]);
  console.log("Built Electron main and preload bundles -> apps/desktop/dist/{main,preload}/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
