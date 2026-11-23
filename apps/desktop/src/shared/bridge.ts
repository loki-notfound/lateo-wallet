export const DESKTOP_IPC_CHANNELS = Object.freeze({
  SAFE_STORAGE_AVAILABLE: "lateo:desktop:safe-storage-available",
  APP_INFO: "lateo:desktop:app-info"
});

export interface LateoDesktopBridge {
  readonly version: string;
  readonly platform: string;
  isSafeStorageAvailable(): Promise<boolean>;
}

declare global {
  interface Window {
    readonly lateoDesktop?: LateoDesktopBridge;
  }
}
