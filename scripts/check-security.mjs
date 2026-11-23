#!/usr/bin/env node
/**
 * Comprehensive static and build-output security audit suite for Lateo Wallet:
 * 1. Runs source-level UI safety checks (scripts/check-ui-safety.mjs).
 * 2. Verifies built extension outputs (apps/extension/dist/chrome & dist/firefox):
 *    - Strict Manifest V3 CSP (wasm-unsafe-eval, style-src 'self', object-src 'none';
 *      zero unsafe-inline / unsafe-eval) and minimal permissions (zero <all_urls>,
 *      zero content_scripts, zero externally_connectable).
 *    - Bundle isolation: zephyr-ts / zephyr.wasm / zephyr.worker.js must never be
 *      imported or preloaded in popup/panel/app UI bundles or Chrome background.js.
 *    - Zero .map sourcemaps in dist/.
 *    - Zero remote script/style URLs (http:// or https:// in <script>, <link>,
 *      @import, or url(...)) and zero <style> tags or inline style= attributes in
 *      built HTML/CSS assets.
 * 3. Supply-chain & lockfile integrity:
 *    - pnpm-lock.yaml pins the exact signed @loki-notfound/zephyr-ts release tarball
 *      URL and SHA-512 SRI integrity digest.
 *    - pnpm-workspace.yaml permits only esbuild in allowBuilds / onlyBuiltDependencies.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT_DIST = path.join(ROOT, "apps", "extension", "dist");
const CHROME_DIST = path.join(EXT_DIST, "chrome");
const FIREFOX_DIST = path.join(EXT_DIST, "firefox");
const WEB_DIR = path.join(ROOT, "apps", "web");
const WEB_DIST = path.join(WEB_DIR, "dist");

const EXPECTED_ZEPHYR_TARBALL =
  "https://github.com/loki-notfound/myzephyr-ts/releases/download/v2.3.0-sec.2-ts.2/loki-notfound-zephyr-ts-2.3.0-sec.2-ts.2.tgz";
const EXPECTED_ZEPHYR_INTEGRITY =
  "sha512-CqRFSHeeGzIcq3BSrbzJsU6yL2wgEWBtQKf+3aNW1sWREbPljtHuXCj6EC9QCKj1cnFF6DT6R2Q4QmJ2hNf21w==";

const EXPECTED_PERMISSIONS = {
  chrome: ["storage", "unlimitedStorage", "alarms", "offscreen", "sidePanel"],
  firefox: ["storage", "unlimitedStorage", "alarms"]
};
const EXPECTED_HOST_PERMISSIONS = ["https://node.lateo.dev/*"];
const EXPECTED_OPTIONAL_HOST_PERMISSIONS = [
  "https://*/*",
  "http://127.0.0.1/*",
  "http://localhost/*"
];
const EXPECTED_EXTENSION_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none';";
const EXPECTED_UI_META_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

const FORBIDDEN_MANIFEST_KEYS = [
  "content_scripts",
  "externally_connectable",
  "web_accessible_resources",
  "chrome_url_overrides",
  "devtools_page"
];

const FORBIDDEN_PERMISSION_TOKENS = new Set([
  "<all_urls>",
  "*://*/*",
  "http://*/*",
  "tabs",
  "activeTab",
  "scripting",
  "webRequest",
  "declarativeNetRequest",
  "cookies",
  "history",
  "bookmarks",
  "clipboardRead",
  "debugger",
  "management",
  "nativeMessaging",
  "proxy"
]);

let failures = 0;

