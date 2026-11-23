import fs from "node:fs";
import path from "node:path";
import { buildManifest, type ExtensionTarget } from "./manifest-builder.js";

const targetArg = process.argv[2];
if (targetArg !== "chrome" && targetArg !== "firefox") {
  console.error("Usage: tsx scripts/build-manifest.ts <chrome|firefox>");
  process.exit(1);
}
const target: ExtensionTarget = targetArg;

const outDir = path.resolve(import.meta.dirname, "..", "dist", target);
fs.mkdirSync(outDir, { recursive: true });
const manifest = buildManifest(target);
const outPath = path.join(outDir, "manifest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`Wrote deterministic ${target} manifest -> ${outPath}`);
