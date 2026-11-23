export const DESKTOP_IPC_CHANNELS = Object.freeze({
  SAFE_STORAGE_AVAILABLE: "lateo:desktop:safe-storage-available",
  AUTHORIZE_NODE_ORIGIN: "lateo:desktop:authorize-node-origin",
  SYSTEM_LOCK_REQUEST: "lateo:desktop:system-lock-request"
});

export type NodeAuthorizationScope = "active" | "probe";

export interface LateoDesktopBridge {
  readonly version: string;
  readonly platform: string;
  isSafeStorageAvailable(): Promise<boolean>;
  authorizeNodeOrigin(url: string, scope: NodeAuthorizationScope): Promise<boolean>;
  onSystemLockRequest(callback: () => void): () => void;
}

declare global {
  interface Window {
    readonly lateoDesktop?: LateoDesktopBridge;
  }
}
