import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_IPC_CHANNELS,
  type LateoDesktopBridge,
  type NodeAuthorizationScope
} from "../shared/bridge.js";

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.1.0";

const bridge: LateoDesktopBridge = Object.freeze({
  version: APP_VERSION,
  platform: process.platform,
  async isSafeStorageAvailable(): Promise<boolean> {
    const res = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.SAFE_STORAGE_AVAILABLE);
    return Boolean(res);
  },
  async authorizeNodeOrigin(url: string, scope: NodeAuthorizationScope): Promise<boolean> {
    if (typeof url !== "string" || (scope !== "active" && scope !== "probe")) {
      return false;
    }
    const res = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.AUTHORIZE_NODE_ORIGIN, {
      url,
      scope
    });
    return Boolean(res);
  },
  onSystemLockRequest(callback: () => void): () => void {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (): void => {
      try {
        callback();
      } catch {
        // Keep listener failures isolated
      }
    };
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.SYSTEM_LOCK_REQUEST, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.SYSTEM_LOCK_REQUEST, handler);
    };
  }
});

contextBridge.exposeInMainWorld("lateoDesktop", bridge);
