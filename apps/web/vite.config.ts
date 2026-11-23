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

const DEV_PREVIEW_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};

export default defineConfig({
  base: "./",
  server: {
    headers: DEV_PREVIEW_HEADERS
  },
  preview: {
    headers: DEV_PREVIEW_HEADERS
  },
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
