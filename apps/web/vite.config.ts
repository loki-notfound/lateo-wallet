import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const rootDir = import.meta.dirname;

const PWA_ASSETS = [
  "favicon.svg",
  "favicon-32.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest"
] as const;

function copyStaticWebAssets(): Plugin {
  return {
    name: "copy-lateo-web-pwa-assets",
    closeBundle() {
      const outDir = path.resolve(rootDir, "dist");
      fs.mkdirSync(outDir, { recursive: true });
      const srcDir = path.resolve(rootDir, "../../packages/ui/assets/lateo/products/wallet");
      for (const file of PWA_ASSETS) {
        fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
      }
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    svelte({
      emitCss: true,
      compilerOptions: {
        runes: true,
        css: "external"
      }
    }),
    copyStaticWebAssets()
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: path.resolve(rootDir, "index.html")
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
