import { describe, expect, it } from "vitest";
import type { VaultBlobStore } from "../storage/types.js";
import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind
} from "../vault/types.js";
import { WalletEngine } from "./wallet-engine.js";

class MemoryVaultStore implements VaultBlobStore {
  meta: EncryptedVaultMetaRecord | undefined = undefined;
  readonly blobs = new Map<string, EncryptedWalletBlobRecord>();

  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    return this.meta;
  }

  async writeMeta(record: EncryptedVaultMetaRecord): Promise<void> {
    this.meta = record;
  }

  async readBlob(
    walletId: string,
    kind: WalletBlobKind
  ): Promise<EncryptedWalletBlobRecord | undefined> {
    return this.blobs.get(`${walletId}:${kind}`);
  }

  async writeBlob(record: EncryptedWalletBlobRecord): Promise<void> {
    this.blobs.set(record.key, record);
  }

  async deleteWalletBlobs(walletId: string): Promise<void> {
    this.blobs.delete(`${walletId}:keys`);
    this.blobs.delete(`${walletId}:cache`);
  }

  async clearAll(): Promise<void> {
    this.meta = undefined;
    this.blobs.clear();
  }
}

describe("WalletEngine offline create -> persist -> lock -> unlock lifecycle", () => {
  it("creates a disposable random wallet, encrypts bytes, locks, and reopens offline", async () => {
    const store = new MemoryVaultStore();
    const engine = new WalletEngine({
      store,
      hostKind: "memory",
      proxyToWorker: true,
      pbkdf2Iterations: 10_000
    });

    const initial = await engine.getSnapshot();
    expect(initial.hasVault).toBe(false);
    expect(initial.locked).toBe(true);

    const created = await engine.createDisposableWallet({
      password: "disposable-test-password",
      name: "Spike Wallet",
      network: "mainnet"
    });
    expect(created.hasVault).toBe(true);
    expect(created.locked).toBe(false);
    expect(created.activeWallet?.primaryAddress).toMatch(/^ZEPHYR/);
    expect(created.balances.map((b) => b.asset)).toEqual(["ZPH", "ZSD", "ZRS", "ZYS"]);
    expect(store.meta).toBeDefined();
    expect(store.blobs.size).toBe(2);

    const createdAddress = created.activeWallet?.primaryAddress;

    const locked = await engine.lockWallet();
    expect(locked.hasVault).toBe(true);
    expect(locked.locked).toBe(true);
    expect(locked.activeWallet).toBeNull();

    await expect(engine.unlockWallet("wrong-password-123")).rejects.toThrow();

    const reopened = await engine.unlockWallet("disposable-test-password");
    expect(reopened.locked).toBe(false);
    expect(reopened.activeWallet?.primaryAddress).toBe(createdAddress);

    await engine.lockWallet();
  }, 60_000);
});
