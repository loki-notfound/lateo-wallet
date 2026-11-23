import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";
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
const MAX_AUTO_LOCK_DEFERRALS = 15;

const uiPorts = new Set<chrome.runtime.Port>();
const prefsStore = new ExtensionPrefsStore();

let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let walletUnlocked = false;
let autoLockDeferrals = 0;

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
 * Maintain a periodic runtime API heartbeat while the wallet is unlocked or
 * executing sync/checkpoint/relay persistence so Firefox MV3 does not suspend
 * the Event Page mid-operation.
 */
function updateKeepAlive(active: boolean): void {
  if (active) {
    if (!keepAliveInterval) {
      keepAliveInterval = setInterval(() => {
        void chrome.runtime.getPlatformInfo().catch(() => {});
      }, 20_000);
    }
  } else if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function isKeepAliveActive(): boolean {
  return keepAliveInterval !== null || uiPorts.size > 0;
}

const host = new ExtensionEngineHost({
  hostKind: "firefox-event-page",
  checkOriginPermission: (originPattern) =>
    chrome.permissions.contains({ origins: [originPattern] }).catch(() => false),
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

// Apply any persisted custom node URL on Event Page startup before serving requests.
const initialNodeLoaded: Promise<void> = prefsStore
  .readPrefs()
  .then((prefs) => {
    if (prefs.activePublicNode) {
      host.setInitialNodeUrl(prefs.activePublicNode);
    }
  })
  .catch(() => {});

async function resetAutoLockAlarm(overrideMinutes?: number): Promise<void> {
  const delayInMinutes =
    overrideMinutes !== undefined
      ? Math.max(1, overrideMinutes)
      : Math.max(1, (await prefsStore.readPrefs()).autoLockMinutes);
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes });
}

async function resetAutoLockAlarmBestEffort(overrideMinutes?: number): Promise<void> {
  try {
    await resetAutoLockAlarm(overrideMinutes);
  } catch {
    // Never mask a completed engine operation (such as a relayed tx) on alarm API errors
  }
}

async function clearAutoLockAlarmBestEffort(): Promise<void> {
  try {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  } catch {
    // Best-effort alarm clear
  }
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
  try {
    await initialNodeLoaded;

    if (req.type === "GET_DIAGNOSTICS") {
      return { id: req.id, ok: true, result: await getDiagnostics() };
    }

    if (req.type === "GET_PREFS") {
      return { id: req.id, ok: true, result: await prefsStore.readPrefs() };
    }

    if (req.type === "UPDATE_PREFS") {
      const updated = await prefsStore.writePrefs(req.patch);
      if (walletUnlocked && req.patch.autoLockMinutes !== undefined) {
        await resetAutoLockAlarmBestEffort();
      }
      return { id: req.id, ok: true, result: updated };
    }

    if (req.type === "SWITCH_NODE") {
      let validated;
      try {
        validated = validateNodeUrl(req.url);
      } catch (err) {
        return {
          id: req.id,
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: err instanceof Error ? err.message : "Invalid node URL"
          }
        };
      }
      const prefs = await prefsStore.readPrefs();
      const customNodes =
        req.saveAsCustom &&
        validated.url !== DEFAULT_PUBLIC_NODE_URL &&
        !prefs.customNodes.includes(validated.url)
          ? [...prefs.customNodes, validated.url]
          : prefs.customNodes;
      await prefsStore.writePrefs({ activePublicNode: validated.url, customNodes });
    }

    const res = await host.handleRequest(req);
    if (!res.ok) return res;

    if (req.type === "RESET_VAULT") {
      await prefsStore
        .writePrefs({ activePublicNode: DEFAULT_PUBLIC_NODE_URL, customNodes: [] })
        .catch(() => {});
    }

    if (
      req.type === "CHANGE_VAULT_PASSWORD" ||
      req.type === "REVEAL_SECRETS" ||
      req.type === "REFRESH_RESERVE" ||
      req.type === "PROBE_NODE" ||
      req.type === "LIST_SUBADDRESSES" ||
      req.type === "CREATE_SUBADDRESS" ||
      req.type === "SET_SUBADDRESS_LABEL" ||
      req.type === "GET_HISTORY" ||
      req.type === "REFRESH_POOL" ||
      req.type === "EXPORT_TX_PROOF" ||
      req.type === "PREPARE_TRANSFER" ||
      req.type === "PREPARE_SWEEP" ||
      req.type === "PREPARE_CONVERSION" ||
      req.type === "RELAY_PREPARED"
    ) {
      if (walletUnlocked) {
        autoLockDeferrals = 0;
        await resetAutoLockAlarmBestEffort();
      }
      updateKeepAlive(walletUnlocked || host.isBusy());
      return res;
    }

    if (req.type === "CREATE_WALLET") {
      const created = res.result as CreateWalletResultDto;
      walletUnlocked = !created.snapshot.locked;
      if (walletUnlocked) {
        autoLockDeferrals = 0;
        await resetAutoLockAlarmBestEffort();
      }
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
      autoLockDeferrals = 0;
      await resetAutoLockAlarmBestEffort();
    } else {
      autoLockDeferrals = 0;
      await clearAutoLockAlarmBestEffort();
    }
    updateKeepAlive(walletUnlocked || host.isBusy());
    const enriched: WalletSnapshot = { ...snap, keepAliveActive: isKeepAliveActive() };
    if (req.type !== "GET_SNAPSHOT") {
      broadcastEvent({ type: "SNAPSHOT_UPDATED", snapshot: enriched });
    }
    return { id: req.id, ok: true, result: enriched };
  } catch {
    return {
      id: req.id,
      ok: false,
      error: {
        code: "HOST_ERROR",
        message: "Background request failed"
      }
    };
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }

  const extOriginPrefix = chrome.runtime.getURL("");

  if (port.name === "lateo-ui") {
    if (!port.sender.url || !port.sender.url.startsWith(extOriginPrefix)) {
      port.disconnect();
      return;
    }

    uiPorts.add(port);
    port.onMessage.addListener((msg: unknown) => {
      if (
        !msg ||
        typeof msg !== "object" ||
        !("type" in msg) ||
        typeof (msg as { type: unknown }).type !== "string" ||
        !("id" in msg) ||
        typeof (msg as { id: unknown }).id !== "string"
      ) {
        return;
      }
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
      if (uiPorts.size === 0 && walletUnlocked && !host.isSavingOrRelayCritical()) {
        void host
          .handleRequest({
            id: `disconnect-release-${Date.now()}`,
            type: "RELEASE_PREPARED"
          })
          .catch(() => {});
      }
      updateKeepAlive(walletUnlocked || host.isBusy());
    });
    return;
  }

  port.disconnect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  // Defer auto-lock ONLY on critical post-relay/relay-in-flight barriers, never on routine sync ticks.
  if (host.isSavingOrRelayCritical() && autoLockDeferrals < MAX_AUTO_LOCK_DEFERRALS) {
    autoLockDeferrals += 1;
    void resetAutoLockAlarmBestEffort(1);
    return;
  }
  void handleRequest({ id: `alarm-${Date.now()}`, type: "LOCK_WALLET" }).then((res) => {
    if (!res.ok) {
      autoLockDeferrals += 1;
      void resetAutoLockAlarmBestEffort(1);
    } else {
      autoLockDeferrals = 0;
    }
  });
});

if (typeof chrome.runtime.onSuspend?.addListener === "function") {
  chrome.runtime.onSuspend.addListener(() => {
    updateKeepAlive(false);
  });
}
