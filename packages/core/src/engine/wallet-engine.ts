import {
  ZephyrDaemonRpc,
  createRandomWallet,
  openWalletData,
  restoreWalletFromKeys,
  restoreWalletFromSeed,
  setWasmModuleUrl,
  setWorkerDistPath,
  validateAddress,
  type ZephyrHistoryQuery,
  type ZephyrSubaddress,
  type ZephyrWallet,
  type ZephyrWalletTx
} from "@loki-notfound/zephyr-ts";
import { V2_ASSET_CODES } from "../assets/index.js";
import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "../network/node-url.js";
import { ReserveService } from "../network/reserve.js";
import type {
  BalanceEntryDto,
  CreateWalletResultDto,
  HostKind,
  NodeProbeResultDto,
  PersistFailureDto,
  PreparedTxDto,
  ProofKind,
  RelayOutcomeDto,
  ReserveStatusDto,
  RevealedSecretsDto,
  SavingKind,
  SubaddressDto,
  TxPriorityDto,
  UnresolvedRelayDto,
  WalletSnapshot,
  WalletSummaryDto,
  WalletTxDto,
  ZephyrNetwork
} from "../rpc/protocol.js";
import type { VaultBlobStore } from "../storage/types.js";
import {
  VaultAuthError,
  decryptVaultMeta,
  decryptWalletBlob,
  encryptVaultMeta,
  encryptVaultMetaWithKek,
  encryptWalletBlob,
  generateCorePassword,
  generateDek,
  generateWalletId,
  zeroize
} from "../vault/crypto.js";
import { MIN_VAULT_PASSWORD_LENGTH, evaluatePasswordStrength } from "../vault/password.js";
import { normalizeSeedInput, validateMnemonicWordCount } from "../vault/seed-quiz.js";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  VAULT_SCHEMA_VERSION,
  type EncryptedVaultMetaRecord,
  type EncryptedWalletBlobRecord,
  type KdfDescriptor,
  type RestoreHeightSource,
  type VaultManifestPlaintext,
  type WalletManifestEntry
} from "../vault/types.js";
import { DEFAULT_SYNC_INTERVAL_MS, SyncController } from "./sync-controller.js";
import { TxFlowController, TxFlowError } from "./tx-flow.js";

const DEFAULT_HEIGHT_FETCH_TIMEOUT_MS = 4_000;
const NODE_PROBE_TIMEOUT_MS = 6_000;
const DEFAULT_LOCK_CHECKPOINT_TIMEOUT_MS = 2_500;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_500;
const HEX_64_RE = /^[0-9a-f]{64}$/i;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Controlled, secret-free validation or precondition error safe to surface to the UI. */
export class WalletValidationError extends Error {
  readonly code = "VALIDATION_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "WalletValidationError";
  }
}

type ActiveWalletInfo = Omit<WalletManifestEntry, "corePassword">;

function toActiveWalletInfo(entry: WalletManifestEntry): ActiveWalletInfo {
  const { corePassword: _omitted, ...safe } = entry;
  return safe;
}

export interface WalletEngineOptions {
  readonly store: VaultBlobStore;
  readonly hostKind: HostKind;
  readonly proxyToWorker?: boolean;
  readonly pbkdf2Iterations?: number;
  readonly defaultNodeUrl?: string;
  readonly syncIntervalMs?: number;
  readonly enableBackgroundSync?: boolean;
  readonly heightFetchTimeoutMs?: number;
  readonly lockCheckpointTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly checkOriginPermission?: (originPattern: string) => Promise<boolean>;
  readonly fetchDaemonHeight?: (network: ZephyrNetwork) => Promise<number | null>;
  readonly validateAddressFn?: (address: string, network: ZephyrNetwork) => Promise<void>;
  readonly relayTimeoutMs?: number;
  readonly preparedTxTtlMs?: number;
  readonly wasmModuleUrl?: string;
  readonly workerDistPath?: string;
  readonly onSnapshot?: (snapshot: WalletSnapshot) => void;
  readonly onSyncBusyChange?: (busy: boolean) => void;
}

function assertValidPassword(password: string, label = "Vault password"): void {
  if (typeof password !== "string" || password.length < MIN_VAULT_PASSWORD_LENGTH) {
    throw new WalletValidationError(
      `${label} must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters`
    );
  }
  const strength = evaluatePasswordStrength(password);
  if (!strength.valid) {
    throw new WalletValidationError(
      `${label} is too weak — use 12+ characters or mix character types`
    );
  }
}

function assertValidRestoreHeight(height: number): void {
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
    throw new WalletValidationError("Restore height must be a non-negative whole number");
  }
}

