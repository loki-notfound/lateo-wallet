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
  type VaultBlobStore,
  type WalletClient,
  type WalletEngineOptions,
  type WalletPrefs,
  type WalletSnapshot,
  type WalletTxDto,
  type ZephyrNetwork
} from "@lateo-wallet/core";
import { IndexedDbVaultStore } from "@lateo-wallet/core/idb";
import { validateNodeUrl } from "@lateo-wallet/core/node-url";
import { resolveWebDefaultNodeUrl } from "./default-node.js";
import { WebPrefsStore } from "./prefs-store.js";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
const ACTIVITY_THROTTLE_MS = 5_000;
const DEFAULT_DEFER_RETRY_MS = 15_000;
const MAX_AUTO_LOCK_DEFERRALS = 15;

export class WebClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WebClientError";
    this.code = code;
  }
}

export interface WindowEventTargetLike {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface DocumentVisibilityTargetLike {
  readonly visibilityState?: string;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface WebWalletClientOptions {
  readonly store?: VaultBlobStore;
  readonly prefsStore?: WebPrefsStore;
  readonly defaultNodeUrl?: string;
  readonly windowTarget?: WindowEventTargetLike | null;
  readonly documentTarget?: DocumentVisibilityTargetLike | null;
  readonly deferRetryMs?: number;
  readonly engineOptions?: Partial<
    Omit<WalletEngineOptions, "store" | "hostKind" | "onSnapshot" | "defaultNodeUrl">
  >;
}

function mapEngineError(err: unknown): WebClientError {
  if (err instanceof VaultAuthError) {
    return new WebClientError(err.code, "Incorrect vault password");
  }
  if (err instanceof TxFlowError) {
    return new WebClientError(err.code, err.message);
  }
  if (err instanceof WalletValidationError) {
    return new WebClientError(err.code, err.message);
  }
  return new WebClientError("ENGINE_ERROR", "Operation failed");
}

/**
 * In-tab Web PWA `WalletClient` backed directly by `WalletEngine`
 * (`proxyToWorker: true`) and origin IndexedDB (`IndexedDbVaultStore`).
 *
 * Security & lifecycle invariants:
 * - Idle auto-lock timer resets on user activity and wallet requests, and
 *   defers locking whenever `savingState === true` or a relay/persist barrier
 *   is active.
 * - Registers a `beforeunload` warning whenever `savingState === true`,
 *   `persistFailure !== null`, or a relay is in flight so the user is warned
 *   not to close the tab mid-checkpoint or mid-post-relay save.
 * - Never writes secrets, seeds, passwords, or wallet blobs to `localStorage`
 *   or `sessionStorage`.
 */
export class WebWalletClient implements WalletClient {
  readonly defaultNodeUrl: string;
  readonly engine: WalletEngine;

  private readonly prefsStore: WebPrefsStore;
  private readonly windowTarget: WindowEventTargetLike | null;
  private readonly documentTarget: DocumentVisibilityTargetLike | null;
  private readonly deferRetryMs: number;
  private readonly listeners = new Set<(snapshot: WalletSnapshot) => void>();

  private lastSnapshot: WalletSnapshot | null = null;
  private autoLockMinutes: number;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockDeferrals = 0;
  private lastActivityAt = 0;
  private disposed = false;

  private readonly handleActivityBound: EventListener;
  private readonly handleBeforeUnloadBound: EventListener;
  private readonly handleVisibilityChangeBound: EventListener;

  constructor(options: WebWalletClientOptions = {}) {
    this.defaultNodeUrl = options.defaultNodeUrl ?? resolveWebDefaultNodeUrl();
    this.prefsStore =
      options.prefsStore ?? new WebPrefsStore({ defaultNodeUrl: this.defaultNodeUrl });
    this.windowTarget =
      options.windowTarget !== undefined
        ? options.windowTarget
        : typeof window !== "undefined"
          ? window
          : null;
    this.documentTarget =
      options.documentTarget !== undefined
        ? options.documentTarget
        : typeof document !== "undefined"
          ? document
          : null;
    this.deferRetryMs = options.deferRetryMs ?? DEFAULT_DEFER_RETRY_MS;

    const initialPrefs = this.prefsStore.readPrefsSync();
    this.autoLockMinutes = initialPrefs.autoLockMinutes;

    const store = options.store ?? new IndexedDbVaultStore();
    this.engine = new WalletEngine({
      store,
      hostKind: "web-worker",
      proxyToWorker: true,
      defaultNodeUrl: initialPrefs.activePublicNode,
      ...options.engineOptions,
      onSnapshot: (snapshot) => {
        this.onEngineSnapshot(snapshot);
      }
    });

    this.handleActivityBound = () => {
      this.onUserActivity();
    };
    this.handleBeforeUnloadBound = (event: Event) => {
      this.onBeforeUnload(event as BeforeUnloadEvent);
    };
    this.handleVisibilityChangeBound = () => {
      this.onVisibilityChange();
    };

    if (this.windowTarget) {
      for (const evt of ACTIVITY_EVENTS) {
        this.windowTarget.addEventListener(evt, this.handleActivityBound);
      }
      this.windowTarget.addEventListener("beforeunload", this.handleBeforeUnloadBound);
    }
    if (this.documentTarget) {
      this.documentTarget.addEventListener("visibilitychange", this.handleVisibilityChangeBound);
    }
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
        // Keep snapshot fan-out isolated
      }
    }
  }

