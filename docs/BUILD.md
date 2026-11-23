# Reproducible Build and Packaging Guide

This document describes how to build, audit, package, and verify reproducible
release archives for the Lateo Wallet Manifest V3 browser extension (`chrome`
and `firefox` targets).

## Prerequisites

- **Node.js:** `>=22` (LTS recommended)
- **Package manager:** `pnpm` via `corepack` (`pnpm@12.21.0` pinned in root
  `package.json`)

Install workspace dependencies from the locked dependency graph without running
arbitrary third-party lifecycle scripts:

```bash
corepack pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` restricts build scripts strictly to `esbuild`, and
`pnpm-lock.yaml` pins the signed `@loki-notfound/zephyr-ts` (`2.3.0-sec.2-ts.2`)
release tarball by its SHA-512 SRI integrity hash.

## Build and Security Audit

1. **Typecheck all workspaces (`packages/core`, `packages/ui`, `apps/extension`):**

   ```bash
   corepack pnpm typecheck
   ```

2. **Build deterministic extension bundles for Chrome and Firefox:**

   ```bash
   corepack pnpm build:extension
   ```

   This produces:
   - `apps/extension/dist/chrome/` (Manifest V3 Service Worker + Offscreen
     Document + Popup, Side Panel, and Full Tab views)
   - `apps/extension/dist/firefox/` (Manifest V3 Event Page + Popup and Full Tab
     views)

3. **Run the static and build-output security audit suite:**

   ```bash
   corepack pnpm check:security
   ```

   `scripts/check-security.mjs` verifies:
   - Svelte 5 Runes-only discipline, zero `{@html}`, zero `<style>` tags, zero
     inline `style=` attributes, and zero DOM HTML injection sinks.
   - Strict Manifest V3 Content Security Policy (`default-src 'none'; script-src
     'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src
     'self'; object-src 'none'; base-uri 'none'; form-action 'none'`) and
     minimal extension permissions (zero `<all_urls>`, zero `content_scripts`,
     zero `externally_connectable`).
   - Bundle isolation confirming `@loki-notfound/zephyr-ts`, `zephyr.wasm`, and
     `zephyr.worker.js` are never imported or preloaded in UI entrypoints or the
     Chrome MV3 Service Worker (`background.js`).
   - Zero `.map` sourcemaps and zero remote `http://` / `https://` script or
     stylesheet URLs in built HTML and CSS assets.
   - Exact `@loki-notfound/zephyr-ts` tarball URL and SHA-512 integrity pin in
     `pnpm-lock.yaml`.

4. **Run automated unit and integration tests:**

   ```bash
   corepack pnpm test
   ```

## Deterministic Release Packaging

Generate reproducible ZIP archives for Chrome Web Store and Firefox Add-ons
(AMO):

```bash
corepack pnpm build:extension
corepack pnpm package:extension
```

`scripts/package-extension.mjs` writes the release artifacts to
`apps/extension/release/` (ignored by git):

- `apps/extension/release/lateo-wallet-chrome-v0.1.0.zip`
- `apps/extension/release/lateo-wallet-firefox-v0.1.0.zip`
- `apps/extension/release/SHA256SUMS`

### Determinism Invariants

To guarantee byte-identical ZIP archives across consecutive clean builds:
- All entries in `apps/extension/dist/<target>` are sorted in strict UTF-8
  lexicographical path order (`/` path separators).
- Archive entries include regular files only, normalized to POSIX mode `0644`
  (`-rw-r--r--`).
- Every entry uses a fixed UTC MS-DOS timestamp (`2026-01-01T00:00:00Z`) and a
  zero-length extra field (omitting host UID/GID and filesystem timestamps).
- Payloads are compressed with deterministic raw `DEFLATE` at level `9`.

### Verifying Reproducibility

Run two consecutive clean builds and verify that the resulting SHA-256 digests
are identical:

```bash
corepack pnpm build:extension && corepack pnpm package:extension
cp apps/extension/release/SHA256SUMS /tmp/SHA256SUMS.run1

corepack pnpm build:extension && corepack pnpm package:extension
diff -u /tmp/SHA256SUMS.run1 apps/extension/release/SHA256SUMS
(cd apps/extension/release && sha256sum -c SHA256SUMS)
```
