import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  type IpcMainInvokeEvent
} from "electron";
import { DESKTOP_IPC_CHANNELS } from "../shared/bridge.js";
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  buildStaticFileMap,
  DEFAULT_DAEMON_ORIGIN,
  DESKTOP_PAGE_CSP,
  DESKTOP_WORKER_CSP,
  isAllowedAppNavigation,
  isAllowedDaemonRequest,
  isWorkerAssetPath,
  resolveDaemonOrigin,
  shouldCancelDaemonRedirect,
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

const PROBE_ORIGIN_TTL_MS = 30_000;

const argv = process.argv.slice(1);
const OFFLINE_MODE = argv.includes("--offline");
const HEADLESS_SMOKE = !app.isPackaged && argv.includes("--headless-smoke");

if (!app.isPackaged) {
  const userDataArgIdx = argv.findIndex((a) => a === "--user-data-dir");
  const userDataEq = argv.find((a) => a.startsWith("--user-data-dir="));
  const customUserDataDir =
    userDataEq !== undefined
      ? userDataEq.slice("--user-data-dir=".length)
      : userDataArgIdx >= 0
        ? argv[userDataArgIdx + 1]
        : undefined;

  if (customUserDataDir && !customUserDataDir.startsWith("-")) {
    app.setPath("userData", path.resolve(customUserDataDir));
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});

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

let activeDaemonOrigin: string = DEFAULT_DAEMON_ORIGIN;
let probeDaemonLease: { readonly origin: string; readonly expiresAt: number } | null = null;

function getAuthorizedDaemonOrigins(): ReadonlySet<string> {
  const origins = new Set<string>([DEFAULT_DAEMON_ORIGIN, activeDaemonOrigin]);
  if (probeDaemonLease) {
    if (Date.now() < probeDaemonLease.expiresAt) {
      origins.add(probeDaemonLease.origin);
    } else {
      probeDaemonLease = null;
    }
  }
  return origins;
}

function isAuthorizedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  return isAllowedAppNavigation(event.senderFrame.url);
}

function configureApplicationMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { role: "quit" }]
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" }
          ]
        }
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }
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
      return new Response("Not found", {
        status: 404,
        headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = files.get(reqPath);
    if (!resolved) {
      return new Response("Not found", {
        status: 404,
        headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const ext = path.extname(resolved);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": contentType }
      });
    }

    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, {
        status: 200,
        headers: { ...baseHeaders, "Content-Type": contentType }
      });
    } catch {
      return new Response("Internal error", {
        status: 500,
        headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  });
}

function configureSessionGuards(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedDaemonRequest(
      {
        url: details.url,
        resourceType: details.resourceType,
        method: details.method,
        ...(details.initiatorOrigin !== undefined ? { initiatorOrigin: details.initiatorOrigin } : {})
      },
      getAuthorizedDaemonOrigins(),
      OFFLINE_MODE
    );
    if (allowed) {
      callback({});
      return;
    }
    callback({ cancel: true });
  });

  // Enable direct daemon RPC strictly for authorized daemon origins and cancel 3xx redirects.
  ses.webRequest.onHeadersReceived(
    { urls: ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"] },
    (details, callback) => {
      if (shouldCancelDaemonRedirect(details.url, details.statusCode)) {
        callback({ cancel: true });
        return;
      }
      const allowed = isAllowedDaemonRequest(
        {
          url: details.url,
          resourceType: details.resourceType,
          method: details.method,
          ...(details.initiatorOrigin !== undefined ? { initiatorOrigin: details.initiatorOrigin } : {})
        },
        getAuthorizedDaemonOrigins(),
        OFFLINE_MODE
      );
      if (!allowed) {
        callback({ cancel: true });
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
    if (!isAuthorizedIpcSender(event)) {
      return false;
    }
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.AUTHORIZE_NODE_ORIGIN, (event, payload: unknown) => {
    if (!isAuthorizedIpcSender(event)) {
      return false;
    }
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const { url, scope } = payload as { url?: unknown; scope?: unknown };
    if (typeof url !== "string" || (scope !== "active" && scope !== "probe")) {
      return false;
    }
    const origin = resolveDaemonOrigin(url);
    if (!origin) {
      return false;
    }
    if (scope === "active") {
      activeDaemonOrigin = origin;
    } else {
      probeDaemonLease = { origin, expiresAt: Date.now() + PROBE_ORIGIN_TTL_MS };
    }
    return true;
  });
}

function registerPowerMonitorGuards(): void {
  const notifyLock = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(DESKTOP_IPC_CHANNELS.SYSTEM_LOCK_REQUEST);
      }
    }
  };
  powerMonitor.on("suspend", notifyLock);
  powerMonitor.on("lock-screen", notifyLock);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 420,
    minHeight: 580,
    show: !HEADLESS_SMOKE,
    title: "Lateo Wallet",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false,
      enableWebSQL: false,
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
  win.webContents.on("will-frame-navigate", (event) => {
    if (!isAllowedAppNavigation(event.url)) {
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
  configureApplicationMenu();
  registerAppProtocol();
  configureSessionGuards();
  registerIpcHandlers();
  registerPowerMonitorGuards();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
