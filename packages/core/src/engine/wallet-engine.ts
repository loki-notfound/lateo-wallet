import {
  ZephyrDaemonRpc,
  createRandomWallet,
  openWalletData,
  restoreWalletFromKeys,
  restoreWalletFromSeed,
  setWasmModuleUrl,
  setWorkerDistPath,
  validateAddress,
  type ZephyrWallet
} from "@loki-notfound/zephyr-ts";
import { V2_ASSET_CODES } from "../assets/index.js";
import type {
  BalanceEntryDto,
  CreateWalletResultDto,
  HostKind,
  RevealedSecretsDto,
  WalletSnapshot,
  WalletSummaryDto,
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

const DEFAULT_PUBLIC_NODE_URL = "https://node.lateo.dev";
const DEFAULT_HEIGHT_FETCH_TIMEOUT_MS = 4_000;
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export interface WalletEngineOptions {
  readonly store: VaultBlobStore;
  readonly hostKind: HostKind;
  readonly proxyToWorker?: boolean;
  readonly pbkdf2Iterations?: number;
  readonly defaultNodeUrl?: string;
  readonly heightFetchTimeoutMs?: number;
  /**
   * Optional override for capturing the live daemon height during Create Wallet.
   * Returns a non-negative integer height or null if offline/unavailable.
   */
  readonly fetchDaemonHeight?: (network: ZephyrNetwork) => Promise<number | null>;
  readonly wasmModuleUrl?: string;
  readonly workerDistPath?: string;
  readonly onSnapshot?: (snapshot: WalletSnapshot) => void;
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
  try {
    const rpc = new ZephyrDaemonRpc(nodeUrl);
    const heightPromise = rpc.getHeight();
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs)
    );
    const result = await Promise.race([heightPromise, timeoutPromise]);
    if (typeof result === "number" && Number.isSafeInteger(result) && result >= 0) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

export class WalletEngine {
  private readonly store: VaultBlobStore;
  private readonly hostKind: HostKind;
  private readonly proxyToWorker: boolean;
  private readonly pbkdf2Iterations: number;
  private readonly defaultNodeUrl: string;
  private readonly heightFetchTimeoutMs: number;
  private readonly fetchDaemonHeightFn: (network: ZephyrNetwork) => Promise<number | null>;
  private readonly onSnapshot: ((snapshot: WalletSnapshot) => void) | undefined;

  private queue: Promise<unknown> = Promise.resolve();
  private activeWallet: ZephyrWallet | null = null;
  private activeManifest: VaultManifestPlaintext | null = null;
  private activeEntry: WalletManifestEntry | null = null;
  private kek: CryptoKey | null = null;
  private kdf: KdfDescriptor | null = null;
  private dekKey: CryptoKey | null = null;
  private savingState = false;
  private lastPersistedAt: number | null = null;
  private cachedBalances: readonly BalanceEntryDto[] = [];

  constructor(options: WalletEngineOptions) {
    this.store = options.store;
    this.hostKind = options.hostKind;
    this.proxyToWorker = options.proxyToWorker ?? true;
    this.pbkdf2Iterations = options.pbkdf2Iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    this.defaultNodeUrl = options.defaultNodeUrl ?? DEFAULT_PUBLIC_NODE_URL;
    this.heightFetchTimeoutMs = options.heightFetchTimeoutMs ?? DEFAULT_HEIGHT_FETCH_TIMEOUT_MS;
    this.fetchDaemonHeightFn =
      options.fetchDaemonHeight ??
      ((network) =>
        network === "mainnet"
          ? fetchHeightFromDaemon(this.defaultNodeUrl, this.heightFetchTimeoutMs)
          : Promise.resolve(null));
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

  /**
   * Commit initial vault creation/restore safely: either via a single multi-store
   * atomic IndexedDB transaction or by writing blobs BEFORE vault_meta so a crash
   * never leaves an orphaned vault_meta referencing missing blobs.
   */
  private async commitNewVault(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey,
    metaRecord: EncryptedVaultMetaRecord
  ): Promise<void> {
    this.savingState = true;
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
    }
  }

  private async persistActiveWalletBlobs(
    wallet: ZephyrWallet,
    walletId: string,
    dekKey: CryptoKey
  ): Promise<void> {
    this.savingState = true;
    await this.emitSnapshot();
    try {
      const [encKeys, encCache] = await this.encryptActiveWalletBlobs(wallet, walletId, dekKey);
      await this.store.writeBlob(encKeys);
      await this.store.writeBlob(encCache);
      this.lastPersistedAt = Date.now();
    } finally {
      this.savingState = false;
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

      const [wallet, daemonHeight] = await Promise.all([
        createRandomWallet({
          networkType: network,
          password: corePassword,
          proxyToWorker: this.proxyToWorker
        }),
        this.fetchDaemonHeightFn(network)
      ]);

      try {
        const primaryAddress = await wallet.getPrimaryAddress();
        const seed = await wallet.getSeed();
        if (!seed) {
          throw new Error("Created wallet did not return a recovery seed");
        }
        const coreEstimateHeight = await wallet.getRestoreHeight();
        const restoreHeight = daemonHeight !== null ? daemonHeight : coreEstimateHeight;
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

      // Cryptographically verify current password against persisted vault_meta
      const { manifest } = await decryptVaultMeta(existingMeta, params.currentPassword);

      // Re-wrap the existing DEK + manifest under fresh salt, fresh IV, and 600k PBKDF2
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
      // Verify vault password on every reveal call
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
    this.activeManifest = null;
    this.activeEntry = null;
    this.kek = null;
    this.kdf = null;
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

export { VaultAuthError };
