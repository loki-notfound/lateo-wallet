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
import { MIN_VAULT_PASSWORD_LENGTH } from "../vault/password.js";
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
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export interface WalletEngineOptions {
  readonly store: VaultBlobStore;
  readonly hostKind: HostKind;
  readonly proxyToWorker?: boolean;
  readonly pbkdf2Iterations?: number;
  readonly defaultNodeUrl?: string;
  readonly syncIntervalMs?: number;
  readonly enableBackgroundSync?: boolean;
  readonly heightFetchTimeoutMs?: number;
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
    throw new Error(`${label} must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters`);
  }
}

function assertValidRestoreHeight(height: number): void {
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
    throw new Error("Restore height must be a non-negative whole number");
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
  private queue: Promise<unknown> = Promise.resolve();
  private activeWallet: ZephyrWallet | null = null;
  private activeManifest: VaultManifestPlaintext | null = null;
  private activeEntry: WalletManifestEntry | null = null;
  private kek: CryptoKey | null = null;
  private kdf: KdfDescriptor | null = null;
  private dekKey: CryptoKey | null = null;
  private savingState = false;
  private savingKind: SavingKind | null = null;
  private persistFailure: PersistFailureDto | null = null;
  private postRelaySavePromise: Promise<void> | null = null;
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
      blockNewTransaction: () =>
        this.persistFailure
          ? "A previous transaction was relayed, but wallet state has not been saved to disk yet. Retry saving first."
          : null,
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
        if (this.activeWallet) {
          await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
        }
      },
      afterRelay: () => {
        this.relayBusy = false;
        this.emitBusyState();
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

  private async emitSnapshot(): Promise<WalletSnapshot> {
    const snap = await this.buildSnapshot();
    this.onSnapshot?.(snap);
    return snap;
  }

  private async buildSnapshot(): Promise<WalletSnapshot> {
    const meta = await this.store.readMeta();
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
      hasVault: meta !== undefined,
      locked: this.activeWallet === null,
      savingState: this.savingState,
      savingKind: this.savingKind,
      pendingTx: this.txFlow.getPending(),
      persistFailure: this.persistFailure,
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
      this.savingState ||
      this.relayBusy ||
      this.txFlow.isRelayInFlight() ||
      this.postRelaySavePromise !== null ||
      this.persistFailure !== null
    );
  }

  async getSnapshot(): Promise<WalletSnapshot> {
    return this.enqueue(() => this.buildSnapshot());
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

  private async commitNewVault(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey,
    metaRecord: EncryptedVaultMetaRecord
  ): Promise<void> {
    this.savingState = true;
    this.savingKind = "checkpoint";
    this.emitBusyState();
    await this.emitSnapshot();
    try {
      const blobs = await this.encryptActiveWalletBlobs(wallet, walletId, dekKey);
      if (this.store.writeVaultAtomic) {
        await this.store.writeVaultAtomic(metaRecord, blobs);
      } else {
        await this.store.writeBlob(blobs[0]);
        await this.store.writeBlob(blobs[1]);
        await this.store.writeMeta(metaRecord);
      }
      this.lastPersistedAt = Date.now();
    } finally {
      this.savingState = false;
      this.savingKind = null;
      this.emitBusyState();
    }
  }

  private async persistActiveWalletBlobs(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey,
    kind: SavingKind = "checkpoint"
  ): Promise<void> {
    this.savingState = true;
    this.savingKind = kind;
    this.emitBusyState();
    await this.emitSnapshot();
    try {
      const [encKeys, encCache] = await this.encryptActiveWalletBlobs(wallet, walletId, dekKey);
      if (this.store.writeBlobsAtomic) {
        await this.store.writeBlobsAtomic([encKeys, encCache]);
      } else {
        await this.store.writeBlob(encKeys);
        await this.store.writeBlob(encCache);
      }
      this.lastPersistedAt = Date.now();
      this.persistFailure = null;
    } finally {
      this.savingState = false;
      this.savingKind = null;
      this.emitBusyState();
    }
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
        this.persistFailure = {
          txHashes: [...txHashes],
          failedAt: Date.now(),
          message:
            err instanceof Error && err.message
              ? err.message
              : "IndexedDB commit failed after relay"
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

  async createWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: ZephyrNetwork;
  }): Promise<CreateWalletResultDto> {
    return this.enqueue(async () => {
      assertValidPassword(params.password);
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

        this.activeWallet = wallet;
        this.activeManifest = manifest;
        this.activeEntry = entry;
        this.kek = kek;
        this.kdf = kdf;
        this.dekKey = dekKey;
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
        throw new Error(`Recovery seed must contain 25 words (received ${wordCheck.count})`);
      }

      await this.closeActiveWalletInternal(false);

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
        throw new Error("Invalid 25-word recovery seed or checksum");
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

        const { record, kek, kdf } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.commitNewVault(wallet, walletId, dekKey, record);

        this.activeWallet = wallet;
        this.activeManifest = manifest;
        this.activeEntry = entry;
        this.kek = kek;
        this.kdf = kdf;
        this.dekKey = dekKey;
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
        throw new Error("Primary address is required");
      }
      if (!HEX_64_RE.test(viewKey)) {
        throw new Error("Private view key must be 64 hexadecimal characters");
      }
      try {
        await validateAddress(address, network);
      } catch {
        throw new Error(`Invalid Zephyr ${network} address`);
      }

      await this.closeActiveWalletInternal(false);

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
        throw new Error("Address and private view key could not be verified");
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

        const { record, kek, kdf } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.commitNewVault(wallet, walletId, dekKey, record);

        this.activeWallet = wallet;
        this.activeManifest = manifest;
        this.activeEntry = entry;
        this.kek = kek;
        this.kdf = kdf;
        this.dekKey = dekKey;
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
      if (!this.activeWallet || !this.activeEntry || !this.activeManifest || !this.kek || !this.kdf) {
        throw new Error("Wallet must be unlocked to update backup status");
      }
      if (this.activeEntry.seedBackupVerified) {
        return await this.buildSnapshot();
      }
      const updatedEntry: WalletManifestEntry = {
        ...this.activeEntry,
        seedBackupVerified: true
      };
      const updatedManifest: VaultManifestPlaintext = {
        ...this.activeManifest,
        wallets: this.activeManifest.wallets.map((w) =>
          w.id === updatedEntry.id ? updatedEntry : w
        )
      };
      const updatedMeta = await encryptVaultMetaWithKek(updatedManifest, this.kek, this.kdf);
      await this.store.writeMeta(updatedMeta);
      this.activeEntry = updatedEntry;
      this.activeManifest = updatedManifest;
      return await this.emitSnapshot();
    });
  }

  async unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      const meta = await this.store.readMeta();
      if (!meta) {
        throw new Error("No vault found");
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

        const normalizedEntry: WalletManifestEntry = {
          ...entry,
          restoreHeightSource: entry.restoreHeightSource ?? "offline-estimate"
        };

        this.activeWallet = wallet;
        this.activeManifest = manifest;
        this.activeEntry = normalizedEntry;
        this.kek = kek;
        this.kdf = kdf;
        this.dekKey = dekKey;
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
        throw new Error("Wallet must be unlocked to change password");
      }
      assertValidPassword(params.newPassword, "New vault password");
      if (params.currentPassword === params.newPassword) {
        throw new Error("New password must differ from current password");
      }

      const existingMeta = await this.store.readMeta();
      if (!existingMeta) {
        throw new Error("No vault found");
      }

      const { manifest } = await decryptVaultMeta(existingMeta, params.currentPassword);
      const { record, kek, kdf } = await encryptVaultMeta(manifest, params.newPassword, {
        iterations: this.pbkdf2Iterations
      });
      await this.store.writeMeta(record);

      this.activeManifest = manifest;
      this.kek = kek;
      this.kdf = kdf;
    });
  }

  async revealSecrets(password: string): Promise<RevealedSecretsDto> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry) {
        throw new Error("Wallet must be unlocked to reveal secrets");
      }
      const existingMeta = await this.store.readMeta();
      if (!existingMeta) {
        throw new Error("No vault found");
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
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        return await this.buildSnapshot();
      }
      await this.syncController.syncOnce();
      return await this.emitSnapshot();
    });
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
    return this.enqueue(async () => {
      const validated = validateNodeUrl(rawUrl);
      this.activeNodeUrl = validated.url;
      this.txFlow.release();
      this.syncController.setNodeUrl(validated.url);
      this.reserveService.resetForNodeSwitch();
      if (this.activeWallet) {
        await this.activeWallet.setDaemonConnection(validated.url);
        await this.syncController.syncOnce();
      }
      return await this.emitSnapshot();
    });
  }

  async listSubaddresses(): Promise<readonly SubaddressDto[]> {
    return this.enqueue(async () => {
      if (!this.activeWallet) {
        throw new Error("Wallet must be unlocked");
      }
      const list = await this.activeWallet.getSubaddresses(0);
      return list.map(mapSubaddress);
    });
  }

  async createSubaddress(label?: string): Promise<SubaddressDto> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry || !this.dekKey) {
        throw new Error("Wallet must be unlocked");
      }
      const cleanLabel = (label ?? "").trim().slice(0, 120);
      const sub = await this.activeWallet.createSubaddress(0, cleanLabel);
      await this.persistActiveWalletBlobs(this.activeWallet, this.activeEntry.id, this.dekKey);
      await this.emitSnapshot();
      return mapSubaddress(sub);
    });
  }

  async setSubaddressLabel(index: number, label: string): Promise<readonly SubaddressDto[]> {
    return this.enqueue(async () => {
      if (!this.activeWallet || !this.activeEntry || !this.dekKey) {
        throw new Error("Wallet must be unlocked");
      }
      const cleanLabel = label.trim().slice(0, 120);
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
    return this.enqueue(() => this.txFlow.relay(token));
  }

  async discardPrepared(token: string, verify = false): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      const { wasRelayUnknown } = await this.txFlow.discard(token);
      if ((verify || wasRelayUnknown) && this.activeWallet) {
        try {
          await this.activeWallet.setDaemonConnection(this.activeNodeUrl);
          await this.activeWallet.refreshPool().catch(() => 0);
          await this.syncController.syncOnce();
          if (this.activeWallet) {
            this.cachedBalances = await this.readBalances(this.activeWallet);
          }
        } catch {
          // Best-effort pool refresh + sync verification after discard
        }
      }
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
    this.activeWallet = params.wallet;
    this.activeEntry = params.entry;
    this.dekKey = params.dekKey;
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
    if (this.postRelaySavePromise) {
      await this.postRelaySavePromise;
    }
    return this.enqueue(async () => {
      if (this.postRelaySavePromise) {
        await this.postRelaySavePromise;
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
      await this.closeActiveWalletInternal(true);
      return await this.emitSnapshot();
    });
  }

  async resetVault(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      this.persistFailure = null;
      await this.closeActiveWalletInternal(false);
      await this.store.clearAll();
      this.lastPersistedAt = null;
      return await this.emitSnapshot();
    });
  }

  private async closeActiveWalletInternal(persistBeforeClose: boolean): Promise<void> {
    if (this.postRelaySavePromise) {
      await this.postRelaySavePromise;
    }
    await this.txFlow.detach();
    this.syncController.stop();
    this.reserveService.resetForNodeSwitch();

    const wallet = this.activeWallet;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;

    if (wallet && persistBeforeClose && entry && dekKey) {
      try {
        await this.persistActiveWalletBlobs(wallet, entry.id, dekKey, "checkpoint");
      } catch {
        // Proceed to close/terminate even if final checkpoint fails on lock
      }
    }

    this.activeWallet = null;
    this.activeManifest = null;
    this.activeEntry = null;
    this.kek = null;
    this.kdf = null;
    this.dekKey = null;
    this.persistFailure = null;
    this.cachedBalances = [];
    this.emitBusyState();

    if (wallet) {
      await this.safeCloseOrTerminate(wallet);
    }
  }

  private async safeCloseOrTerminate(wallet: ZephyrWallet): Promise<void> {
    if (wallet.isClosed()) return;
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000));
    const closed = wallet.close().then(
      () => "closed" as const,
      () => "failed" as const
    );
    const outcome = await Promise.race([closed, timeout]);
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
