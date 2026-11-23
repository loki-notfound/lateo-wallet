import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const rootDir = import.meta.dirname;
const target = process.env.TARGET === "firefox" ? "firefox" : "chrome";

function copyStaticExtensionAssets(): Plugin {
  return {
    name: "copy-lateo-extension-assets",
    closeBundle() {
      const outDir = path.resolve(rootDir, "dist", target);
      const iconsDir = path.join(outDir, "icons");
      fs.mkdirSync(iconsDir, { recursive: true });

      const uiIconsDir = path.resolve(
        rootDir,
        "../../packages/ui/assets/lateo/products/wallet"
      );
      for (const size of [16, 32, 48, 128]) {
        fs.copyFileSync(
          path.join(uiIconsDir, `icon-${size}.png`),
          path.join(iconsDir, `icon-${size}.png`)
        );
      }
    }
  };
}

const chromeInputs = {
  popup: path.resolve(rootDir, "popup.html"),
  panel: path.resolve(rootDir, "panel.html"),
  app: path.resolve(rootDir, "app.html"),
  offscreen: path.resolve(rootDir, "offscreen.html"),
  background: path.resolve(rootDir, "src/chrome/background.ts")
};

const firefoxInputs = {
  popup: path.resolve(rootDir, "popup.html"),
  app: path.resolve(rootDir, "app.html"),
  "background-firefox": path.resolve(rootDir, "src/firefox/background.ts")
};

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
    copyStaticExtensionAssets()
  ],
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: target === "firefox" ? firefoxInputs : chromeInputs,
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background" || chunk.name === "background-firefox") {
            return "[name].js";
          }
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
