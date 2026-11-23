import {
  createRandomWallet,
  openWalletData,
  setWasmModuleUrl,
  setWorkerDistPath,
  type ZephyrWallet
} from "@loki-notfound/zephyr-ts";
import { V2_ASSET_CODES } from "../assets/index.js";
import type {
  BalanceEntryDto,
  HostKind,
  WalletSnapshot,
  WalletSummaryDto
} from "../rpc/protocol.js";
import type { VaultBlobStore } from "../storage/types.js";
import {
  decryptVaultMeta,
  decryptWalletBlob,
  encryptVaultMeta,
  encryptWalletBlob,
  generateCorePassword,
  generateDek,
  generateWalletId,
  zeroize
} from "../vault/crypto.js";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  VAULT_SCHEMA_VERSION,
  type VaultManifestPlaintext,
  type WalletManifestEntry
} from "../vault/types.js";

export interface WalletEngineOptions {
  readonly store: VaultBlobStore;
  readonly hostKind: HostKind;
  readonly proxyToWorker?: boolean;
  readonly pbkdf2Iterations?: number;
  readonly wasmModuleUrl?: string;
  readonly workerDistPath?: string;
  readonly onSnapshot?: (snapshot: WalletSnapshot) => void;
}

export class WalletEngine {
  private readonly store: VaultBlobStore;
  private readonly hostKind: HostKind;
  private readonly proxyToWorker: boolean;
  private readonly pbkdf2Iterations: number;
  private readonly onSnapshot: ((snapshot: WalletSnapshot) => void) | undefined;

  private queue: Promise<unknown> = Promise.resolve();
  private activeWallet: ZephyrWallet | null = null;
  private activeEntry: WalletManifestEntry | null = null;
  private dekKey: CryptoKey | null = null;
  private savingState = false;
  private lastPersistedAt: number | null = null;
  private cachedBalances: readonly BalanceEntryDto[] = [];

  constructor(options: WalletEngineOptions) {
    this.store = options.store;
    this.hostKind = options.hostKind;
    this.proxyToWorker = options.proxyToWorker ?? true;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    this.onSnapshot = options.onSnapshot;

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
          createdAt: this.activeEntry.createdAt,
          viewOnly: this.activeEntry.viewOnly
        }
      : null;

    return {
      hasVault: meta !== undefined,
      locked: this.activeWallet === null,
      savingState: this.savingState,
      activeWallet: activeSummary,
      balances: this.cachedBalances,
      lastPersistedAt: this.lastPersistedAt,
      hostKind: this.hostKind
    };
  }

  async getSnapshot(): Promise<WalletSnapshot> {
    return this.enqueue(() => this.buildSnapshot());
  }

  private async readBalances(wallet: ZephyrWallet): Promise<readonly BalanceEntryDto[]> {
    const totalMap = await wallet.getBalance();
    const unlockedMap = await wallet.getUnlockedBalance();
    return V2_ASSET_CODES.map((asset) => ({
      asset,
      total: (totalMap.get(asset) ?? 0n).toString(),
      unlocked: (unlockedMap.get(asset) ?? 0n).toString()
    }));
  }

  private async persistActiveWalletBlobs(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey
  ): Promise<void> {
    this.savingState = true;
    await this.emitSnapshot();
    let keysBytes: Uint8Array | undefined;
    let cacheBytes: Uint8Array | undefined;
    try {
      const data = await wallet.getData();
      keysBytes = data.keys;
      cacheBytes = data.cache;
      const height = await wallet.getHeight();
      const encKeys = await encryptWalletBlob(dekKey, walletId, "keys", keysBytes, height);
      const encCache = await encryptWalletBlob(dekKey, walletId, "cache", cacheBytes, height);
      await this.store.writeBlob(encKeys);
      await this.store.writeBlob(encCache);
      this.lastPersistedAt = Date.now();
    } finally {
      zeroize(keysBytes);
      zeroize(cacheBytes);
      this.savingState = false;
    }
  }

  async createDisposableWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: "mainnet" | "testnet" | "stagenet";
  }): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      if (params.password.length < 8) {
        throw new Error("Vault password must be at least 8 characters");
      }
      await this.closeActiveWalletInternal(false);

      const network = params.network ?? "mainnet";
      const corePassword = generateCorePassword();
      const walletId = generateWalletId();
      const { dekKey, dekBase64 } = await generateDek();

      const wallet = await createRandomWallet({
        networkType: network,
        password: corePassword,
        proxyToWorker: this.proxyToWorker
      });

      try {
        const primaryAddress = await wallet.getPrimaryAddress();
        const restoreHeight = await wallet.getRestoreHeight();
        const entry: WalletManifestEntry = {
          id: walletId,
          name: params.name.trim() || "Disposable Wallet",
          network,
          restoreHeight,
          createdAt: new Date().toISOString(),
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

        const { record } = await encryptVaultMeta(manifest, params.password, {
          iterations: this.pbkdf2Iterations
        });
        await this.store.writeMeta(record);
        await this.persistActiveWalletBlobs(wallet, walletId, dekKey);

        this.activeWallet = wallet;
        this.activeEntry = entry;
        this.dekKey = dekKey;
        this.cachedBalances = await this.readBalances(wallet);
        return await this.emitSnapshot();
      } catch (err) {
        await this.safeCloseOrTerminate(wallet);
        throw err;
      }
    });
  }

  async unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      const meta = await this.store.readMeta();
      if (!meta) {
        throw new Error("No vault found");
      }
      const { manifest, dekKey } = await decryptVaultMeta(meta, password);
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

        this.activeWallet = wallet;
        this.activeEntry = entry;
        this.dekKey = dekKey;
        this.lastPersistedAt = encCache?.updatedAt ?? encKeys.updatedAt;
        this.cachedBalances = await this.readBalances(wallet);
        return await this.emitSnapshot();
      } finally {
        zeroize(keysData);
        zeroize(cacheData);
      }
    });
  }

  async lockWallet(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      await this.closeActiveWalletInternal(true);
      return await this.emitSnapshot();
    });
  }

  async resetVault(): Promise<WalletSnapshot> {
    return this.enqueue(async () => {
      await this.closeActiveWalletInternal(false);
      await this.store.clearAll();
      this.lastPersistedAt = null;
      return await this.emitSnapshot();
    });
  }

  private async closeActiveWalletInternal(persistBeforeClose: boolean): Promise<void> {
    const wallet = this.activeWallet;
    const entry = this.activeEntry;
    const dekKey = this.dekKey;

    if (wallet && persistBeforeClose && entry && dekKey) {
      try {
        await this.persistActiveWalletBlobs(wallet, entry.id, dekKey);
      } catch {
        // Proceed to close/terminate even if final checkpoint fails on lock
      }
    }

    this.activeWallet = null;
    this.activeEntry = null;
    this.dekKey = null;
    this.cachedBalances = [];

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
        wallet.terminate();
      } catch {
        // Best-effort worker termination
      }
    }
  }
}
