# Lateo Wallet

Non-custodial TypeScript wallet for the Zephyr Protocol (`ZPH`, `ZSD`, `ZRS`,
`ZYS`), powered by `@loki-notfound/zephyr-ts`.

## Monorepo layout

- `packages/core`: Pure TypeScript wallet engine adapter, WebCrypto encrypted
  vault (`PBKDF2-SHA256` + `AES-256-GCM` with wrapped DEK and per-wallet random
  `corePassword`), asset/amount helpers, storage interfaces, and typed RPC
  protocol.
- `packages/ui`: Shared Svelte 5 (Runes-only) wallet UI styled with vendored
  public `@lateo/style` (`0.2.0`) stylesheets and assets.
- `apps/extension`: Manifest V3 browser extension for Chrome/Chromium and
  Firefox (plain Vite multi-entry build + deterministic manifest generator).

## Requirements

- Node.js `>=22`
- `pnpm` (managed via `corepack`)

## Development commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm check:ui-safety
corepack pnpm build:extension
corepack pnpm check:security
corepack pnpm test
corepack pnpm package:extension
```

Extension builds emit:
- `apps/extension/dist/chrome/`
- `apps/extension/dist/firefox/`

Reproducible production archives (`corepack pnpm package:extension`) emit:
- `apps/extension/release/lateo-wallet-chrome-v0.1.0.zip`
- `apps/extension/release/lateo-wallet-firefox-v0.1.0.zip`
- `apps/extension/release/SHA256SUMS`

See [`docs/BUILD.md`](docs/BUILD.md) for reproducible build and verification instructions.

## Security invariants

- Zero `{@html}`, zero runtime `<style>` injection, and zero inline `style=`
  attributes in UI components (`pnpm check:ui-safety` and `pnpm check:security`).
- Strict Manifest V3 Content Security Policy (`script-src 'self'
  'wasm-unsafe-eval'; style-src 'self'; object-src 'none'`).
- `@loki-notfound/zephyr-ts` is installed from its signed GitHub release
  tarball (`v2.3.0-sec.2-ts.2`) with integrity pinned in `pnpm-lock.yaml`, and
  `zephyr.wasm` is verified against its embedded SHA-256 digest before
  compilation.
- All automated tests use fresh, random, empty disposable wallets only.

## License and marks

Application code and reusable stylesheets, tokens, UI icons, and asset badges
are licensed under the BSD 3-Clause License (`LICENSE`).

The `lateo` name, hostnames under `lateo.dev`, and mark files under
`packages/ui/assets/lateo/products/wallet/` and `packages/ui/assets/lateo/logo/`
fall outside the BSD 3-Clause License; all rights in them are reserved (see
`LICENSE`).
