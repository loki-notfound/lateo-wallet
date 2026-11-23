import { describe, expect, it } from "vitest";
import type { VaultBlobStore } from "../storage/types.js";
import { VaultAuthError } from "../vault/crypto.js";
import { splitMnemonicWords } from "../vault/seed-quiz.js";
import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind
} from "../vault/types.js";
import { WalletEngine } from "./wallet-engine.js";

class MemoryVaultStore implements VaultBlobStore {
  meta: EncryptedVaultMetaRecord | undefined = undefined;
  readonly blobs = new Map<string, EncryptedWalletBlobRecord>();
  readonly writeOrder: string[] = [];

  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    return this.meta;
  }

  async writeMeta(record: EncryptedVaultMetaRecord): Promise<void> {
    this.writeOrder.push("meta");
    this.meta = record;
  }

  async readBlob(
    walletId: string,
    kind: WalletBlobKind
  ): Promise<EncryptedWalletBlobRecord | undefined> {
    return this.blobs.get(`${walletId}:${kind}`);
  }

  async writeBlob(record: EncryptedWalletBlobRecord): Promise<void> {
    this.writeOrder.push(`blob:${record.kind}`);
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

describe("WalletEngine M1.2 vault lifecycle", () => {
  it("creates wallet with daemon height, writes blobs before meta, verifies backup, rotates password, reveals secrets, restores seed & view-only, and resets", async () => {
    const store = new MemoryVaultStore();
    const engine = new WalletEngine({
      store,
      hostKind: "memory",
      proxyToWorker: true,
      pbkdf2Iterations: 10_000,
      fetchDaemonHeight: async () => 912_345
    });

    // 1. Create wallet with daemon height captured
    const created = await engine.createWallet({
      password: "initial-vault-password",
      name: "M1.2 Test Wallet",
      network: "mainnet"
    });
    expect(created.restoreHeight).toBe(912_345);
    expect(created.restoreHeightSource).toBe("daemon");
    expect(splitMnemonicWords(created.seed).length).toBe(25);
    expect(created.snapshot.activeWallet?.primaryAddress).toMatch(/^ZEPHYR/);
    expect(created.snapshot.activeWallet?.seedBackupVerified).toBe(false);
    expect(created.snapshot.activeWallet?.viewOnly).toBe(false);
    // Secret seed must NEVER appear in snapshot
    expect(JSON.stringify(created.snapshot)).not.toContain(created.seed);
    // Safe write order: blobs persisted BEFORE vault_meta
    expect(store.writeOrder).toEqual(["blob:keys", "blob:cache", "meta"]);

    const primaryAddress = created.snapshot.activeWallet!.primaryAddress;

    // 2. Mark seed backup verified
    const verifiedSnap = await engine.markSeedBackupVerified();
    expect(verifiedSnap.activeWallet?.seedBackupVerified).toBe(true);

    // 3. Danger Zone reveal requires password verification
    await expect(engine.revealSecrets("wrong-password")).rejects.toBeInstanceOf(VaultAuthError);
    const revealed = await engine.revealSecrets("initial-vault-password");
    expect(revealed.seed).toBe(created.seed);
    expect(revealed.primaryAddress).toBe(primaryAddress);
    expect(revealed.privateViewKey).toMatch(/^[0-9a-f]{64}$/);
    expect(revealed.privateSpendKey).toMatch(/^[0-9a-f]{64}$/);
    expect(revealed.viewOnly).toBe(false);

    // 4. Password rotation re-wraps vault_meta without rewriting wallet_blobs
    const blobCountBeforeRotate = store.writeOrder.filter((x) => x.startsWith("blob:")).length;
    const oldSalt = store.meta!.kdf.salt;
    await expect(
      engine.changeVaultPassword({
        currentPassword: "wrong-password",
        newPassword: "rotated-vault-password"
      })
    ).rejects.toBeInstanceOf(VaultAuthError);

    await engine.changeVaultPassword({
      currentPassword: "initial-vault-password",
      newPassword: "rotated-vault-password"
    });
    expect(store.meta!.kdf.salt).not.toBe(oldSalt);
    expect(store.writeOrder.filter((x) => x.startsWith("blob:")).length).toBe(blobCountBeforeRotate);

    // 5. Lock -> old password fails -> new password unlocks identical wallet
    await engine.lockWallet();
    await expect(engine.unlockWallet("initial-vault-password")).rejects.toBeInstanceOf(
      VaultAuthError
    );
    const reopened = await engine.unlockWallet("rotated-vault-password");
    expect(reopened.activeWallet?.primaryAddress).toBe(primaryAddress);
    expect(reopened.activeWallet?.seedBackupVerified).toBe(true);
    expect(reopened.activeWallet?.restoreHeight).toBe(912_345);

    // 6. Reset vault wipes blobs and metadata cleanly
    const resetSnap = await engine.resetVault();
    expect(resetSnap.hasVault).toBe(false);
    expect(resetSnap.locked).toBe(true);
    expect(store.meta).toBeUndefined();
    expect(store.blobs.size).toBe(0);

    // 7. Restore from 25-word seed round-trips to identical primary address
    const restoredSeed = await engine.restoreFromSeed({
      password: "seed-restore-password",
      name: "Restored From Seed",
      seed: created.seed,
      restoreHeight: 900_000,
      network: "mainnet"
    });
    expect(restoredSeed.activeWallet?.primaryAddress).toBe(primaryAddress);
    expect(restoredSeed.activeWallet?.restoreHeight).toBe(900_000);
    expect(restoredSeed.activeWallet?.restoreHeightSource).toBe("user");
    expect(restoredSeed.activeWallet?.seedBackupVerified).toBe(true);
    expect(restoredSeed.activeWallet?.viewOnly).toBe(false);

    // 8. Restore view-only wallet from primaryAddress + privateViewKey
    const restoredViewOnly = await engine.restoreViewOnly({
      password: "view-only-password",
      name: "Watch Wallet",
      primaryAddress,
      privateViewKey: revealed.privateViewKey,
      restoreHeight: 905_000,
      network: "mainnet"
    });
    expect(restoredViewOnly.activeWallet?.primaryAddress).toBe(primaryAddress);
    expect(restoredViewOnly.activeWallet?.viewOnly).toBe(true);
    expect(restoredViewOnly.activeWallet?.restoreHeight).toBe(905_000);

    const viewSecrets = await engine.revealSecrets("view-only-password");
    expect(viewSecrets.viewOnly).toBe(true);
    expect(viewSecrets.seed).toBeNull();
    expect(viewSecrets.privateSpendKey).toBeNull();
    expect(viewSecrets.privateViewKey).toBe(revealed.privateViewKey);

    await engine.lockWallet();
  }, 120_000);

  it("falls back cleanly to offline-estimate restore height when daemon height is unavailable", async () => {
    const store = new MemoryVaultStore();
    const engine = new WalletEngine({
      store,
      hostKind: "memory",
      proxyToWorker: true,
      pbkdf2Iterations: 10_000,
      fetchDaemonHeight: async () => null
    });

    const created = await engine.createWallet({
      password: "offline-vault-password",
      name: "Offline Wallet",
      network: "mainnet"
    });
    expect(created.restoreHeightSource).toBe("offline-estimate");
    expect(created.restoreHeight).toBeGreaterThanOrEqual(0);
    await engine.lockWallet();
  }, 60_000);
});
