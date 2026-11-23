import { describe, expect, it } from "vitest";
import {
  VaultAuthError,
  decryptVaultMeta,
  decryptWalletBlob,
  encryptVaultMeta,
  encryptWalletBlob,
  fromBase64,
  generateCorePassword,
  generateDek,
  generateWalletId,
  toBase64,
  zeroize
} from "./crypto.js";
import { evaluatePasswordStrength } from "./password.js";
import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  VAULT_SCHEMA_VERSION,
  type VaultManifestPlaintext
} from "./types.js";

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
          restoreHeightSource: "offline-estimate",
          createdAt: "2026-11-22T00:00:00Z",
          viewOnly: false,
          seedBackupVerified: false,
          corePassword,
          primaryAddress: "ZEPHYR0000EXAMPLE"
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

    // Reject wrong vault password with sanitized VaultAuthError
    await expect(decryptVaultMeta(record, "wrong-password")).rejects.toBeInstanceOf(VaultAuthError);

    // Reject tampered vault_meta ciphertext
    const rawMetaCt = fromBase64(record.ciphertext);
    rawMetaCt[0] = (rawMetaCt[0] ?? 0) ^ 0xff;
    await expect(
      decryptVaultMeta(
        { ...record, ciphertext: toBase64(rawMetaCt) },
        "correct-horse-battery-staple"
      )
    ).rejects.toBeInstanceOf(VaultAuthError);

    // Reject swapped blob kind (AAD mismatch)
    const swapped = { ...encKeys, kind: "cache" as const, key: `${walletId}:cache` as const };
    await expect(decryptWalletBlob(unlocked.dekKey, swapped)).rejects.toThrow();

    // Reject swapped walletId (AAD mismatch)
    const wrongWallet = {
      ...encKeys,
      walletId: generateWalletId()
    };
    await expect(decryptWalletBlob(unlocked.dekKey, wrongWallet)).rejects.toThrow();

    // Reject tampered blob ciphertext
    const tamperedBytes = new Uint8Array(encKeys.ciphertext);
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
    await expect(
      decryptWalletBlob(unlocked.dekKey, { ...encKeys, ciphertext: tamperedBytes })
    ).rejects.toThrow();
  });

  it("rotates vault password atomically with fresh salt and IV without touching wallet blobs", async () => {
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

    expect(rotated.record.kdf.salt).not.toBe(first.record.kdf.salt);
    expect(rotated.record.iv).not.toBe(first.record.iv);

    await expect(decryptVaultMeta(rotated.record, "old-password")).rejects.toBeInstanceOf(
      VaultAuthError
    );
    const unlockedNew = await decryptVaultMeta(rotated.record, "new-password");
    expect(await decryptWalletBlob(unlockedNew.dekKey, blob)).toEqual(new Uint8Array([42, 43]));
  });

  it("zeroizes byte buffers in place", () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    zeroize(buf);
    expect(buf).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("enforces KDF bounds, IV/salt length checks, and AAD authentication of KDF and syncedHeight", async () => {
    const { dekKey, dekBase64 } = await generateDek();
    const walletId = generateWalletId();
    const manifest: VaultManifestPlaintext = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      dek: dekBase64,
      wallets: []
    };

    const { record } = await encryptVaultMeta(manifest, "Strong-Passphrase!2026", {
      iterations: FAST_TEST_ITERATIONS
    });

    // Reject out-of-bounds KDF iterations before deriving key
    await expect(
      decryptVaultMeta(
        { ...record, kdf: { ...record.kdf, iterations: MIN_PBKDF2_ITERATIONS - 1 } },
        "Strong-Passphrase!2026"
      )
    ).rejects.toThrow(/out of bounds/i);
    await expect(
      decryptVaultMeta(
        { ...record, kdf: { ...record.kdf, iterations: MAX_PBKDF2_ITERATIONS + 1 } },
        "Strong-Passphrase!2026"
      )
    ).rejects.toThrow(/out of bounds/i);

    // Reject invalid salt or IV lengths
    await expect(
      decryptVaultMeta(
        { ...record, kdf: { ...record.kdf, salt: toBase64(new Uint8Array(8)) } },
        "Strong-Passphrase!2026"
      )
    ).rejects.toThrow(/salt length/i);
    await expect(
      decryptVaultMeta(
        { ...record, iv: toBase64(new Uint8Array(8)) },
        "Strong-Passphrase!2026"
      )
    ).rejects.toThrow(/IV length/i);

    // Reject tampered KDF iterations within bounds (AAD mismatch -> VaultAuthError)
    await expect(
      decryptVaultMeta(
        { ...record, kdf: { ...record.kdf, iterations: FAST_TEST_ITERATIONS + 1 } },
        "Strong-Passphrase!2026"
      )
    ).rejects.toBeInstanceOf(VaultAuthError);

    // Reject tampered blob syncedHeight (AAD mismatch)
    const blob = await encryptWalletBlob(dekKey, walletId, "cache", new Uint8Array([1, 2, 3]), 500);
    await expect(
      decryptWalletBlob(dekKey, { ...blob, syncedHeight: 501 })
    ).rejects.toThrow();

    // Reject invalid blob IV length
    await expect(
      decryptWalletBlob(dekKey, { ...blob, iv: toBase64(new Uint8Array(4)) })
    ).rejects.toThrow(/IV length/i);
  });

  it("rejects short or weak passwords and accepts fair/strong passwords", () => {
    expect(evaluatePasswordStrength("short1!").valid).toBe(false);
    expect(evaluatePasswordStrength("password12").valid).toBe(false); // 10 chars, only lower+digit (score 1 -> weak)
    expect(evaluatePasswordStrength("aaaaaaaaaa").valid).toBe(false);
    expect(evaluatePasswordStrength("initial-vault-password").valid).toBe(true);
    expect(evaluatePasswordStrength("StrongPass!2026").valid).toBe(true);
  });
});
