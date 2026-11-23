import {
  TxFlowError,
  VaultAuthError,
  WalletEngine,
  WalletValidationError,
  type CreateWalletResultDto,
  type HostDiagnosticsDto,
  type NodeProbeResultDto,
  type PreparedTxDto,
  type ProofKind,
  type RelayOutcomeDto,
  type ReserveStatusDto,
  type RevealedSecretsDto,
  type SubaddressDto,
  type TxPriorityDto,
  type WalletClient,
  type WalletPrefs,
  type WalletSnapshot,
  type WalletTxDto,
  type ZephyrNetwork
} from "@lateo-wallet/core";
import { IndexedDbVaultStore } from "@lateo-wallet/core/idb";
import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";
import { sanitizeWalletPrefs } from "@lateo-wallet/core/prefs";

const PREFS_STORAGE_KEY = "lateo_desktop_prefs_v1";
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;
const ACTIVITY_THROTTLE_MS = 5_000;
const DEFER_RETRY_MS = 15_000;
const MAX_AUTO_LOCK_DEFERRALS = 15;

export class DesktopClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopClientError";
    this.code = code;
  }
}

function mapEngineError(err: unknown): DesktopClientError {
  if (err instanceof VaultAuthError) {
    return new DesktopClientError(err.code, "Incorrect vault password");
  }
  if (err instanceof TxFlowError) {
    return new DesktopClientError(err.code, err.message);
  }
  if (err instanceof WalletValidationError) {
    return new DesktopClientError(err.code, err.message);
  }
  return new DesktopClientError("ENGINE_ERROR", "Operation failed");
}

function readDesktopPrefs(): WalletPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return sanitizeWalletPrefs(undefined, DEFAULT_PUBLIC_NODE_URL);
    const parsed = JSON.parse(raw) as Partial<WalletPrefs> | null;
    return sanitizeWalletPrefs(
      parsed && typeof parsed === "object" ? parsed : undefined,
      DEFAULT_PUBLIC_NODE_URL
    );
  } catch {
    return sanitizeWalletPrefs(undefined, DEFAULT_PUBLIC_NODE_URL);
  }
}

function writeDesktopPrefs(patch: Partial<WalletPrefs>): WalletPrefs {
  const current = readDesktopPrefs();
  const next = sanitizeWalletPrefs(
    {
      theme: patch.theme !== undefined ? patch.theme : current.theme,
      autoLockMinutes:
        patch.autoLockMinutes !== undefined ? patch.autoLockMinutes : current.autoLockMinutes,
      activePublicNode:
        patch.activePublicNode !== undefined ? patch.activePublicNode : current.activePublicNode,
      customNodes: patch.customNodes !== undefined ? patch.customNodes : current.customNodes
    },
    DEFAULT_PUBLIC_NODE_URL
  );
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }
  return next;
}

/**
 * Sandboxed Electron renderer `WalletClient` backed directly by `WalletEngine`
 * (`proxyToWorker: true`) and origin IndexedDB under `app://lateo`.
 */
export class DesktopWalletClient implements WalletClient {
  readonly defaultNodeUrl = DEFAULT_PUBLIC_NODE_URL;
  private readonly engine: WalletEngine;
  private readonly listeners = new Set<(snapshot: WalletSnapshot) => void>();

  private lastSnapshot: WalletSnapshot | null = null;
  private autoLockMinutes: number;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockDeferrals = 0;
  private lastActivityAt = 0;
  private disposed = false;

  private readonly handleActivityBound: EventListener;
  private readonly handleBeforeUnloadBound: EventListener;