function fail(category, detail) {
  console.error(`SECURITY-AUDIT [${category}] ${detail}`);
  failures++;
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function runUiSafetyCheck() {
  const uiSafetyScript = path.join(ROOT, "scripts", "check-ui-safety.mjs");
  try {
    execFileSync(process.execPath, [uiSafetyScript], {
      cwd: ROOT,
      stdio: "inherit"
    });
  } catch {
    fail("ui-safety", "scripts/check-ui-safety.mjs reported violations");
  }
}

function ensureBuiltDist() {
  const chromeManifest = path.join(CHROME_DIST, "manifest.json");
  const firefoxManifest = path.join(FIREFOX_DIST, "manifest.json");
  if (!fs.existsSync(chromeManifest) || !fs.existsSync(firefoxManifest)) {
    console.log("Extension build outputs missing; running corepack pnpm build:extension...");
    execFileSync("corepack", ["pnpm", "build:extension"], {
      cwd: ROOT,
      stdio: "inherit"
    });
  }
  if (fs.existsSync(path.join(WEB_DIR, "package.json"))) {
    const webIndex = path.join(WEB_DIST, "index.html");
    if (!fs.existsSync(webIndex)) {
      console.log("Web PWA build output missing; running corepack pnpm build:web...");
      execFileSync("corepack", ["pnpm", "build:web"], {
        cwd: ROOT,
        stdio: "inherit"
      });
    }
  }
}

function parseCspDirectives(cspString) {
  const map = new Map();
  for (const raw of cspString.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    const values = parts.slice(1);
    map.set(name, values);
  }
  return map;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

function auditManifest(target, distDir) {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("manifest", `${target}: missing manifest.json at ${manifestPath}`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail("manifest", `${target}: invalid JSON in manifest.json (${err.message})`);
    return;
  }

  if (manifest.manifest_version !== 3) {
    fail("manifest", `${target}: manifest_version must be 3, got ${manifest.manifest_version}`);
  }

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) {
      fail("manifest-surface", `${target}: forbidden key "${key}" present in manifest.json`);
    }
  }

  const allPerms = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
    ...(Array.isArray(manifest.optional_host_permissions)
      ? manifest.optional_host_permissions
      : [])
  ];
  for (const perm of allPerms) {
    if (FORBIDDEN_PERMISSION_TOKENS.has(perm)) {
      fail("manifest-permissions", `${target}: forbidden permission "${perm}" in manifest.json`);
    }
  }

  if (!arraysEqual(manifest.permissions, EXPECTED_PERMISSIONS[target])) {
    fail(
      "manifest-permissions",
      `${target}: permissions mismatch. Expected ${JSON.stringify(
        EXPECTED_PERMISSIONS[target]
      )}, got ${JSON.stringify(manifest.permissions)}`
    );
  }

  if (!arraysEqual(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) {
    fail(
      "manifest-permissions",
      `${target}: host_permissions mismatch. Expected ${JSON.stringify(
        EXPECTED_HOST_PERMISSIONS
      )}, got ${JSON.stringify(manifest.host_permissions)}`
    );
  }

  if (!arraysEqual(manifest.optional_host_permissions, EXPECTED_OPTIONAL_HOST_PERMISSIONS)) {
    fail(
      "manifest-permissions",
      `${target}: optional_host_permissions mismatch. Expected ${JSON.stringify(
        EXPECTED_OPTIONAL_HOST_PERMISSIONS
      )}, got ${JSON.stringify(manifest.optional_host_permissions)}`
    );
  }

  if (
    manifest.optional_permissions !== undefined &&
    (!Array.isArray(manifest.optional_permissions) || manifest.optional_permissions.length > 0)
  ) {
    fail(
      "manifest-permissions",
      `${target}: unexpected optional_permissions present: ${JSON.stringify(
        manifest.optional_permissions
      )}`
    );
  }

  if (target === "chrome") {
    if (manifest.minimum_chrome_version !== "116") {
      fail(
        "manifest",
        `chrome: expected minimum_chrome_version "116", got ${JSON.stringify(
          manifest.minimum_chrome_version
        )}`
      );
    }
  } else {
    const gecko = manifest?.browser_specific_settings?.gecko;
    if (!gecko || gecko.id !== "wallet@lateo.dev" || typeof gecko.strict_min_version !== "string") {
      fail("manifest", "firefox: missing or invalid browser_specific_settings.gecko");
    }
  }

  const csp = manifest?.content_security_policy?.extension_pages;
  if (typeof csp !== "string" || csp.trim().length === 0) {
    fail("manifest-csp", `${target}: missing content_security_policy.extension_pages`);
    return;
  }

  if (csp !== EXPECTED_EXTENSION_CSP) {
    fail(
      "manifest-csp",
      `${target}: extension_pages CSP does not match exact allowlisted policy.\n  Expected: ${EXPECTED_EXTENSION_CSP}\n  Got:      ${csp}`
    );
  }

  const tokens = csp.split(/[\s;]+/).filter(Boolean);
  if (tokens.includes("'unsafe-inline'")) {
    fail("manifest-csp", `${target}: CSP must not allow 'unsafe-inline'`);
  }
  if (tokens.includes("'unsafe-eval'")) {
    fail("manifest-csp", `${target}: CSP must not allow 'unsafe-eval'`);
  }

  const directives = parseCspDirectives(csp);
  const expectedDirectiveNames = new Set([
    "default-src",
    "script-src",
    "worker-src",
    "style-src",
    "img-src",
    "connect-src",
    "object-src",
    "base-uri",
    "form-action"
  ]);
  for (const name of directives.keys()) {
    if (!expectedDirectiveNames.has(name)) {
      fail("manifest-csp", `${target}: unexpected CSP directive "${name}"`);
    }
  }
  const requiredDirectives = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
    ["worker-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]]
  ];

  for (const [dirName, expectedVals] of requiredDirectives) {
    const actualVals = directives.get(dirName);
    if (!arraysEqual(actualVals, expectedVals)) {
      fail(
        "manifest-csp",
        `${target}: CSP directive "${dirName}" expected ${JSON.stringify(
          expectedVals
        )}, got ${JSON.stringify(actualVals)}`
      );
    }
  }
}

