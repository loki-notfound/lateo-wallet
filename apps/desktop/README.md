# Lateo Wallet — Desktop Electron App (`@lateo-wallet/desktop`)

Sandboxed Electron desktop shell for Lateo Wallet reusing `@lateo-wallet/core` and `@lateo-wallet/ui`.

## Security Model

- **Renderer isolation:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`.
- **Privileged `app://` protocol:** Built static renderer assets are served exclusively from `app://lateo/` (`standard: true`, `secure: true`, `supportFetchAPI: true`, `stream: true`) with explicit Page CSP and Worker CSP response headers (`script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; object-src 'none'`).
- **Navigation & permission lockdown:** `setWindowOpenHandler` denies all pop-ups, `will-navigate` blocks all navigation outside `app://lateo/`, and `setPermissionRequestHandler` / `setPermissionCheckHandler` deny all browser permissions.
- **Minimal preload bridge:** `contextBridge.exposeInMainWorld("lateoDesktop", ...)` exposes only `{ version, platform, isSafeStorageAvailable() }` with sender-origin validation in `ipcMain`. Zero Node APIs or filesystem handles are exposed.
- **Direct daemon RPC:** Outbound requests from the sandboxed renderer/worker are validated against `@lateo-wallet/core/node-url` (`validateNodeUrl`) in both the renderer and main process (`webRequest.onBeforeRequest`), allowing direct connections to `https://node.lateo.dev` or custom HTTPS/localhost nodes without browser CORS failures while blocking plain remote HTTP and non-RPC resource types.

## Build & Verification

`pnpm-workspace.yaml` strictly restricts automatic install lifecycle scripts to `esbuild`, so `electron`'s postinstall script does not run automatically during `pnpm install`.

```bash
corepack pnpm build:desktop
corepack pnpm check:security
corepack pnpm verify:desktop
```

`corepack pnpm verify:desktop` verifies the Electron binary (or runs `node apps/desktop/node_modules/electron/install.js` using Electron's built-in `checksums.json` verification into `~/.cache/lateo-wallet-browsers/electron-cache`) and executes an offline headless/`xvfb-run` smoke test covering `app://lateo/`, preload isolation, disposable wallet creation, lock, and cold restart reopen.
