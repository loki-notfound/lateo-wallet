import type { EngineRequest } from "@lateo-wallet/core/rpc";
import { ExtensionEngineHost } from "../shared/engine-host.js";

const port = chrome.runtime.connect({ name: "lateo-engine" });

let permSeq = 0;
const pendingPermChecks = new Map<string, (granted: boolean) => void>();

function checkOriginPermission(originPattern: string): Promise<boolean> {
  const id = `perm-${++permSeq}`;
  return new Promise<boolean>((resolve) => {
    pendingPermChecks.set(id, resolve);
    try {
      port.postMessage({ type: "CHECK_ORIGIN_PERMISSION", id, originPattern });
    } catch {
      pendingPermChecks.delete(id);
      resolve(false);
    }
  });
}

const host = new ExtensionEngineHost({
  hostKind: "chrome-offscreen",
  checkOriginPermission,
  onSnapshot: (snapshot) => {
    try {
      port.postMessage({ type: "SNAPSHOT_UPDATED", snapshot });
    } catch {
      // Service worker closed port during teardown
    }
  }
});

port.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== "object") return;
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
    try {
      port.postMessage(res);
    } catch {
      // Port disconnected
    }
  });
});