  private isCriticalSaveActive(): boolean {
    return (
      Boolean(this.lastSnapshot?.savingState) ||
      Boolean(this.lastSnapshot?.persistFailure) ||
      this.engine.isSavingOrRelayCritical()
    );
  }

  private onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.isCriticalSaveActive()) {
      event.preventDefault();
      event.returnValue = "";
    }
  }

  private isIdleDeadlineElapsed(now: number): boolean {
    if (this.lastActivityAt <= 0) return false;
    const limitMs = Math.max(1, this.autoLockMinutes) * 60_000;
    return now - this.lastActivityAt >= limitMs;
  }

  private onVisibilityChange(): void {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) {
      return;
    }
    if (this.documentTarget?.visibilityState === "visible" && this.isIdleDeadlineElapsed(Date.now())) {
      void this.handleAutoLockFire();
    }
  }

  private onUserActivity(): void {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) {
      return;
    }
    const now = Date.now();
    // Enforce wall-clock deadline if the browser throttled timers during system sleep.
    if (this.isIdleDeadlineElapsed(now)) {
      void this.handleAutoLockFire();
      return;
    }
    if (now - this.lastActivityAt < ACTIVITY_THROTTLE_MS) {
      return;
    }
    this.lastActivityAt = now;
    this.autoLockDeferrals = 0;
    this.armAutoLock();
  }

  private touchRequestActivity(): void {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) {
      return;
    }
    this.lastActivityAt = Date.now();
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
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) {
      return;
    }
    const delayMs = overrideDelayMs ?? Math.max(1, this.autoLockMinutes) * 60_000;
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = null;
      void this.handleAutoLockFire();
    }, delayMs);
  }

  private async handleAutoLockFire(): Promise<void> {
    if (this.disposed || !this.lastSnapshot || this.lastSnapshot.locked) {
      return;
    }

    // Never interrupt an active checkpoint/post-relay save or persist-failure recovery.
    if (this.lastSnapshot.savingState || this.lastSnapshot.persistFailure) {
      this.armAutoLock(this.deferRetryMs);
      return;
    }

    if (this.engine.isSavingOrRelayCritical()) {
      if (this.autoLockDeferrals < MAX_AUTO_LOCK_DEFERRALS) {
        this.autoLockDeferrals += 1;
        this.armAutoLock(this.deferRetryMs);
        return;
      }
    }

    try {
      await this.engine.lockWallet();
      this.autoLockDeferrals = 0;
    } catch {
      // e.g. LOCK_DEFERRED if a relay started right as the timer fired — retry soon.
      if (!this.disposed && this.lastSnapshot && !this.lastSnapshot.locked) {
        this.armAutoLock(this.deferRetryMs);
      }
    }
  }

  private async run<T>(fn: () => Promise<T>, touchActivity = true): Promise<T> {
    if (touchActivity) {
      this.touchRequestActivity();
    }
    try {
      const result = await fn();
      if (touchActivity) {
        this.touchRequestActivity();
      }
      return result;
    } catch (err) {
      throw mapEngineError(err);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearAutoLockTimer();
    this.listeners.clear();
    if (this.windowTarget) {
      for (const evt of ACTIVITY_EVENTS) {
        this.windowTarget.removeEventListener(evt, this.handleActivityBound);
      }
      this.windowTarget.removeEventListener("beforeunload", this.handleBeforeUnloadBound);
    }
    if (this.documentTarget) {
      this.documentTarget.removeEventListener("visibilitychange", this.handleVisibilityChangeBound);
    }
  }

  async getSnapshot(): Promise<WalletSnapshot> {
    return this.run(async () => {
      const snap = await this.engine.getSnapshot();
      const wasUnlocked = this.lastSnapshot !== null && !this.lastSnapshot.locked;
      this.lastSnapshot = snap;
      if (!snap.locked && (!wasUnlocked || this.autoLockTimer === null)) {
        if (this.lastActivityAt === 0) {
          this.lastActivityAt = Date.now();
        }
        this.armAutoLock();
      }
      return snap;
    }, false);
  }

  async getDiagnostics(): Promise<HostDiagnosticsDto> {
    return {
      hostKind: "web-worker",
      offscreenExists: false,
      keepAliveActive: false,
      defaultNodeHostPermissionGranted: true,
      grantedOrigins: [this.defaultNodeUrl]
    };
  }

  async getPrefs(): Promise<WalletPrefs> {
    return this.prefsStore.readPrefs();
  }

  async updatePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    const updated = await this.prefsStore.writePrefs(patch);
    this.autoLockMinutes = updated.autoLockMinutes;
    if (this.lastSnapshot && !this.lastSnapshot.locked) {
      this.autoLockDeferrals = 0;
      this.armAutoLock();
    }
    return updated;
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
      this.autoLockDeferrals = 0;
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
      this.autoLockDeferrals = 0;
      await this.prefsStore.writePrefs({
        activePublicNode: this.defaultNodeUrl,
        customNodes: []
      });
      return await this.engine.setActiveNode(this.defaultNodeUrl);
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
      let validated;
      try {
        validated = validateNodeUrl(url);
      } catch (err) {
        throw new WalletValidationError(err instanceof Error ? err.message : "Invalid node URL");
      }
      const snap = await this.engine.setActiveNode(validated.url);
      const currentPrefs = await this.prefsStore.readPrefs();
      const customNodes = saveAsCustom
        ? [...currentPrefs.customNodes, validated.url]
        : currentPrefs.customNodes;
      await this.prefsStore.writePrefs({
        activePublicNode: validated.url,
        customNodes
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
