import type {
  EngineEvent,
  EngineRequest,
  EngineResponse,
  HostDiagnosticsDto,
  WalletSnapshot
} from "@lateo-wallet/core/rpc";
import { IndexedDbVaultStore } from "../shared/idb-store.js";
import { ExtensionPrefsStore } from "../shared/prefs-store.js";

const OFFSCREEN_URL = "offscreen.html";
const AUTO_LOCK_ALARM = "lateo-idle-autolock";
const DEFAULT_NODE_ORIGIN = "https://node.lateo.dev/*";

const uiPorts = new Set<chrome.runtime.Port>();
const idbStore = new IndexedDbVaultStore();
const prefsStore = new ExtensionPrefsStore();

let enginePort: chrome.runtime.Port | null = null;
let enginePortWaiters: Array<(port: chrome.runtime.Port) => void> = [];
let creatingOffscreen: Promise<void> | null = null;

const pendingEngineCalls = new Map<
  string,
  {
    readonly resolve: (res: EngineResponse) => void;
    readonly reject: (err: Error) => void;
  }
>();

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenEnginePort(): Promise<chrome.runtime.Port> {
  if (enginePort) return enginePort;

  const portPromise = new Promise<chrome.runtime.Port>((resolve) => {
    enginePortWaiters.push(resolve);
  });

  if (!(await hasOffscreenDocument())) {
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen
        .createDocument({
          url: OFFSCREEN_URL,
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: "Run Zephyr WebAssembly wallet engine in a dedicated Web Worker"
        })
        .finally(() => {
          creatingOffscreen = null;
        });
    }
    await creatingOffscreen;
  }

  return enginePort ?? portPromise;
}

async function closeOffscreenDocument(): Promise<void> {
  if (enginePort) {
    try {
      enginePort.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }
    enginePort = null;
  }
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function resetAutoLockAlarm(): Promise<void> {
  const prefs = await prefsStore.readPrefs();
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await chrome.alarms.create(AUTO_LOCK_ALARM, {
    delayInMinutes: Math.max(1, prefs.autoLockMinutes)
  });
}

async function clearAutoLockAlarm(): Promise<void> {
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
}

function broadcastEvent(event: EngineEvent): void {
  for (const port of uiPorts) {
    try {
      port.postMessage(event);
    } catch {
      uiPorts.delete(port);
    }
  }
}

async function forwardToEngine(req: EngineRequest): Promise<EngineResponse> {
  const port = await ensureOffscreenEnginePort();
  return new Promise<EngineResponse>((resolve, reject) => {
    pendingEngineCalls.set(req.id, { resolve, reject });
    port.postMessage(req);
  });
}

async function buildLockedSnapshot(): Promise<WalletSnapshot> {
  const meta = await idbStore.readMeta();
  return {
    hasVault: meta !== undefined,
    locked: true,
    savingState: false,
    activeWallet: null,
    balances: [],
    lastPersistedAt: meta?.updatedAt ?? null,
    hostKind: "chrome-offscreen",
    offscreenActive: false
  };
}

async function getDiagnostics(): Promise<HostDiagnosticsDto> {
  const offscreenExists = await hasOffscreenDocument();
  const perms = await chrome.permissions.getAll();
  const grantedOrigins = perms.origins ?? [];
  const defaultNodeHostPermissionGranted = await chrome.permissions.contains({
    origins: [DEFAULT_NODE_ORIGIN]
  });
  return {
    hostKind: "chrome-offscreen",
    offscreenExists,
    keepAliveActive: offscreenExists,
    defaultNodeHostPermissionGranted,
    grantedOrigins
  };
}

async function handleUiRequest(req: EngineRequest): Promise<EngineResponse> {
  try {
    if (req.type === "GET_DIAGNOSTICS") {
      return { id: req.id, ok: true, result: await getDiagnostics() };
    }

    if (req.type === "GET_SNAPSHOT") {
      if (!(await hasOffscreenDocument())) {
        return { id: req.id, ok: true, result: await buildLockedSnapshot() };
      }
      const res = await forwardToEngine(req);
      if (res.ok) {
        const snap = { ...(res.result as WalletSnapshot), offscreenActive: true };
        return { id: req.id, ok: true, result: snap };
      }
      return res;
    }

    if (req.type === "LOCK_WALLET") {
      if (await hasOffscreenDocument()) {
        await forwardToEngine(req);
      }
      await closeOffscreenDocument();
      await clearAutoLockAlarm();
      const lockedSnap = await buildLockedSnapshot();
      broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: lockedSnap });
      return { id: req.id, ok: true, result: lockedSnap };
    }

    if (req.type === "RESET_VAULT") {
      if (await hasOffscreenDocument()) {
        await forwardToEngine(req);
        await closeOffscreenDocument();
      } else {
        await idbStore.clearAll();
      }
      await clearAutoLockAlarm();
      const emptySnap = await buildLockedSnapshot();
      broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: emptySnap });
      return { id: req.id, ok: true, result: emptySnap };
    }

    // CREATE_DISPOSABLE_WALLET or UNLOCK_WALLET
    const res = await forwardToEngine(req);
    if (res.ok) {
      await resetAutoLockAlarm();
      const snap = { ...(res.result as WalletSnapshot), offscreenActive: true };
      broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: snap });
      return { id: req.id, ok: true, result: snap };
    }
    return res;
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: {
        code: "SW_ERROR",
        message: err instanceof Error ? err.message : "Service worker request failed"
      }
    };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "lateo-engine") {
    enginePort = port;
    for (const waiter of enginePortWaiters) {
      waiter(port);
    }
    enginePortWaiters = [];

    port.onMessage.addListener((msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      if ("type" in msg && (msg as EngineEvent).type === "SNAPSHOT_UPDATED") {
        const ev = msg as EngineEvent;
        broadcastEvent({
          type: "SNAPSHOT_UPDATED",
          snapshot: { ...ev.snapshot, offscreenActive: true }
        });
        return;
      }
      if ("id" in msg && "ok" in msg) {
        const res = msg as EngineResponse;
        const pending = pendingEngineCalls.get(res.id);
        if (pending) {
          pendingEngineCalls.delete(res.id);
          pending.resolve(res);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (enginePort === port) enginePort = null;
      for (const [, pending] of pendingEngineCalls) {
        pending.reject(new Error("Offscreen engine disconnected"));
      }
      pendingEngineCalls.clear();
    });
    return;
  }

  if (port.name === "lateo-ui") {
    uiPorts.add(port);
    port.onMessage.addListener((msg: unknown) => {
      if (!msg || typeof msg !== "object" || !("type" in msg) || !("id" in msg)) return;
      void handleUiRequest(msg as EngineRequest).then((res) => {
        try {
          port.postMessage(res);
        } catch {
          uiPorts.delete(port);
        }
      });
    });
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void handleUiRequest({ id: `alarm-${Date.now()}`, type: "LOCK_WALLET" });
});