async function fetchHeightFromDaemon(
  nodeUrl: string,
  timeoutMs: number
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rpc = new ZephyrDaemonRpc(nodeUrl);
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([rpc.getHeight(), timeoutPromise]);
    if (typeof result === "number" && Number.isSafeInteger(result) && result >= 0) {
      return result;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function networkFromCode(code: 0 | 1 | 2 | undefined): ZephyrNetwork | null {
  if (code === 0) return "mainnet";
  if (code === 1) return "testnet";
  if (code === 2) return "stagenet";
  return null;
}

function mapSubaddress(sub: ZephyrSubaddress): SubaddressDto {
  return {
    accountIndex: sub.accountIndex,
    index: sub.index,
    address: sub.address,
    label: sub.label,
    isUsed: sub.isUsed,
    numUnspentOutputs: sub.numUnspentOutputs
  };
}

function mapTx(tx: ZephyrWalletTx): WalletTxDto {
  return {
    hash: tx.hash,
    height: tx.height ?? null,
    timestamp: tx.timestamp ?? null,
    confirmations: tx.confirmations,
    isConfirmed: tx.isConfirmed,
    inPool: tx.inPool,
    isFailed: tx.isFailed,
    isLocked: tx.isLocked,
    isMinerTx: tx.isMinerTx,
    fee: tx.fee !== undefined ? tx.fee.toString() : null,
    feeAsset: tx.feeAsset ?? null,
    incomingTransfers: tx.incomingTransfers.map((t) => ({
      direction: t.direction,
      asset: t.asset ?? null,
      amount: t.amount.toString(),
      accountIndex: t.accountIndex,
      ...(t.subaddressIndex !== undefined ? { subaddressIndex: t.subaddressIndex } : {})
    })),
    outgoingTransfer: tx.outgoingTransfer
      ? {
          direction: tx.outgoingTransfer.direction,
          asset: tx.outgoingTransfer.asset ?? null,
          amount: tx.outgoingTransfer.amount.toString(),
          accountIndex: tx.outgoingTransfer.accountIndex,
          ...(tx.outgoingTransfer.destinations
            ? {
                destinations: tx.outgoingTransfer.destinations.map((d) => ({
                  ...(d.address !== undefined ? { address: d.address } : {}),
                  amount: d.amount.toString(),
                  ...(d.asset !== undefined ? { asset: d.asset } : {})
                }))
              }
            : {})
        }
      : null,
    conversion: tx.conversion
      ? {
          sourceAsset: tx.conversion.sourceAsset,
          destinationAsset: tx.conversion.destinationAsset,
          sourceAmount: tx.conversion.sourceAmount.toString(),
          destinationAmount: tx.conversion.destinationAmount.toString()
        }
      : null
  };
}

export class WalletEngine {
  private readonly store: VaultBlobStore;
  private readonly hostKind: HostKind;
  private readonly proxyToWorker: boolean;
  private readonly pbkdf2Iterations: number;
  private readonly heightFetchTimeoutMs: number;
  private readonly lockCheckpointTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly enableBackgroundSync: boolean;
  private readonly checkOriginPermission:
    | ((originPattern: string) => Promise<boolean>)
    | undefined;
  private readonly fetchDaemonHeightFn: (network: ZephyrNetwork) => Promise<number | null>;
  private readonly validateAddressFn: (address: string, network: ZephyrNetwork) => Promise<void>;
  private readonly onSnapshot: ((snapshot: WalletSnapshot) => void) | undefined;
  private readonly onSyncBusyChange: ((busy: boolean) => void) | undefined;

  private readonly syncController: SyncController;
  private readonly reserveService = new ReserveService();
  private readonly txFlow: TxFlowController;

  private activeNodeUrl: string;
  private userSwitchedNode = false;
  private queue: Promise<unknown> = Promise.resolve();
  private persistChain: Promise<void> = Promise.resolve();
  private activePersistCount = 0;
  private postRelayActiveCount = 0;
  private persistEpoch = 0;
  private lastPostRelayFailureEpoch = 0;
  private sessionGeneration = 0;
  private hasVaultCached = false;
  private activeWallet: ZephyrWallet | null = null;
  private activeManifest: VaultManifestPlaintext | null = null;
  private activeEntry: ActiveWalletInfo | null = null;
  private kek: CryptoKey | null = null;
  private kdf: KdfDescriptor | null = null;
  private dekKey: CryptoKey | null = null;
  private savingState = false;
  private savingKind: SavingKind | null = null;
  private persistFailure: PersistFailureDto | null = null;
  private unresolvedRelay: UnresolvedRelayDto | null = null;
  private postRelaySavePromise: Promise<void> | null = null;
  private activeRelayOp: Promise<void> | null = null;
  private syncBusy = false;
  private relayBusy = false;
  private lastPersistedAt: number | null = null;
  private cachedBalances: readonly BalanceEntryDto[] = [];

  constructor(options: WalletEngineOptions) {
    this.store = options.store;
    this.hostKind = options.hostKind;
    this.proxyToWorker = options.proxyToWorker ?? true;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    this.activeNodeUrl = validateNodeUrl(options.defaultNodeUrl ?? DEFAULT_PUBLIC_NODE_URL).url;
    this.heightFetchTimeoutMs = options.heightFetchTimeoutMs ?? DEFAULT_HEIGHT_FETCH_TIMEOUT_MS;
    this.lockCheckpointTimeoutMs =
      options.lockCheckpointTimeoutMs ?? DEFAULT_LOCK_CHECKPOINT_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.enableBackgroundSync = options.enableBackgroundSync ?? true;
    this.checkOriginPermission = options.checkOriginPermission;
    this.fetchDaemonHeightFn =
      options.fetchDaemonHeight ??
      ((network) =>
        network === "mainnet"
          ? fetchHeightFromDaemon(this.activeNodeUrl, this.heightFetchTimeoutMs)
          : Promise.resolve(null));
    this.validateAddressFn =
      options.validateAddressFn ??
      ((address, network) => validateAddress(address, network, this.proxyToWorker));
    this.onSnapshot = options.onSnapshot;
    this.onSyncBusyChange = options.onSyncBusyChange;

    this.syncController = new SyncController({
      nodeUrl: this.activeNodeUrl,
      intervalMs: options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
      ...(options.checkOriginPermission
        ? { checkOriginPermission: options.checkOriginPermission }
        : {}),
      onStatusChange: () => {
        void this.emitSnapshot();
      },
      onBusyChange: (busy) => {
        this.syncBusy = busy;
        this.emitBusyState();
      },
      onCheckpointRequired: async () => {
        if (this.activeWallet && this.activeEntry && this.dekKey) {
          await this.persistActiveWalletBlobs(
            this.activeWallet,
            this.activeEntry.id,
            this.dekKey,
            "checkpoint"
          );
        }
      },
      onSyncCompleted: async () => {
        if (this.activeWallet) {
          this.cachedBalances = await this.readBalances(this.activeWallet);
          try {
            await this.reserveService.refreshFromWalletAndNode(
              this.activeWallet,
              this.activeNodeUrl
            );
          } catch {
            // Reserve banner remains at last known good reading on transient failure
          }
          // A successful chain sync reconciles outputs and clears any unresolved-relay barrier.
          if (this.unresolvedRelay && !this.txFlow.getPending()) {
            await this.clearUnresolvedRelayMarkerInternal();
          }
          this.txFlow.checkExpiry();
        }
      }
    });

    this.txFlow = new TxFlowController({
      validateAddress: (address, network) => this.validateAddressFn(address, network),
      getDaemonHeight: () => {
        const sync = this.syncController.getStatus();
        const reserveHeight = this.reserveService.getCached()?.height ?? 0;
        return Math.max(sync.daemonHeight, sync.walletHeight, reserveHeight);
      },
      refreshDaemonHeight: async () => {
        if (!this.activeWallet) return null;
        return await fetchHeightFromDaemon(this.activeNodeUrl, 2_000);
      },
      getReserve: () => this.reserveService.getCached(),
      getNode: () => {
        const validated = validateNodeUrl(this.activeNodeUrl);
        return { url: validated.url, host: validated.host };
      },
      getUnlockedBalance: (asset) => {
        const entry = this.cachedBalances.find((b) => b.asset === asset);
        if (!entry) return null;
        return BigInt(entry.unlocked);
      },
      blockNewTransaction: () => {
        if (this.persistFailure) {
          return "A previous transaction was relayed, but wallet state has not been saved to disk yet. Retry saving first.";
        }
        if (this.unresolvedRelay) {
          return "A previous transaction had an uncertain broadcast status. Sync the wallet to verify whether it reached the network before preparing a new transaction.";
        }
        return null;
      },
      beforeRelay: async () => {
        this.relayBusy = true;
        this.emitBusyState();
        const validated = validateNodeUrl(this.activeNodeUrl);
        if (this.checkOriginPermission) {
          const granted = await this.checkOriginPermission(validated.originPattern);
          if (!granted) {
            throw new TxFlowError(
              "BUILD_FAILED",
              `Host permission required for ${validated.host}`
            );
          }
        }
        // Wait briefly for any already-running background sync to settle before starting relay timer.
        await this.syncController.waitForIdle(10_000);
        if (this.activeWallet) {
          await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
        }
      },
      afterRelay: () => {
        this.relayBusy = false;
        this.emitBusyState();
      },
      onSyncPauseChange: (paused) => {
        this.syncController.setPaused(paused);
      },
      onRelayUnknown: (info) => {
        void this.persistUnresolvedRelayMarker({
          txHashes: info.txHashes,
          recordedAt: Date.now(),
          nodeHost: info.nodeHost,
          reason: info.reason
        });
      },
      onUncertainRejection: (info) => {
        void this.persistUnresolvedRelayMarker({
          txHashes: info.txHashes,
          recordedAt: Date.now(),
          nodeHost: info.nodeHost,
          reason: info.reason
        }).then(() => {
          if (this.activeWallet) {
            void this.syncController.syncOnce().catch(() => {});
          }
        });
      },
      onRelayConfirmed: () => {
        void this.clearUnresolvedRelayMarkerInternal();
      },
      persistAfterRelay: async (txHashes) => {
        await this.persistPostRelayBlobs(txHashes);
      },
      onLateRelayAccepted: (txHashes) => {
        void this.persistPostRelayBlobs(txHashes).catch(() => {
          // persistFailure is already recorded on the snapshot for user retry
        });
      },
      onChange: () => {
        void this.emitSnapshot();
      },
      ...(options.relayTimeoutMs !== undefined ? { relayTimeoutMs: options.relayTimeoutMs } : {}),
      ...(options.preparedTxTtlMs !== undefined ? { ttlMs: options.preparedTxTtlMs } : {})
    });

    if (options.workerDistPath) {
      setWorkerDistPath(options.workerDistPath);
    }
    if (options.wasmModuleUrl) {
      setWasmModuleUrl(options.wasmModuleUrl);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private runSerializedPersist<T>(task: () => Promise<T>): Promise<T> {
    const run = this.persistChain.then(task, task);
    this.persistChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async emitSnapshot(): Promise<WalletSnapshot> {
    const snap = await this.buildSnapshot();
    this.onSnapshot?.(snap);
    return snap;
  }

  private async buildSnapshot(): Promise<WalletSnapshot> {
    let hasVault = this.hasVaultCached || this.activeEntry !== null;
    try {
      const meta = await this.store.readMeta();
      hasVault = meta !== undefined;
      this.hasVaultCached = hasVault;
    } catch {
      // Tolerate transient IndexedDB read errors so savingState / error recovery never wedges
    }

    const activeSummary: WalletSummaryDto | null = this.activeEntry
      ? {
          id: this.activeEntry.id,
          name: this.activeEntry.name,
          network: this.activeEntry.network,
          primaryAddress: this.activeEntry.primaryAddress,
          restoreHeight: this.activeEntry.restoreHeight,
          restoreHeightSource: this.activeEntry.restoreHeightSource,
          createdAt: this.activeEntry.createdAt,
          viewOnly: this.activeEntry.viewOnly,
          seedBackupVerified: this.activeEntry.seedBackupVerified
        }
      : null;

    return {
      hasVault,
      locked: this.activeWallet === null,
      savingState: this.savingState,
      savingKind: this.savingKind,
      pendingTx: this.txFlow.getPending(),
      persistFailure: this.persistFailure,
      unresolvedRelay: this.unresolvedRelay,
      activeWallet: activeSummary,
      balances: this.cachedBalances,
      sync: this.syncController.getStatus(),
      reserve: this.reserveService.getCached(),
      lastPersistedAt: this.lastPersistedAt,
      hostKind: this.hostKind
    };
  }

  private emitBusyState(): void {
    this.onSyncBusyChange?.(
      this.syncBusy ||
        this.relayBusy ||
        this.savingState ||
        this.postRelaySavePromise !== null ||
        this.persistFailure !== null
    );
  }

  isSavingOrRelayCritical(): boolean {
    return (
      this.savingKind === "post-relay" ||
      this.postRelayActiveCount > 0 ||
      this.relayBusy ||
      this.txFlow.isRelayInFlight() ||
      this.postRelaySavePromise !== null ||
      this.persistFailure !== null
    );
  }

  /**
   * Apply a persisted custom node URL on host startup before create/restore/unlock
   * without triggering a network sync or overriding an explicit SWITCH_NODE.
   */
  setInitialNodeUrl(rawUrl: string): void {
    if (this.userSwitchedNode) return;
    try {
      const validated = validateNodeUrl(rawUrl);
      this.activeNodeUrl = validated.url;
      this.syncController.setNodeUrl(validated.url);
    } catch {
      // Keep current valid node URL if persisted preference is malformed
    }
  }

  async getSnapshot(): Promise<WalletSnapshot> {
    return this.buildSnapshot();
  }

  private async readBalances(wallet: ZephyrWallet): Promise<readonly BalanceEntryDto[]> {
    const totalMap = await wallet.getBalance();
    const unlockedMap = await wallet.getUnlockedBalance();
    return V2_ASSET_CODES.map((asset) => {
      const total = totalMap.get(asset) ?? 0n;
      const unlocked = unlockedMap.get(asset) ?? 0n;
      const locked = total > unlocked ? total - unlocked : 0n;
      return {
        asset,
        total: total.toString(),
        unlocked: unlocked.toString(),
        locked: locked.toString()
      };
    });
  }

  private attachSyncForActiveWallet(wallet: ZephyrWallet, initialHeight: number): void {
    this.syncController.attach(
      {
        setDaemonConnection: (url) => wallet.setDaemonConnection(url),
        getHeight: () => wallet.getHeight(),
        getDaemonHeight: () => wallet.getDaemonHeight(),
        sync: (onProgress) =>
          wallet.sync({
            onSyncProgress: (height, startHeight, endHeight, percentDone) => {
              onProgress(height, startHeight, endHeight, percentDone);
            }
          })
      },
      initialHeight,
      this.lastPersistedAt
    );
    if (this.enableBackgroundSync) {
      this.syncController.startBackgroundLoop();
    }
  }

  private async encryptActiveWalletBlobs(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey
  ): Promise<readonly [EncryptedWalletBlobRecord, EncryptedWalletBlobRecord]> {
    let keysBytes: Uint8Array | undefined;
    let cacheBytes: Uint8Array | undefined;
    try {
      const data = await wallet.getData();
      keysBytes = data.keys;
      cacheBytes = data.cache;
      const height = await wallet.getHeight();
      const encKeys = await encryptWalletBlob(dekKey, walletId, "keys", keysBytes, height);
      const encCache = await encryptWalletBlob(dekKey, walletId, "cache", cacheBytes, height);
      return [encKeys, encCache] as const;
    } finally {
      zeroize(keysBytes);
      zeroize(cacheBytes);
    }
  }

  private async persistUnresolvedRelayMarker(marker: UnresolvedRelayDto): Promise<void> {
    this.unresolvedRelay = marker;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;
    if (!entry || !dekKey) return;
    let payload: Uint8Array | undefined;
    try {
      payload = TEXT_ENCODER.encode(JSON.stringify(marker));
      const enc = await encryptWalletBlob(dekKey, entry.id, "relay", payload, 0);
      await this.store.writeBlob(enc);
    } catch {
      // In-memory unresolvedRelay barrier remains active even if disk write fails
    } finally {
      zeroize(payload);
    }
    await this.emitSnapshot();
  }

  private async clearUnresolvedRelayMarkerInternal(): Promise<void> {
    const had = this.unresolvedRelay !== null;
    this.unresolvedRelay = null;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;
    if (entry && dekKey) {
      let payload: Uint8Array | undefined;
      try {
        payload = TEXT_ENCODER.encode("null");
        const enc = await encryptWalletBlob(dekKey, entry.id, "relay", payload, 0);
        await this.store.writeBlob(enc);
      } catch {
        // Best-effort clear of persisted relay marker
      } finally {
        zeroize(payload);
      }
    }
    if (had) {
      await this.emitSnapshot();
    }
  }

  private async loadUnresolvedRelayMarker(
    walletId: string,
    dekKey: CryptoKey
  ): Promise<UnresolvedRelayDto | null> {
    try {
      const record = await this.store.readBlob(walletId, "relay");
      if (!record) return null;
      const bytes = await decryptWalletBlob(dekKey, record);
      try {
        const parsed = JSON.parse(TEXT_DECODER.decode(bytes)) as UnresolvedRelayDto | null;
        if (
          parsed &&
          typeof parsed === "object" &&
          Array.isArray(parsed.txHashes) &&
          typeof parsed.recordedAt === "number" &&
          typeof parsed.nodeHost === "string" &&
          typeof parsed.reason === "string"
        ) {
          return {
            txHashes: parsed.txHashes.filter((h): h is string => typeof h === "string"),
            recordedAt: parsed.recordedAt,
            nodeHost: parsed.nodeHost,
            reason: parsed.reason
          };
        }
        return null;
      } finally {
        zeroize(bytes);
      }
    } catch {
      return null;
    }
  }

  private async commitNewVault(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey,
    metaRecord: EncryptedVaultMetaRecord
  ): Promise<void> {
    await this.runSerializedPersist(async () => {
      this.activePersistCount += 1;
      try {
        this.savingState = true;
        this.savingKind = this.postRelayActiveCount > 0 ? "post-relay" : "checkpoint";
        this.emitBusyState();
        await this.emitSnapshot();
        const blobs = await this.encryptActiveWalletBlobs(wallet, walletId, dekKey);
        if (this.store.writeVaultAtomic) {
          await this.store.writeVaultAtomic(metaRecord, blobs);
        } else {
          await this.store.writeBlob(blobs[0]);
          await this.store.writeBlob(blobs[1]);
          await this.store.writeMeta(metaRecord);
        }
        this.hasVaultCached = true;
        this.lastPersistedAt = Date.now();
      } finally {
        this.activePersistCount = Math.max(0, this.activePersistCount - 1);
        this.savingState = this.activePersistCount > 0;
        this.savingKind =
          this.postRelayActiveCount > 0
            ? "post-relay"
            : this.activePersistCount > 0
              ? "checkpoint"
              : null;
        this.emitBusyState();
      }
    });
  }

  private async persistActiveWalletBlobs(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey,
    kind: SavingKind = "checkpoint"
  ): Promise<void> {
    await this.runSerializedPersist(async () => {
      if (kind === "checkpoint" && (this.activeWallet !== wallet || this.persistFailure !== null)) {
        return;
      }
      const startedEpoch = ++this.persistEpoch;
      const gen = this.sessionGeneration;
      this.activePersistCount += 1;
      if (kind === "post-relay") {
        this.postRelayActiveCount += 1;
      }
      try {
        this.savingState = true;
        this.savingKind = this.postRelayActiveCount > 0 ? "post-relay" : kind;
        this.emitBusyState();
        await this.emitSnapshot();
        const [encKeys, encCache] = await this.encryptActiveWalletBlobs(wallet, walletId, dekKey);
        if (gen !== this.sessionGeneration && kind === "checkpoint") {
          return;
        }
        if (this.store.writeBlobsAtomic) {
          await this.store.writeBlobsAtomic([encKeys, encCache]);
        } else {
          await this.store.writeBlob(encKeys);
          await this.store.writeBlob(encCache);
        }
        if (gen === this.sessionGeneration) {
          this.lastPersistedAt = Date.now();
          if (kind === "post-relay" || startedEpoch > this.lastPostRelayFailureEpoch) {
            this.persistFailure = null;
          }
        }
      } finally {
        this.activePersistCount = Math.max(0, this.activePersistCount - 1);
        if (kind === "post-relay") {
          this.postRelayActiveCount = Math.max(0, this.postRelayActiveCount - 1);
        }
        this.savingState = this.activePersistCount > 0;
        this.savingKind =
          this.postRelayActiveCount > 0
            ? "post-relay"
            : this.activePersistCount > 0
              ? "checkpoint"
              : null;
        this.emitBusyState();
      }
    });
  }

  private async persistPostRelayBlobs(txHashes: readonly string[]): Promise<void> {
    const wallet = this.activeWallet;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;
    if (!wallet || !entry || !dekKey) {
      throw new Error("Active wallet session missing during post-relay save");
    }
    const run = (async () => {
      try {
        await this.persistActiveWalletBlobs(wallet, entry.id, dekKey, "post-relay");
        this.cachedBalances = await this.readBalances(wallet);
      } catch (err) {
        this.lastPostRelayFailureEpoch = ++this.persistEpoch;
        this.persistFailure = {
          txHashes: [...txHashes],
          failedAt: Date.now(),
          message: "IndexedDB commit failed after relay"
        };
        this.emitBusyState();
        throw err;
      } finally {
        await this.emitSnapshot();
      }
    })();
    this.postRelaySavePromise = run.then(
      () => undefined,
      () => undefined
    );
    this.emitBusyState();
    try {
      await run;
    } finally {
      this.postRelaySavePromise = null;
      this.emitBusyState();
    }
  }

  private async assertNoExistingVault(): Promise<void> {
    const existingMeta = await this.store.readMeta();
    if (existingMeta !== undefined) {
      this.hasVaultCached = true;
      throw new WalletValidationError(
        "A vault already exists — reset the existing vault before creating or restoring a new wallet"
      );
    }
  }

  async createWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: ZephyrNetwork;
  }): Promise<CreateWalletResultDto> {
    return this.enqueue(async () => {
      assertValidPassword(params.password);
      await this.assertNoExistingVault();
      await this.closeActiveWalletInternal(false);

      const network: ZephyrNetwork = params.network ?? "mainnet";
      const corePassword = generateCorePassword();
      const walletId = generateWalletId();
      const { dekKey, dekBase64 } = await generateDek();

      // Probe daemon height first with a short timeout; pass server to createRandomWallet
      // when reachable so the WASM keys blob natively captures the live daemon restoreHeight.
      const daemonHeight = await this.fetchDaemonHeightFn(network);
      const canPassServer = daemonHeight !== null && network === "mainnet";

      const wallet = await createRandomWallet({
        networkType: network,
        password: corePassword,
        proxyToWorker: this.proxyToWorker,
        ...(canPassServer ? { server: this.activeNodeUrl } : {})
      });

      try {
        const primaryAddress = await wallet.getPrimaryAddress();
        const seed = await wallet.getSeed();
        if (!seed) {
          throw new Error("Created wallet did not return a recovery seed");
        }
        const coreHeight = await wallet.getRestoreHeight();
        const restoreHeight =
          daemonHeight !== null ? Math.max(daemonHeight, coreHeight) : coreHeight;
        const restoreHeightSource: RestoreHeightSource =
          daemonHeight !== null ? "daemon" : "offline-estimate";
        const createdAt = new Date().toISOString();

        const entry: WalletManifestEntry = {
          id: walletId,
          name: params.name.trim() || "Primary Wallet",
          network,
          restoreHeight,
          restoreHeightSource,
          createdAt,
          viewOnly: false,
          seedBackupVerified: false,
          corePassword,
          primaryAddress
        };
        const manifest: VaultManifestPlaintext = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          dek: dekBase64,
          wallets: [entry]
        };

        const { record, kek, kdf } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.commitNewVault(wallet, walletId, dekKey, record);

        this.sessionGeneration += 1;
        this.activeWallet = wallet;
        this.activeManifest = manifest;
        this.activeEntry = toActiveWalletInfo(entry);
        this.kek = kek;
        this.kdf = kdf;
        this.dekKey = dekKey;
        this.unresolvedRelay = null;
        this.cachedBalances = await this.readBalances(wallet);
        this.txFlow.attach(wallet, entry.network, entry.viewOnly);
        this.attachSyncForActiveWallet(wallet, await wallet.getHeight());
        const snapshot = await this.emitSnapshot();

        return {
          snapshot,
          seed,
          restoreHeight,
          restoreHeightSource,
          createdAt
        };
      } catch (err) {
        await this.safeCloseOrTerminate(wallet);
        throw err;
      }
    });
  }

  async restoreFromSeed(params: {
    readonly password: string;
    readonly name: string;
    readonly seed: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      assertValidPassword(params.password);
      assertValidRestoreHeight(params.restoreHeight);

      const wordCheck = validateMnemonicWordCount(params.seed);
      if (!wordCheck.valid) {
        throw new WalletValidationError(
          `Recovery seed must contain 25 words (received ${wordCheck.count})`
        );
      }

      await this.assertNoExistingVault();

      const network: ZephyrNetwork = params.network ?? "mainnet";
      const normalizedSeed = normalizeSeedInput(params.seed);
      const corePassword = generateCorePassword();
      const walletId = generateWalletId();
      const { dekKey, dekBase64 } = await generateDek();

      let wallet: ZephyrWallet;
      try {
        wallet = await restoreWalletFromSeed({
          networkType: network,
          password: corePassword,
          seed: normalizedSeed,
          restoreHeight: params.restoreHeight,
          proxyToWorker: this.proxyToWorker
        });
      } catch {
        throw new WalletValidationError("Invalid 25-word recovery seed or checksum");
      }

      try {
        const primaryAddress = await wallet.getPrimaryAddress();
        const entry: WalletManifestEntry = {
          id: walletId,
          name: params.name.trim() || "Restored Wallet",
          network,
          restoreHeight: params.restoreHeight,
          restoreHeightSource: "user",
          createdAt: new Date().toISOString(),
          viewOnly: false,
          seedBackupVerified: true,
          corePassword,
          primaryAddress
        };
        const manifest: VaultManifestPlaintext = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          dek: dekBase64,
          wallets: [entry]
        };

        const { record } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.closeActiveWalletInternal(false);
        await this.commitNewVault(wallet, walletId, dekKey, record);

        this.sessionGeneration += 1;
        this.activeWallet = wallet;
        // Backup is already verified for restored wallets; drop raw manifest/KEK from heap.
        this.activeManifest = null;
        this.activeEntry = toActiveWalletInfo(entry);
        this.kek = null;
        this.kdf = null;
        this.dekKey = dekKey;
        this.unresolvedRelay = null;
        this.cachedBalances = await this.readBalances(wallet);
        this.txFlow.attach(wallet, entry.network, entry.viewOnly);
        this.attachSyncForActiveWallet(wallet, await wallet.getHeight());
        return await this.emitSnapshot();
      } catch (err) {
        await this.safeCloseOrTerminate(wallet);
        throw err;
      }
    });
  }

  async restoreViewOnly(params: {
    readonly password: string;
    readonly name: string;
    readonly primaryAddress: string;
    readonly privateViewKey: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      assertValidPassword(params.password);
      assertValidRestoreHeight(params.restoreHeight);

      const network: ZephyrNetwork = params.network ?? "mainnet";
      const address = params.primaryAddress.trim();
      const viewKey = params.privateViewKey.trim().toLowerCase();

      if (!address) {
        throw new WalletValidationError("Primary address is required");
      }
      if (!HEX_64_RE.test(viewKey)) {
        throw new WalletValidationError("Private view key must be 64 hexadecimal characters");
      }
      try {
        await this.validateAddressFn(address, network);
      } catch {
        throw new WalletValidationError(`Invalid Zephyr ${network} address`);
      }

      await this.assertNoExistingVault();

      const corePassword = generateCorePassword();
      const walletId = generateWalletId();
      const { dekKey, dekBase64 } = await generateDek();

      let wallet: ZephyrWallet;
      try {
        wallet = await restoreWalletFromKeys({
          networkType: network,
          password: corePassword,
          primaryAddress: address,
          privateViewKey: viewKey,
          restoreHeight: params.restoreHeight,
          proxyToWorker: this.proxyToWorker
        });
      } catch {
        throw new WalletValidationError("Address and private view key could not be verified");
      }

      try {
        const verifiedAddress = await wallet.getPrimaryAddress();
        const isViewOnly = await wallet.isViewOnly();
        if (!isViewOnly) {
          throw new Error("Restored wallet is unexpectedly not view-only");
        }

        const entry: WalletManifestEntry = {
          id: walletId,
          name: params.name.trim() || "View-Only Wallet",
          network,
          restoreHeight: params.restoreHeight,
          restoreHeightSource: "user",
          createdAt: new Date().toISOString(),
          viewOnly: true,
          seedBackupVerified: true,
          corePassword,
          primaryAddress: verifiedAddress
        };
        const manifest: VaultManifestPlaintext = {
          schemaVersion: VAULT_SCHEMA_VERSION,
          dek: dekBase64,
          wallets: [entry]
        };

        const { record } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.closeActiveWalletInternal(false);
        await this.commitNewVault(wallet, walletId, dekKey, record);

        this.sessionGeneration += 1;
        this.activeWallet = wallet;
        this.activeManifest = null;
        this.activeEntry = toActiveWalletInfo(entry);
        this.kek = null;
        this.kdf = null;
        this.dekKey = dekKey;
        this.unresolvedRelay = null;
        this.cachedBalances = await this.readBalances(wallet);
        this.txFlow.attach(wallet, entry.network, entry.viewOnly);
        this.attachSyncForActiveWallet(wallet, await wallet.getHeight());
        return await this.emitSnapshot();
      } catch (err) {
        await this.safeCloseOrTerminate(wallet);
        throw err;
      }
    });
  }

  async markSeedBackupVerified(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry) {
        throw new WalletValidationError("Wallet must be unlocked to update backup status");
      }
      if (this.activeEntry.seedBackupVerified) {
        return await this.buildSnapshot();
      }
      if (!this.activeManifest || !this.kek || !this.kdf) {
        throw new WalletValidationError("Wallet session cannot update backup status");
      }
      const existingManifestEntry = this.activeManifest.wallets.find(
        (w) => w.id === this.activeEntry!.id
      );
      if (!existingManifestEntry) {
        throw new Error("Active wallet missing from vault manifest");
      }
      const updatedManifestEntry: WalletManifestEntry = {
        ...existingManifestEntry,
        seedBackupVerified: true
      };
      const updatedManifest: VaultManifestPlaintext = {
        ...this.activeManifest,
        wallets: this.activeManifest.wallets.map((w) =>
          w.id === updatedManifestEntry.id ? updatedManifestEntry : w
        )
      };
      const updatedMeta = await encryptVaultMetaWithKek(updatedManifest, this.kek, this.kdf);
      await this.store.writeMeta(updatedMeta);
      this.activeEntry = toActiveWalletInfo(updatedManifestEntry);
      // Drop raw manifest (DEK + corePassword) and KEK from heap now that backup is verified.
      this.activeManifest = null;
      this.kek = null;
      this.kdf = null;
      return await this.emitSnapshot();
    });
  }

  async unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      const meta = await this.store.readMeta();
      if (!meta) {
        throw new WalletValidationError("No vault found");
      }
      const { manifest, kek, kdf, dekKey } = await decryptVaultMeta(meta, password);
      const entry = manifest.wallets[0];
      if (!entry) {
        throw new Error("Vault contains no wallet");
      }

      const encKeys = await this.store.readBlob(entry.id, "keys");
      const encCache = await this.store.readBlob(entry.id, "cache");
      if (!encKeys) {
        throw new Error("Encrypted wallet keys blob is missing");
      }

      await this.closeActiveWalletInternal(false);

      let keysData: Uint8Array | undefined;
      let cacheData: Uint8Array | undefined;
      try {
        keysData = await decryptWalletBlob(dekKey, encKeys);
        cacheData = encCache ? await decryptWalletBlob(dekKey, encCache) : undefined;

        const openConfig = cacheData
          ? {
              networkType: entry.network,
              password: entry.corePassword,
              keysData,
              cacheData,
              proxyToWorker: this.proxyToWorker
            }
          : {
              networkType: entry.network,
              password: entry.corePassword,
              keysData,
              proxyToWorker: this.proxyToWorker
            };
        const wallet = await openWalletData(openConfig);

        const primaryAddress = await wallet.getPrimaryAddress();
        if (primaryAddress !== entry.primaryAddress) {
          await this.safeCloseOrTerminate(wallet);
          throw new Error("Decrypted wallet address does not match vault metadata");
        }

        const normalizedEntry: ActiveWalletInfo = {
          ...toActiveWalletInfo(entry),
          restoreHeightSource: entry.restoreHeightSource ?? "offline-estimate"
        };
        const unresolvedRelay = await this.loadUnresolvedRelayMarker(entry.id, dekKey);

        this.sessionGeneration += 1;
        this.hasVaultCached = true;
        this.activeWallet = wallet;
        // Retain manifest/KEK in memory only while seedBackupVerified is still false.
        if (normalizedEntry.seedBackupVerified) {
          this.activeManifest = null;
          this.kek = null;
          this.kdf = null;
        } else {
          this.activeManifest = manifest;
          this.kek = kek;
          this.kdf = kdf;
        }
        this.activeEntry = normalizedEntry;
        this.dekKey = dekKey;
        this.unresolvedRelay = unresolvedRelay;
        this.lastPersistedAt = encCache?.updatedAt ?? encKeys.updatedAt;
        this.cachedBalances = await this.readBalances(wallet);
        this.txFlow.attach(wallet, normalizedEntry.network, normalizedEntry.viewOnly);
        const restoredWalletHeight = Math.max(
          await wallet.getHeight(),
          encCache?.syncedHeight ?? 0
        );
        this.attachSyncForActiveWallet(wallet, restoredWalletHeight);
        return await this.emitSnapshot();
      } finally {
        zeroize(keysData);
        zeroize(cacheData);
      }
    });
  }

  async changeVaultPassword(params: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry) {
        throw new WalletValidationError("Wallet must be unlocked to change password");
      }
      assertValidPassword(params.newPassword, "New vault password");
      if (params.currentPassword === params.newPassword) {
        throw new WalletValidationError("New password must differ from current password");
      }

      const existingMeta = await this.store.readMeta();
      if (!existingMeta) {
        throw new WalletValidationError("No vault found");
      }

      const { manifest } = await decryptVaultMeta(existingMeta, params.currentPassword);
      const { record, kek, kdf } = await encryptVaultMeta(manifest, params.newPassword, {
        iterations: this.pbkdf2Iterations
      });
      await this.store.writeMeta(record);

      if (!this.activeEntry.seedBackupVerified) {
        this.activeManifest = manifest;
        this.kek = kek;
        this.kdf = kdf;
      } else {
        this.activeManifest = null;
        this.kek = null;
        this.kdf = null;
      }
    });
  }

  async revealSecrets(password: string): Promise<RevealedSecretsDto> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry) {
        throw new WalletValidationError("Wallet must be unlocked to reveal secrets");
      }
      const existingMeta = await this.store.readMeta();
      if (!existingMeta) {
        throw new WalletValidationError("No vault found");
      }
      await decryptVaultMeta(existingMeta, password);

      const primaryAddress = await this.activeWallet.getPrimaryAddress();
      const privateViewKey = await this.activeWallet.getPrivateViewKey();
      const viewOnly = await this.activeWallet.isViewOnly();
      const seed = viewOnly ? null : ((await this.activeWallet.getSeed()) ?? null);
      const privateSpendKey = viewOnly
        ? null
        : ((await this.activeWallet.getPrivateSpendKey()) ?? null);

      return {
        primaryAddress,
        seed,
        privateViewKey,
        privateSpendKey,
        restoreHeight: this.activeEntry.restoreHeight,
        viewOnly
      };
    });
  }

  async syncNow(): Promise<WalletSnapshot> {
    // Run outside the command queue so long chain scans never block Lock or status reads.
    if (!this.activeWallet) {
      return await this.buildSnapshot();
    }
    await this.syncController.syncOnce();
    return await this.emitSnapshot();
  }

  async refreshReserve(): Promise<ReserveStatusDto | null> {
    return this.enqueue(async () => {
      if (!this.activeWallet) return null;
      const validated = validateNodeUrl(this.activeNodeUrl);
      if (this.checkOriginPermission) {
        const granted = await this.checkOriginPermission(validated.originPattern);
        if (!granted) return this.reserveService.getCached();
      }
      await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      const status = await this.reserveService.refreshFromWalletAndNode(
        this.activeWallet,
        this.activeNodeUrl
      );
      await this.emitSnapshot();
      return status;
    });
  }

  async probeNode(rawUrl: string): Promise<NodeProbeResultDto> {
    const validated = validateNodeUrl(rawUrl);
    if (this.checkOriginPermission) {
      const granted = await this.checkOriginPermission(validated.originPattern);
      if (!granted) {
        return {
          url: validated.url,
          host: validated.host,
          originPattern: validated.originPattern,
          isLocal: validated.isLocal,
          reachable: false,
          height: null,
          isSynchronized: null,
          network: null,
          version: null,
          permissionRequired: true,
          errorMessage: `Browser host permission required for ${validated.originPattern}`
        };
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rpc = new ZephyrDaemonRpc(validated.url);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Connection probe timed out")), NODE_PROBE_TIMEOUT_MS);
      });
      const [info, height] = await Promise.race([
        Promise.all([rpc.getInfo(), rpc.getHeight()]),
        timeoutPromise
      ]);
      return {
        url: validated.url,
        host: validated.host,
        originPattern: validated.originPattern,
        isLocal: validated.isLocal,
        reachable: true,
        height,
        isSynchronized: info.isSynchronized ?? null,
        network: networkFromCode(info.networkType),
        version: info.version && info.version.length > 0 ? info.version : null,
        permissionRequired: false,
        errorMessage: null
      };
    } catch (err) {
      return {
        url: validated.url,
        host: validated.host,
        originPattern: validated.originPattern,
        isLocal: validated.isLocal,
        reachable: false,
        height: null,
        isSynchronized: null,
        network: null,
        version: null,
        permissionRequired: false,
        errorMessage:
          err instanceof Error && err.message.includes("timed out")
            ? "Node probe timed out"
            : `Could not reach ${validated.host}`
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async setActiveNode(rawUrl: string): Promise<WalletSnapshot> {
    const validated = validateNodeUrl(rawUrl);
    await this.enqueue(async () => {
      this.userSwitchedNode = true;
      this.activeNodeUrl = validated.url;
      this.txFlow.release();
      this.syncController.setNodeUrl(validated.url);
      this.reserveService.resetForNodeSwitch();
      if (this.activeWallet) {
        await this.activeWallet.setDaemonConnection(validated.url);
      }
    });
    // Run the follow-up sync outside the engine queue so Lock can pre-empt a slow node.
    if (this.activeWallet) {
      await this.syncController.syncOnce();
    }
    return await this.emitSnapshot();
  }

  async listSubaddresses(): Promise<readonly SubaddressDto[]> {
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        throw new WalletValidationError("Wallet must be unlocked");
      }
      const list = await this.activeWallet.getSubaddresses(0);
      return list.map(mapSubaddress);
    });
  }

  async createSubaddress(label?: string): Promise<SubaddressDto> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry || !this.dekKey) {
        throw new WalletValidationError("Wallet must be unlocked");
      }
      const cleanLabel = (typeof label === "string" ? label : "").trim().slice(0, 120);
      const sub = await this.activeWallet.createSubaddress(0, cleanLabel);
      await this.persistActiveWalletBlobs(this.activeWallet, this.activeEntry.id, this.dekKey);
      await this.emitSnapshot();
      return mapSubaddress(sub);
    });
  }

  async setSubaddressLabel(index: number, label: string): Promise<readonly SubaddressDto[]> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry || !this.dekKey) {
        throw new WalletValidationError("Wallet must be unlocked");
      }
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new WalletValidationError("Subaddress index must be a non-negative integer");
      }
      const cleanLabel = (typeof label === "string" ? label : "").trim().slice(0, 120);
      await this.activeWallet.setSubaddressLabel(0, index, cleanLabel);
      await this.persistActiveWalletBlobs(this.activeWallet, this.activeEntry.id, this.dekKey);
      const list = await this.activeWallet.getSubaddresses(0);
      await this.emitSnapshot();
      return list.map(mapSubaddress);
    });
  }

  async getHistory(filter?: {
    readonly asset?: string;
    readonly direction?: "incoming" | "outgoing";
  }): Promise<readonly WalletTxDto[]> {
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        throw new Error("Wallet must be unlocked");
      }
      const query: ZephyrHistoryQuery = {
        ...(filter?.asset ? { asset: filter.asset } : {}),
        ...(filter?.direction ? { direction: filter.direction } : {})
      };
      const txs = await this.activeWallet.getTxs(
        Object.keys(query).length > 0 ? query : undefined
      );
      return txs.map(mapTx).reverse();
    });
  }

  async refreshPool(): Promise<{
    readonly poolCount: number;
    readonly txs: readonly WalletTxDto[];
  }> {
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        throw new Error("Wallet must be unlocked");
      }
      const validated = validateNodeUrl(this.activeNodeUrl);
      if (this.checkOriginPermission) {
        const granted = await this.checkOriginPermission(validated.originPattern);
        if (!granted) {
          throw new Error(`Host permission required for ${validated.host}`);
        }
      }
      await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      const poolCount = await this.activeWallet.refreshPool();
      const txs = (await this.activeWallet.getTxs()).map(mapTx).reverse();
      return { poolCount, txs };
    });
  }

  async exportTxProof(params: {
    readonly kind: ProofKind;
    readonly txHash: string;
    readonly address?: string;
    readonly message?: string;
  }): Promise<string> {
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        throw new Error("Wallet must be unlocked");
      }
      if (params.kind === "tx_key") {
        return this.activeWallet.getTxKey(params.txHash);
      }
      if (params.kind === "spend_proof") {
        await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
        return this.activeWallet.getSpendProof(params.txHash, params.message);
      }
      if (!params.address) {
        throw new Error("Recipient or wallet address is required for a transaction proof");
      }
      await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      return this.activeWallet.getTxProof(params.txHash, params.address, params.message);
    });
  }

  async prepareTransfer(params: {
    readonly asset: string;
    readonly destinations: readonly { readonly address: string; readonly amount: string }[];
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.enqueue(async () => {
      if (this.activeWallet) {
        await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      }
      return this.txFlow.prepareTransfer(params);
    });
  }

  async prepareSweep(params: {
    readonly asset: string;
    readonly address: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.enqueue(async () => {
      if (this.activeWallet) {
        await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      }
      return this.txFlow.prepareSweep(params);
    });
  }

  async prepareConversion(params: {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly amount: string;
    readonly address?: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    return this.enqueue(async () => {
      if (this.activeWallet) {
        await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
      }
      return this.txFlow.prepareConversion(params);
    });
  }

  async relayPrepared(token: string): Promise<RelayOutcomeDto> {
    const op = this.enqueue(() => this.txFlow.relay(token));
    const settled = op.then(
      () => undefined,
      () => undefined
    );
    this.activeRelayOp = settled;
    try {
      return await op;
    } finally {
      if (this.activeRelayOp === settled) {
        this.activeRelayOp = null;
      }
    }
  }

  async discardPrepared(token: string, verify = false): Promise<WalletSnapshot> {
    const discarded = await this.enqueue(() => this.txFlow.discard(token));
    if ((verify || discarded.wasRelayUnknown) && this.activeWallet) {
      let verificationError: string | null = null;
      try {
        await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
        await this.activeWallet.refreshPool();
        const syncStatus = await this.syncController.syncOnce();
        if (syncStatus.state !== "synced") {
          verificationError =
            syncStatus.errorMessage ??
            "Could not verify mempool or chain state because the node did not finish syncing";
        } else if (this.activeWallet) {
          this.cachedBalances = await this.readBalances(this.activeWallet);
          await this.clearUnresolvedRelayMarkerInternal();
        }
      } catch {
        verificationError =
          "Transaction discarded, but mempool/chain verification failed — sync the wallet before sending again";
      }
      if (verificationError) {
        if (!this.unresolvedRelay && discarded.txHashes.length > 0) {
          await this.persistUnresolvedRelayMarker({
            txHashes: discarded.txHashes,
            recordedAt: Date.now(),
            nodeHost: discarded.nodeHost || validateNodeUrl(this.activeNodeUrl).host,
            reason: "VERIFY_FAILED"
          });
        } else {
          await this.emitSnapshot();
        }
        throw new TxFlowError("VERIFICATION_FAILED", verificationError);
      }
    }
    return await this.emitSnapshot();
  }

  async clearUnresolvedRelay(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      await this.clearUnresolvedRelayMarkerInternal();
      return await this.emitSnapshot();
    });
  }

  async retryPersist(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry || !this.dekKey) {
        throw new TxFlowError("LOCKED", "Wallet must be unlocked");
      }
      const hashes = this.persistFailure?.txHashes ?? [];
      await this.persistPostRelayBlobs(hashes);
      return await this.emitSnapshot();
    });
  }

  async releasePrepared(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      this.txFlow.release();
      return await this.emitSnapshot();
    });
  }

  /**
   * Test seam: attach an offline/mocked wallet into the active engine session
   * with pre-populated balances and reserve status so M1.4 prepare/relay/save
   * flows can be exercised deterministically without broadcasting to mainnet.
   */
  attachTestWalletSession(params: {
    readonly wallet: ZephyrWallet;
    readonly entry: WalletManifestEntry;
    readonly dekKey: CryptoKey;
    readonly balances?: readonly BalanceEntryDto[];
    readonly reserve?: ReserveStatusDto | null;
    readonly daemonHeight?: number;
  }): void {
    this.sessionGeneration += 1;
    this.activeWallet = params.wallet;
    this.activeEntry = toActiveWalletInfo(params.entry);
    this.dekKey = params.dekKey;
    this.unresolvedRelay = null;
    this.cachedBalances =
      params.balances ??
      V2_ASSET_CODES.map((asset) => ({
        asset,
        total: "0",
        unlocked: "0",
        locked: "0"
      }));
    if (params.reserve !== undefined) {
      this.reserveService.seedCachedForTest(params.reserve);
    }
    this.txFlow.attach(params.wallet, params.entry.network, params.entry.viewOnly);
    this.attachSyncForActiveWallet(params.wallet, params.daemonHeight ?? params.entry.restoreHeight);
  }

  async lockWallet(): Promise<WalletSnapshot> {
    // Wait for any in-flight post-relay persistence barrier (and its enclosing relay finalize) before locking.
    if (this.postRelaySavePromise) {
      await this.postRelaySavePromise;
      if (this.activeRelayOp) {
        await this.activeRelayOp;
      }
    }
    if (this.relayBusy || this.txFlow.isRelayInFlight()) {
      throw new TxFlowError(
        "LOCK_DEFERRED",
        "Cannot lock wallet while a transaction relay is in flight."
      );
    }
    if (this.persistFailure && this.activeWallet && this.activeEntry && this.dekKey) {
      try {
        await this.persistPostRelayBlobs(this.persistFailure.txHashes);
      } catch {
        throw new TxFlowError(
          "LOCK_DEFERRED",
          "Cannot lock wallet while post-relay wallet state has not been saved to disk. Retry saving first."
        );
      }
    }
    // Pre-empt any running background or manual sync without waiting on the sync loop.
    await this.closeActiveWalletInternal(true);
    return await this.emitSnapshot();
  }

  async resetVault(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      this.persistFailure = null;
      this.unresolvedRelay = null;
      await this.closeActiveWalletInternal(false);
      await this.store.clearAll();
      this.hasVaultCached = false;
      this.lastPersistedAt = null;
      return await this.emitSnapshot();
    });
  }

  private async closeActiveWalletInternal(persistBeforeClose: boolean): Promise<void> {
    if (this.postRelaySavePromise) {
      await this.postRelaySavePromise;
    }
    const wasSyncing = this.syncBusy || this.syncController.isSyncing();
    await this.txFlow.detach();
    this.syncController.stop();
    this.reserveService.resetForNodeSwitch();

    const wallet = this.activeWallet;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;

    // Attempt a bounded final checkpoint only when no WASM sync is hogging the worker queue.
    if (wallet && persistBeforeClose && !wasSyncing && entry && dekKey) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.persistActiveWalletBlobs(wallet, entry.id, dekKey, "checkpoint"),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.lockCheckpointTimeoutMs);
          })
        ]);
      } catch {
        // Proceed to close/terminate even if final checkpoint fails on lock
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    this.sessionGeneration += 1;
    this.activeWallet = null;
    this.activeManifest = null;
    this.activeEntry = null;
    this.kek = null;
    this.kdf = null;
    this.dekKey = null;
    this.persistFailure = null;
    this.unresolvedRelay = null;
    this.cachedBalances = [];
    this.emitBusyState();

    if (wallet) {
      await this.safeCloseOrTerminate(wallet, wasSyncing);
    }
  }

  private async safeCloseOrTerminate(
    wallet: ZephyrWallet,
    forceTerminate = false
  ): Promise<void> {
    if (wallet.isClosed()) return;
    if (forceTerminate && wallet.proxied) {
      try {
        await wallet.terminate();
      } catch {
        // Best-effort worker termination
      }
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.closeTimeoutMs);
    });
    const closed = wallet.close().then(
      () => "closed" as const,
      () => "failed" as const
    );
    const outcome = await Promise.race([closed, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome !== "closed" && wallet.proxied) {
      try {
        await wallet.terminate();
      } catch {
        // Best-effort worker termination
      }
    }
  }
}

export { TxFlowError, VaultAuthError };
