import type {
  CreateWalletResultDto,
  EngineEvent,
  EngineRequest,
  EngineResponse,
  HostDiagnosticsDto,
  WalletSnapshot
} from "@lateo-wallet/core/rpc";
import { ExtensionEngineHost } from "../shared/engine-host.js";
import { ExtensionPrefsStore } from "../shared/prefs-store.js";

const AUTO_LOCK_ALARM = "lateo-idle-autolock";
const DEFAULT_NODE_ORIGIN = "https://node.lateo.dev/*";

const uiPorts = new Set<chrome.runtime.Port>();
const prefsStore = new ExtensionPrefsStore();

let keepAlivePort: chrome.runtime.Port | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let walletUnlocked = false;

function broadcastEvent(event: EngineEvent): void {
  for (const port of uiPorts) {
    try {
      port.postMessage(event);
    } catch {
      uiPorts.delete(port);
    }
  }
}

/**
 * Maintain an active runtime.Port + periodic runtime ping while the wallet is
 * unlocked or executing a sync/relay->getData persistence sequence so Firefox
 * MV3 does not suspend the Event Page mid-operation.
 */
function updateKeepAlive(active: boolean): void {
  if (active) {
    if (!keepAlivePort) {
      keepAlivePort = chrome.runtime.connect({ name: "lateo-firefox-keepalive" });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
    }
    if (!keepAliveInterval) {
      keepAliveInterval = setInterval(() => {
        try {
          keepAlivePort?.postMessage({ ping: Date.now() });
        } catch {
          keepAlivePort = null;
        }
        void chrome.runtime.getPlatformInfo();
      }, 20_000);
    }
  } else {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (keepAlivePort) {
      try {
        keepAlivePort.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      keepAlivePort = null;
    }
  }
}

function isKeepAliveActive(): boolean {
  return keepAlivePort !== null || uiPorts.size > 0;
}

const host = new ExtensionEngineHost({
  hostKind: "firefox-event-page",
  onSnapshot: (snapshot) => {
    walletUnlocked = !snapshot.locked;
    updateKeepAlive(walletUnlocked || host.isBusy());
    broadcastEvent({
      type: "SNAPSHOT_UPDATED",
      snapshot: { ...snapshot, keepAliveActive: isKeepAliveActive() }
    });
  },
  onBusyChange: (busy) => {
    updateKeepAlive(walletUnlocked || busy);
  }
});

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

async function getDiagnostics(): Promise<HostDiagnosticsDto> {
  const perms = await chrome.permissions.getAll();
  const grantedOrigins = perms.origins ?? [];
  const defaultNodeHostPermissionGranted = await chrome.permissions.contains({
    origins: [DEFAULT_NODE_ORIGIN]
  });
  return {
    hostKind: "firefox-event-page",
    offscreenExists: false,
    keepAliveActive: isKeepAliveActive(),
    defaultNodeHostPermissionGranted,
    grantedOrigins
  };
}

async function handleRequest(req: EngineRequest): Promise<EngineResponse> {
  if (req.type === "GET_DIAGNOSTICS") {
    return { id: req.id, ok: true, result: await getDiagnostics() };
  }

  if (req.type === "GET_PREFS") {
    return { id: req.id, ok: true, result: await prefsStore.readPrefs() };
  }

  if (req.type === "UPDATE_PREFS") {
    const updated = await prefsStore.writePrefs(req.patch);
    if (walletUnlocked && req.patch.autoLockMinutes !== undefined) {
      await resetAutoLockAlarm();
    }
    return { id: req.id, ok: true, result: updated };
  }

  const res = await host.handleRequest(req);
  if (!res.ok) return res;

  if (req.type === "CHANGE_VAULT_PASSWORD" || req.type === "REVEAL_SECRETS") {
    if (walletUnlocked) await resetAutoLockAlarm();
    return res;
  }

  if (req.type === "CREATE_WALLET") {
    const created = res.result as CreateWalletResultDto;
    walletUnlocked = !created.snapshot.locked;
    if (walletUnlocked) await resetAutoLockAlarm();
    updateKeepAlive(walletUnlocked || host.isBusy());
    const enrichedSnap: WalletSnapshot = {
      ...created.snapshot,
      keepAliveActive: isKeepAliveActive()
    };
    broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: enrichedSnap });
    return { id: req.id, ok: true, result: { ...created, snapshot: enrichedSnap } };
  }

  const snap = res.result as WalletSnapshot;
  walletUnlocked = !snap.locked;
  if (walletUnlocked) {
    await resetAutoLockAlarm();
  } else {
    await clearAutoLockAlarm();
  }
  updateKeepAlive(walletUnlocked || host.isBusy());
  const enriched: WalletSnapshot = { ...snap, keepAliveActive: isKeepAliveActive() };
  if (req.type !== "GET_SNAPSHOT") {
    broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: enriched });
  }
  return { id: req.id, ok: true, result: enriched };
}

chrome.runtime.onConnect.addListener((port) => {
  // Defense-in-depth sender validation: only accept ports from this extension
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }

  const extOriginPrefix = chrome.runtime.getURL("");

  if (port.name === "lateo-firefox-keepalive") {
    port.onMessage.addListener(() => {
      // Keep-alive heartbeat acknowledged
    });
    return;
  }

  if (port.name === "lateo-ui") {
    if (!port.sender.url || !port.sender.url.startsWith(extOriginPrefix)) {
      port.disconnect();
      return;
    }

    uiPorts.add(port);
    port.onMessage.addListener((msg: unknown) => {
      if (!msg || typeof msg !== "object" || !("type" in msg) || !("id" in msg)) return;
      void handleRequest(msg as EngineRequest).then((res) => {
        try {
          port.postMessage(res);
        } catch {
          uiPorts.delete(port);
        }
      });
    });
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
      updateKeepAlive(walletUnlocked || host.isBusy());
    });
    return;
  }

  port.disconnect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void handleRequest({ id: `alarm-${Date.now()}`, type: "LOCK_WALLET" });
});