function extractHtmlReferencedAssets(htmlText) {
  const refs = [];
  const attrRegex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRegex.exec(htmlText)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

function extractJsImportSpecifiers(code) {
  const specs = [];
  const staticRe = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = staticRe.exec(code)) !== null) specs.push(m[1]);
  while ((m = dynamicRe.exec(code)) !== null) specs.push(m[1]);
  return specs;
}

function resolveImportGraph(entryFiles, distDir) {
  const visited = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (!fs.existsSync(current)) continue;
    const code = fs.readFileSync(current, "utf8");
    for (const spec of extractJsImportSpecifiers(code)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const resolved = spec.startsWith("/")
          ? path.resolve(distDir, spec.slice(1))
          : path.resolve(path.dirname(current), spec);
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }
  return visited;
}

function auditBundleIsolationAndAssets(target, distDir) {
  const files = walkFiles(distDir);
  if (files.length === 0) {
    fail("dist", `${target}: dist directory is empty`);
    return;
  }

  // 1. Verify zero sourcemaps anywhere in dist/<target>
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (file.endsWith(".map")) {
      fail("no-sourcemaps", `${target}: sourcemap file found in build output: ${rel}`);
    }
  }

  // 2. Verify packaged local WASM and worker assets exist
  const assetsDir = path.join(distDir, "assets");
  const assetEntries = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const hasWasm = assetEntries.some((n) => /^zephyr-[A-Za-z0-9_-]+\.wasm$/.test(n));
  const hasWorker = assetEntries.some((n) => /^zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(n));
  if (!hasWasm) {
    fail("wasm-bundle", `${target}: missing local zephyr-*.wasm in ${path.relative(ROOT, assetsDir)}`);
  }
  if (!hasWorker) {
    fail(
      "wasm-bundle",
      `${target}: missing local zephyr.worker-*.js in ${path.relative(ROOT, assetsDir)}`
    );
  }

  // 3. Audit built HTML and CSS files for zero remote URLs and zero inline styles
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const ext = path.extname(file);

    if (ext === ".html") {
      const html = fs.readFileSync(file, "utf8");
      if (/<style\b/i.test(html)) {
        fail("html-csp", `${rel}: <style> tag found in built HTML`);
      }
      if (/\bstyle\s*=/i.test(html)) {
        fail("html-csp", `${rel}: inline style= attribute found in built HTML`);
      }
      for (const ref of extractHtmlReferencedAssets(html)) {
        if (/^(?:https?:)?\/\//i.test(ref)) {
          fail("no-remote-assets", `${rel}: remote URL "${ref}" referenced in built HTML`);
        }
      }
    } else if (ext === ".css") {
      const css = fs.readFileSync(file, "utf8");
      const importRegex = /@import\s+(?:url\s*\(\s*)?["']?([^"')\s]+)["']?\s*\)?/gi;
      let match;
      while ((match = importRegex.exec(css)) !== null) {
        if (/^(?:https?:)?\/\//i.test(match[1])) {
          fail("no-remote-assets", `${rel}: remote @import URL "${match[1]}" in built CSS`);
        }
      }
      const urlRegex = /\burl\s*\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
      while ((match = urlRegex.exec(css)) !== null) {
        if (/^(?:https?:)?\/\//i.test(match[1])) {
          fail("no-remote-assets", `${rel}: remote url("${match[1]}") in built CSS`);
        }
      }
    }
  }

  // 4. Verify UI pages (popup.html, panel.html, app.html) and Chrome Service Worker (background.js)
  // never import or preload zephyr-ts, zephyr.wasm, or zephyr.worker.js.
  const forbiddenEngineMarkers = [
    { pattern: /zephyr-[A-Za-z0-9_-]+\.wasm\b/, label: "zephyr.wasm asset reference" },
    { pattern: /zephyr\.worker-[A-Za-z0-9_-]+\.js\b/, label: "zephyr.worker.js asset reference" },
    { pattern: /\bcreateZephyrWallet\b/, label: "createZephyrWallet engine symbol" },
    { pattern: /\bsetWasmModuleUrl\b/, label: "setWasmModuleUrl engine symbol" },
    { pattern: /\bsetWorkerDistPath\b/, label: "setWorkerDistPath engine symbol" },
    { pattern: /\bWebAssembly\.compile\b/, label: "WebAssembly.compile call" }
  ];

  const uiHtmlNames =
    target === "chrome" ? ["popup.html", "panel.html", "app.html"] : ["popup.html", "app.html"];
  const uiJsFiles = new Set();

  for (const htmlName of uiHtmlNames) {
    const htmlPath = path.join(distDir, htmlName);
    if (!fs.existsSync(htmlPath)) {
      fail("ui-surface", `${target}: missing expected UI HTML entrypoint ${htmlName}`);
      continue;
    }
    const htmlText = fs.readFileSync(htmlPath, "utf8");
    if (!htmlText.includes(EXPECTED_UI_META_CSP)) {
      fail(
        "html-csp",
        `${target}/${htmlName}: missing strict page-level meta CSP with connect-src 'none'`
      );
    }
    for (const marker of forbiddenEngineMarkers) {
      if (marker.pattern.test(htmlText)) {
        fail(
          "bundle-isolation",
          `${target}/${htmlName}: preloads or references forbidden ${marker.label}`
        );
      }
    }
    if (/offscreen-[A-Za-z0-9_-]+\.js\b/.test(htmlText)) {
      fail("bundle-isolation", `${target}/${htmlName}: preloads offscreen engine chunk`);
    }
    for (const ref of extractHtmlReferencedAssets(htmlText)) {
      if (ref.endsWith(".js")) {
        const relRef = ref.replace(/^\/+/, "");
        uiJsFiles.add(path.resolve(distDir, relRef));
      }
    }
  }

  // On Chrome, background.js is the thin MV3 Service Worker and must never import zephyr-ts/WASM
  if (target === "chrome") {
    const swPath = path.join(distDir, "background.js");
    if (!fs.existsSync(swPath)) {
      fail("bundle-isolation", "chrome: missing background.js service worker");
    } else {
      uiJsFiles.add(swPath);
    }
  }

  // Walk the full transitive ES import graph from every UI entrypoint and Chrome SW
  const reachableUiJs = resolveImportGraph(uiJsFiles, distDir);
  for (const reached of reachableUiJs) {
    const base = path.basename(reached);
    if (/^offscreen-[A-Za-z0-9_-]+\.js$/.test(base) || /^zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(base)) {
      fail(
        "bundle-isolation",
        `${target}: UI/SW import graph transitively reaches forbidden engine bundle ${path.relative(ROOT, reached)}`
      );
    }
    uiJsFiles.add(reached);
  }

  // Also include all non-engine JS chunks in assets/ (everything except offscreen-*.js and zephyr.worker-*.js)
  for (const entryName of assetEntries) {
    if (!entryName.endsWith(".js")) continue;
    if (/^offscreen-[A-Za-z0-9_-]+\.js$/.test(entryName)) continue;
    if (/^zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(entryName)) continue;
    uiJsFiles.add(path.join(assetsDir, entryName));
  }

  for (const jsFile of uiJsFiles) {
    if (!fs.existsSync(jsFile)) {
      fail("bundle-isolation", `${target}: referenced JS file missing: ${path.relative(ROOT, jsFile)}`);
      continue;
    }
    const rel = path.relative(ROOT, jsFile);
    const code = fs.readFileSync(jsFile, "utf8");
    for (const marker of forbiddenEngineMarkers) {
      if (marker.pattern.test(code)) {
        fail("bundle-isolation", `${rel}: UI/SW bundle contains forbidden ${marker.label}`);
      }
    }
  }
}

