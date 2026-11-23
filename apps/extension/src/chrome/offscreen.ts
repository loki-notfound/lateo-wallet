import type { EngineRequest } from "@lateo-wallet/core/rpc";
import { ExtensionEngineHost } from "../shared/engine-host.js";

const INITIAL_RECONNECT_DELAY_MS = 150;
const MAX_RECONNECT_DELAY_MS = 2_000;

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let permSeq = 0;
const pendingPermChecks = new Map<string, (granted: boolean) => void>();

function postSafe(message: unknown): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function checkOriginPermission(originPattern: string): Promise<boolean> {
  if (!port) return Promise.resolve(false);
  const id = `perm-${++permSeq}`;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPermChecks.delete(id)) {
        resolve(false);
      }
    }, 5_000);
    pendingPermChecks.set(id, (granted) => {
      clearTimeout(timer);
      resolve(granted);
    });
    if (!postSafe({ type: "CHECK_ORIGIN_PERMISSION", id, originPattern })) {
      clearTimeout(timer);
      pendingPermChecks.delete(id);
      resolve(false);
    }
  });
}

const host = new ExtensionEngineHost({
  hostKind: "chrome-offscreen",
  checkOriginPermission,
  onSnapshot: (snapshot) => {
    postSafe({ type: "SNAPSHOT_UPDATED", snapshot });
  }
});

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelayMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPort(true);
  }, delay);
}

function connectPort(isReconnect: boolean): void {
  if (port) return;
  let nextPort: chrome.runtime.Port;
  try {
    nextPort = chrome.runtime.connect({ name: "lateo-engine" });
  } catch {
    scheduleReconnect();
    return;
  }
  port = nextPort;
  reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

  nextPort.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    if (
      "type" in msg &&
      (msg as { type: string }).type === "INIT_NODE" &&
      "url" in msg &&
      typeof (msg as { url: unknown }).url === "string"
    ) {
      host.setInitialNodeUrl((msg as { url: string }).url);
      return;
    }
    if (
      "type" in msg &&
      (msg as { type: string }).type === "ORIGIN_PERMISSION_RESULT" &&
      "id" in msg &&
      "granted" in msg
    ) {
      const res = msg as { id: string; granted: boolean };
      const resolver = pendingPermChecks.get(res.id);
      if (resolver) {
        pendingPermChecks.delete(res.id);
        resolver(Boolean(res.granted));
      }
      return;
    }

    if (!("type" in msg) || !("id" in msg)) return;
    void host.handleRequest(msg as EngineRequest).then((res) => {
      postSafe(res);
    });
  });

  nextPort.onDisconnect.addListener(() => {
    if (port === nextPort) {
      port = null;
    }
    for (const [, resolver] of pendingPermChecks) {
      resolver(false);
    }
    pendingPermChecks.clear();
    // Reconnect automatically if the MV3 service worker restarted while this offscreen document stayed alive.
    scheduleReconnect();
  });

  if (isReconnect) {
    // Re-sync unlocked/saving flags to the freshly restarted service worker.
    void host
      .getSnapshot()
      .then((snapshot) => {
        postSafe({ type: "SNAPSHOT_UPDATED", snapshot });
      })
      .catch(() => {});
  }
}

connectPort(false);