  constructor() {
    const initialPrefs = readDesktopPrefs();
    this.autoLockMinutes = initialPrefs.autoLockMinutes;
    const offlineMode =
      typeof window !== "undefined" && new URLSearchParams(window.location.search).has("offline");

    this.engine = new WalletEngine({
      store: new IndexedDbVaultStore(),
      hostKind: "electron-renderer",
      proxyToWorker: true,
      defaultNodeUrl: initialPrefs.activePublicNode,
      ...(offlineMode
        ? {
            enableBackgroundSync: false,
            fetchDaemonHeight: async () => null
          }
        : {}),
      onSnapshot: (snapshot) => {
        this.onEngineSnapshot(snapshot);
      }
    });

    this.handleActivityBound = () => this.onUserActivity();
    this.handleBeforeUnloadBound = (event: Event) => {
      if (
        Boolean(this.lastSnapshot?.savingState) ||
        Boolean(this.lastSnapshot?.persistFailure) ||
        this.engine.isSavingOrRelayCritical()
      ) {
        event.preventDefault();
        (event as BeforeUnloadEvent).returnValue = "";
      }
    };

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, this.handleActivityBound);
    }
    window.addEventListener("beforeunload", this.handleBeforeUnloadBound);
  }

  private onEngineSnapshot(snapshot: WalletSnapshot): void {
    const wasUnlocked = this.lastSnapshot !== null && !this.lastSnapshot.locked;
    this.lastSnapshot = snapshot;
    if (snapshot.locked) {
      this.clearAutoLockTimer();
      this.autoLockDeferrals = 0;
    } else if (!wasUnlocked) {
      this.lastActivityAt = Date.now();
      this.autoLockDeferrals = 0;
      this.armAutoLock();
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Keep fan-out isolated
      }
    }
  }

  private onUserActivity(): void {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) return;
    const now = Date.now();
    if (now - this.lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    this.lastActivityAt = now;
    this.autoLockDeferrals = 0;
    this.armAutoLock();
  }

  private clearAutoLockTimer(): void {
    if (this.autoLockTimer !== null) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
  }

  private armAutoLock(overrideDelayMs?: number): void {
    this.clearAutoLockTimer();
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) return;
    const delayMs = overrideDelayMs ?? Math.max(1, this.autoLockMinutes) * 60_000;
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = null;
      void this.handleAutoLockFire();
    }, delayMs);
  }

  private async handleAutoLockFire(): Promise<void> {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) return;
    if (this.lastSnapshot.savingState || this.lastSnapshot.persistFailure) {
      this.armAutoLock(DEFER_RETRY_MS);
      return;
    }
    if (this.engine.isSavingOrRelayCritical() && this.autoLockDeferrals < MAX_AUTO_LOCK_DEFERRALS) {
      this.autoLockDeferrals += 1;
      this.armAutoLock(DEFER_RETRY_MS);
      return;
    }
    try {
      await this.engine.lockWallet();
      this.autoLockDeferrals = 0;
    } catch {
      if (!this.disposed && this.lastSnapshot && !this.lastSnapshot.locked) {
        this.armAutoLock(DEFER_RETRY_MS);
      }
    }
  }

  private async run<T>(fn: () => Promise<T>, touch = true): Promise<T> {
    if (touch && this.lastSnapshot && !this.lastSnapshot.locked) {
      this.lastActivityAt = Date.now();
      this.armAutoLock();
    }
    try {
      return await fn();
    } catch (err) {
      throw mapEngineError(err);
    }
  }

  async getSnapshot(): Promise<WalletSnapshot> {
    return this.run(async () => {
      const snap = await this.engine.getSnapshot();
      this.lastSnapshot = snap;
      return snap;
    }, false);
  }

  async getDiagnostics(): Promise<HostDiagnosticsDto> {
    return {
      hostKind: "electron-renderer",
      offscreenExists: false,
      keepAliveActive: false,
      defaultNodeHostPermissionGranted: true,
      grantedOrigins: [DEFAULT_PUBLIC_NODE_URL]
    };
  }

  async getPrefs(): Promise<WalletPrefs> {
    return readDesktopPrefs();
  }

  async updatePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    const next = writeDesktopPrefs(patch);
    this.autoLockMinutes = next.autoLockMinutes;
    if (this.lastSnapshot && !this.lastSnapshot.locked) {
      this.armAutoLock();
    }
    return next;
  }

  createWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: ZephyrNetwork;
  }): Promise<CreateWalletResultDto> {
    return this.run(() => this.engine.createWallet(params));
  }

  restoreFromSeed(params: {
    readonly password: string;
    readonly name: string;
    readonly seed: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.run(() => this.engine.restoreFromSeed(params));
  }

  restoreViewOnly(params: {
    readonly password: string;
    readonly name: string;
    readonly primaryAddress: string;
    readonly privateViewKey: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.run(() => this.engine.restoreViewOnly(params));
  }

  markSeedBackupVerified(): Promise<WalletSnapshot> {
    return this.run(() => this.engine.markSeedBackupVerified());
  }

  unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.run(() => this.engine.unlockWallet(password));
  }

  lockWallet(): Promise<WalletSnapshot> {
    return this.run(async () => {
      const snap = await this.engine.lockWallet();
      this.clearAutoLockTimer();
      return snap;
    }, false);
  }

  changeVaultPassword(params: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    return this.run(() => this.engine.changeVaultPassword(params));
  }

  revealSecrets(password: string): Promise<RevealedSecretsDto> {
    return this.run(() => this.engine.revealSecrets(password));
  }

  resetVault(): Promise<WalletSnapshot> {
    return this.run(async () => {
      await this.engine.resetVault();
      this.clearAutoLockTimer();
      writeDesktopPrefs({ activePublicNode: DEFAULT_PUBLIC_NODE_URL, customNodes: [] });
      return await this.engine.setActiveNode(DEFAULT_PUBLIC_NODE_URL);
    }, false);
  }

  syncNow(): Promise<WalletSnapshot> {
    return this.run(() => this.engine.syncNow());
  }

  refreshReserve(): Promise<ReserveStatusDto | null> {
    return this.run(() => this.engine.refreshReserve());
  }

  probeNode(url: string): Promise<NodeProbeResultDto> {
    return this.run(() => this.engine.probeNode(url));
  }

  switchNode(url: string, saveAsCustom = false): Promise<WalletSnapshot> {
    return this.run(async () => {
      const validated = validateNodeUrl(url);
      const snap = await this.engine.setActiveNode(validated.url);
      const current = readDesktopPrefs();
      writeDesktopPrefs({
        activePublicNode: validated.url,
        customNodes: saveAsCustom ? [...current.customNodes, validated.url] : current.customNodes
      });
      return snap;
    });
  }

  listSubaddresses(): Promise<readonly SubaddressDto[]> {
    return this.run(() => this.engine.listSubaddresses());
  }

  createSubaddress(label?: string): Promise<SubaddressDto> {
    return this.run(() => this.engine.createSubaddress(label));
  }

  setSubaddressLabel(index: number, label: string): Promise<readonly SubaddressDto[]> {
    return this.run(() => this.engine.setSubaddressLabel(index, label));
  }

  getHistory(filter?: {
    readonly asset?: string;
    readonly direction?: "incoming" | "outgoing";
  }): Promise<readonly WalletTxDto[]> {
    return this.run(() => this.engine.getHistory(filter));
  }

  refreshPool(): Promise<{ readonly poolCount: number; readonly txs: readonly WalletTxDto[] }> {
    return this.run(() => this.engine.refreshPool());
  }

  exportTxProof(params: {
    readonly kind: ProofKind;
    readonly txHash: string;
    readonly address?: string;
    readonly message?: string;
  }): Promise<string> {
    return this.run(() => this.engine.exportTxProof(params));
  }

  prepareTransfer(params: {
    readonly asset: string;
    readonly destinations: readonly { readonly address: string; readonly amount: string }[];
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.run(() => this.engine.prepareTransfer(params));
  }

  prepareSweep(params: {
    readonly asset: string;
    readonly address: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.run(() => this.engine.prepareSweep(params));
  }

  prepareConversion(params: {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly amount: string;
    readonly address?: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.run(() => this.engine.prepareConversion(params));
  }

  relayPrepared(token: string): Promise<RelayOutcomeDto> {
    return this.run(() => this.engine.relayPrepared(token));
  }

  discardPrepared(token: string, verify = false): Promise<WalletSnapshot> {
    return this.run(() => this.engine.discardPrepared(token, verify));
  }

  retryPersist(): Promise<WalletSnapshot> {
    return this.run(() => this.engine.retryPersist());
  }

  clearUnresolvedRelay(): Promise<WalletSnapshot> {
    return this.run(() => this.engine.clearUnresolvedRelay());
  }

  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