function auditSupplyChainLockfiles() {
  const lockPath = path.join(ROOT, "pnpm-lock.yaml");
  if (!fs.existsSync(lockPath)) {
    fail("supply-chain", "Missing pnpm-lock.yaml");
  } else {
    const lockText = fs.readFileSync(lockPath, "utf8");
    if (!lockText.includes(`specifier: ${EXPECTED_ZEPHYR_TARBALL}`)) {
      fail(
        "supply-chain",
        `pnpm-lock.yaml is missing exact @loki-notfound/zephyr-ts specifier (${EXPECTED_ZEPHYR_TARBALL})`
      );
    }
    const expectedResolutionLine = `resolution: {integrity: ${EXPECTED_ZEPHYR_INTEGRITY}, tarball: ${EXPECTED_ZEPHYR_TARBALL}}`;
    if (!lockText.includes(expectedResolutionLine)) {
      fail(
        "supply-chain",
        "pnpm-lock.yaml does not match the pinned @loki-notfound/zephyr-ts tarball URL and SHA-512 SRI integrity hash"
      );
    }
  }

  const workspacePath = path.join(ROOT, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    fail("supply-chain", "Missing pnpm-workspace.yaml");
  } else {
    const wsText = fs.readFileSync(workspacePath, "utf8");
    const lines = wsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    const buildSectionIdx = lines.findIndex(
      (l) => l === "allowBuilds:" || l === "onlyBuiltDependencies:"
    );
    if (buildSectionIdx === -1) {
      fail("supply-chain", "pnpm-workspace.yaml is missing allowBuilds / onlyBuiltDependencies");
    } else {
      const allowedBuildEntries = lines.slice(buildSectionIdx + 1);
      if (
        allowedBuildEntries.length !== 1 ||
        (allowedBuildEntries[0] !== "esbuild: true" && allowedBuildEntries[0] !== "- esbuild")
      ) {
        fail(
          "supply-chain",
          `pnpm-workspace.yaml must only permit esbuild in allowBuilds, found: ${JSON.stringify(
            allowedBuildEntries
          )}`
        );
      }
    }
  }
}

