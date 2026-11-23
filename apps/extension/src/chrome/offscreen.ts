import type { EngineRequest } from "@lateo-wallet/core/rpc";
import { ExtensionEngineHost } from "../shared/engine-host.js";

const port = chrome.runtime.connect({ name: "lateo-engine" });

const host = new ExtensionEngineHost({
  hostKind: "chrome-offscreen",
  onSnapshot: (snapshot) => {
    try {
      port.postMessage({ type: "SNAPSHOT_UPDATED", snapshot });
    } catch {
      // Service worker closed port during teardown
    }
  }
});

port.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== "object" || !("type" in msg) || !("id" in msg)) return;
  void host.handleRequest(msg as EngineRequest).then((res) => {
    try {
      port.postMessage(res);
    } catch {
      // Port disconnected
    }
  });
});
