import { describe, expect, it } from "vitest";
import {
  decryptVaultMeta,
  decryptWalletBlob,
  encryptVaultMeta,
  encryptWalletBlob,
  generateCorePassword,
  generateDek,
  generateWalletId,
  zeroize
} from "./crypto.js";
import { VAULT_SCHEMA_VERSION, type VaultManifestPlaintext } from "./types.js";

const FAST_TEST_ITERATIONS = 10_000;

describe("vault WebCrypto envelope (KEK -> vault_meta[DEK + corePassword] -> wallet_blobs)", () => {
  it("encrypts and decrypts vault_meta and wallet_blobs with AAD binding", async () => {
    const { dekKey, dekBase64 } = await generateDek();
    const walletId = generateWalletId();
    const corePassword = generateCorePassword();
    expect(corePassword).toMatch(/^[0-9a-f]{64}$/);

    const manifest: VaultManifestPlaintext = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      dek: dekBase64,
      wallets: [
        {
          id: walletId,
          name: "Test Wallet",
          network: "mainnet",
          restoreHeight: 0,
          createdAt: "2026-11-22T00:00:00Z",
          viewOnly: false,
          seedBackupVerified: false,
          corePassword,
          primaryAddress: "ZEPHs0000EXAMPLE"
        }
      ]
    };

    const { record } = await encryptVaultMeta(manifest, "correct-horse-battery-staple", {
      iterations: FAST_TEST_ITERATIONS
    });
    expect(record.kdf.alg).toBe("PBKDF2-SHA256");

    const unlocked = await decryptVaultMeta(record, "correct-horse-battery-staple");
    expect(unlocked.manifest.wallets[0]?.corePassword).toBe(corePassword);

    const keysBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const cacheBytes = new Uint8Array([9, 10, 11, 12]);
    const encKeys = await encryptWalletBlob(dekKey, walletId, "keys", keysBytes, 0);
    const encCache = await encryptWalletBlob(dekKey, walletId, "cache", cacheBytes, 123);

    expect(await decryptWalletBlob(unlocked.dekKey, encKeys)).toEqual(keysBytes);
    expect(await decryptWalletBlob(unlocked.dekKey, encCache)).toEqual(cacheBytes);

    // Reject wrong vault password
    await expect(decryptVaultMeta(record, "wrong-password")).rejects.toThrow();

    // Reject swapped blob kind (AAD mismatch)
    const swapped = { ...encKeys, kind: "cache" as const, key: `${walletId}:cache` as const };
    await expect(decryptWalletBlob(unlocked.dekKey, swapped)).rejects.toThrow();

    // Reject tampered ciphertext
    const tamperedBytes = new Uint8Array(encKeys.ciphertext);
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    await expect(
      decryptWalletBlob(unlocked.dekKey, { ...encKeys, ciphertext: tamperedBytes })
    ).rejects.toThrow();
  });

  it("rotates vault password atomically without touching encrypted wallet blobs", async () => {
    const { dekKey, dekBase64 } = await generateDek();
    const walletId = generateWalletId();
    const manifest: VaultManifestPlaintext = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      dek: dekBase64,
      wallets: []
    };

    const blob = await encryptWalletBlob(dekKey, walletId, "keys", new Uint8Array([42, 43]), 0);
    const first = await encryptVaultMeta(manifest, "old-password", {
      iterations: FAST_TEST_ITERATIONS
    });
    const unlockedOld = await decryptVaultMeta(first.record, "old-password");
    const rotated = await encryptVaultMeta(unlockedOld.manifest, "new-password", {
      iterations: FAST_TEST_ITERATIONS
    });

    await expect(decryptVaultMeta(rotated.record, "old-password")).rejects.toThrow();
    const unlockedNew = await decryptVaultMeta(rotated.record, "new-password");
    expect(await decryptWalletBlob(unlockedNew.dekKey, blob)).toEqual(new Uint8Array([42, 43]));
  });

  it("zeroizes byte buffers in place", () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    zeroize(buf);
    expect(buf).toEqual(new Uint8Array([0, 0, 0, 0]));
  });
});