function auditWebDist(distDir) {
  if (!fs.existsSync(path.join(WEB_DIR, "package.json"))) {
    return;
  }

  const files = walkFiles(distDir);
  if (files.length === 0) {
    fail("web-dist", "apps/web/dist directory is empty");
    return;
  }

  // 1. Zero sourcemaps
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (file.endsWith(".map")) {
      fail("no-sourcemaps", `web: sourcemap file found in build output: ${rel}`);
    }
  }

  // 2. Deduplicated local WASM and worker assets (exact count === 1 each)
  const assetsDir = path.join(distDir, "assets");
  const assetEntries = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const wasmFiles = assetEntries.filter((n) => /^zephyr-[A-Za-z0-9_-]+\.wasm$/.test(n));
  const workerFiles = assetEntries.filter((n) => /^zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(n));
  if (wasmFiles.length !== 1) {
    fail(
      "web-wasm-bundle",
      `web: expected exactly 1 deduplicated zephyr-*.wasm in apps/web/dist/assets, found ${wasmFiles.length}`
    );
  }
  if (workerFiles.length !== 1) {
    fail(
      "web-wasm-bundle",
      `web: expected exactly 1 deduplicated zephyr.worker-*.js in apps/web/dist/assets, found ${workerFiles.length}`
    );
  }

  // 3. Required vendored PWA icons and manifest
  const requiredStaticFiles = [
    "index.html",
    "manifest.webmanifest",
    "favicon.svg",
    "favicon-32.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png"
  ];
  for (const reqFile of requiredStaticFiles) {
    if (!fs.existsSync(path.join(distDir, reqFile))) {
      fail("web-pwa-assets", `web: missing required static asset apps/web/dist/${reqFile}`);
    }
  }

  const manifestPath = path.join(distDir, "manifest.webmanifest");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
      if (icons.length === 0) {
        fail("web-pwa-manifest", "web: manifest.webmanifest has no icons");
      }
      for (const icon of icons) {
        const src = typeof icon?.src === "string" ? icon.src : "";
        if (!src || /^(?:https?:)?\/\//i.test(src)) {
          fail("web-pwa-manifest", `web: manifest.webmanifest icon has non-local src "${src}"`);
        } else {
          const resolvedIcon = path.resolve(distDir, src.replace(/^\.\//, ""));
          if (!fs.existsSync(resolvedIcon)) {
            fail(
              "web-pwa-manifest",
              `web: manifest.webmanifest references missing icon "${src}"`
            );
          }
        }
      }
    } catch (err) {
      fail("web-pwa-manifest", `web: invalid JSON in manifest.webmanifest (${err.message})`);
    }
  }

  // 4. Built HTML & CSS hygiene: zero <style>, zero inline style=, zero remote URLs
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const ext = path.extname(file);
    if (ext === ".html") {
      const html = fs.readFileSync(file, "utf8");
      if (/<style\b/i.test(html)) {
        fail("web-html-csp", `${rel}: <style> tag found in built HTML`);
      }
      if (/\bstyle\s*=/i.test(html)) {
        fail("web-html-csp", `${rel}: inline style= attribute found in built HTML`);
      }
      for (const ref of extractHtmlReferencedAssets(html)) {
        if (/^(?:https?:)?\/\//i.test(ref)) {
          fail("no-remote-assets", `${rel}: remote URL "${ref}" referenced in built HTML`);
        }
      }
    } else if (ext === ".css") {
      const css = fs.readFileSync(file, "utf8");
      const importRegex = /@import\s+(?:url\s*\(\s*)?["']?([^"')\s]+)["']?\s*\)?/gi;
      let match;
      while ((match = importRegex.exec(css)) !== null) {
        if (/^(?:https?:)?\/\//i.test(match[1])) {
          fail("no-remote-assets", `${rel}: remote @import URL "${match[1]}" in built CSS`);
        }
      }
      const urlRegex = /\burl\s*\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
      while ((match = urlRegex.exec(css)) !== null) {
        if (/^(?:https?:)?\/\//i.test(match[1])) {
          fail("no-remote-assets", `${rel}: remote url("${match[1]}") in built CSS`);
        }
      }
    }
  }
}

function main() {
  runUiSafetyCheck();
  ensureBuiltDist();
  auditManifest("chrome", CHROME_DIST);
  auditManifest("firefox", FIREFOX_DIST);
  auditBundleIsolationAndAssets("chrome", CHROME_DIST);
  auditBundleIsolationAndAssets("firefox", FIREFOX_DIST);
  auditWebDist(WEB_DIST);
  auditSupplyChainLockfiles();

  if (failures > 0) {
    console.error(`check:security FAILED (${failures} violation(s))`);
    process.exit(1);
  }

  console.log(
    "check:security OK (UI safety, MV3 manifests & strict CSP, bundle WASM isolation, Web PWA asset hygiene, zero sourcemaps, zero remote URLs, and supply-chain lockfile pins verified)"
  );
}

main();
