import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, safeStorage, session } from "electron";
import { DESKTOP_IPC_CHANNELS } from "../shared/bridge.js";
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  DESKTOP_PAGE_CSP,
  DESKTOP_WORKER_CSP,
  isAllowedAppNavigation,
  isAllowedDaemonRequest,
  isWorkerAssetPath,
  withDaemonCorsHeaders
} from "./security.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

const argv = process.argv.slice(1);
const OFFLINE_MODE = argv.includes("--offline");
const userDataArgIdx = argv.findIndex((a) => a === "--user-data-dir");
const userDataEq = argv.find((a) => a.startsWith("--user-data-dir="));
const customUserDataDir =
  userDataEq !== undefined
    ? userDataEq.slice("--user-data-dir=".length)
    : userDataArgIdx >= 0
      ? argv[userDataArgIdx + 1]
      : undefined;

if (customUserDataDir) {
  app.setPath("userData", path.resolve(customUserDataDir));
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

if (argv.includes("--disable-gpu") || OFFLINE_MODE) {
  app.disableHardwareAcceleration();
}

const RENDERER_ROOT = path.resolve(__dirname, "../renderer");
const PRELOAD_PATH = path.resolve(__dirname, "../preload/preload.cjs");

function buildStaticFileMap(rootDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = "/" + path.relative(rootDir, full).split(path.sep).join("/");
        map.set(rel, full);
      }
    }
  };
  walk(rootDir);
  return map;
}

function registerAppProtocol(): void {
  const files = buildStaticFileMap(RENDERER_ROOT);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const isWorker = isWorkerAssetPath(url.pathname);
    const baseHeaders: Record<string, string> = {
      "Content-Security-Policy": isWorker ? DESKTOP_WORKER_CSP : DESKTOP_PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store"
    };

    if (url.hostname !== APP_HOST || (request.method !== "GET" && request.method !== "HEAD")) {
      return new Response("Not found", { status: 404, headers: baseHeaders });
    }

    const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = files.get(reqPath);
    if (!resolved) {
      return new Response("Not found", { status: 404, headers: baseHeaders });
    }

    const ext = path.extname(resolved);
    const data = fs.readFileSync(resolved);
    return new Response(data, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream"
      }
    });
  });
}

function configureSessionGuards(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (isAllowedDaemonRequest(details.url, details.resourceType, OFFLINE_MODE)) {
      callback({});
      return;
    }
    callback({ cancel: true });
  });

  // Enable direct daemon RPC from the sandboxed app:// renderer without browser CORS failures.
  ses.webRequest.onHeadersReceived(
    { urls: ["https://*/*", "http://127.0.0.1/*", "http://localhost/*", "http://[::1]/*"] },
    (details, callback) => {
      if (!isAllowedDaemonRequest(details.url, details.resourceType, OFFLINE_MODE)) {
        callback({});
        return;
      }
      callback({
        responseHeaders: withDaemonCorsHeaders(details.responseHeaders)
      });
    }
  );
}

function registerIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.SAFE_STORAGE_AVAILABLE, (event) => {
    const senderUrl = event.senderFrame?.url ?? "";
    if (!isAllowedAppNavigation(senderUrl)) {
      return false;
    }
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 420,
    minHeight: 580,
    show: !argv.includes("--headless-smoke"),
    title: "Lateo Wallet",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: PRELOAD_PATH
    }
  });

  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedAppNavigation(targetUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  const targetUrl = OFFLINE_MODE ? `${APP_ORIGIN}/index.html?offline` : `${APP_ORIGIN}/index.html`;
  void win.loadURL(targetUrl);
  return win;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.whenReady().then(() => {
  registerAppProtocol();
  configureSessionGuards();
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
