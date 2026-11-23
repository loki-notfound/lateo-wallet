import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const rootDir = import.meta.dirname;

const DESKTOP_ICONS = ["favicon.svg", "icon-128.png", "icon-256.png", "icon-512.png"] as const;

function copyDesktopIcons(): Plugin {
  return {
    name: "copy-lateo-desktop-icons",
    closeBundle() {
      const outDir = path.resolve(rootDir, "dist/renderer");
      fs.mkdirSync(outDir, { recursive: true });
      const srcDir = path.resolve(rootDir, "../../packages/ui/assets/lateo/products/wallet");
      for (const file of DESKTOP_ICONS) {
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
    copyDesktopIcons()
  ],
  build: {
    outDir: "dist/renderer",
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
