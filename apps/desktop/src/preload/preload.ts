import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS, type LateoDesktopBridge } from "../shared/bridge.js";

const APP_VERSION = "0.1.0";

const bridge: LateoDesktopBridge = Object.freeze({
  version: APP_VERSION,
  platform: process.platform,
  async isSafeStorageAvailable(): Promise<boolean> {
    const res = await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.SAFE_STORAGE_AVAILABLE);
    return Boolean(res);
  }
});

contextBridge.exposeInMainWorld("lateoDesktop", bridge);
