import {
  DEFAULT_PBKDF2_ITERATIONS,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  VAULT_IV_BYTES,
  VAULT_SALT_BYTES,
  VAULT_SCHEMA_VERSION,
  type EncryptedVaultMetaRecord,
  type EncryptedWalletBlobRecord,
  type KdfDescriptor,
  type VaultManifestPlaintext,
  type WalletBlobKind
} from "./types.js";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class VaultAuthError extends Error {
  readonly code = "INVALID_PASSWORD" as const;

  constructor(message = "Incorrect vault password") {
    super(message);
    this.name = "VaultAuthError";
  }
}

function assertValidKdfDescriptor(kdf: KdfDescriptor): void {
  if (kdf.alg !== "PBKDF2-SHA256") {
    throw new Error("Unsupported vault KDF algorithm");
  }
  if (
    typeof kdf.iterations !== "number" ||
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < MIN_PBKDF2_ITERATIONS ||
    kdf.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Vault KDF iteration count is out of bounds");
  }
  if (typeof kdf.salt !== "string" || kdf.salt.length === 0) {
    throw new Error("Vault KDF salt is missing");
  }
}

function metaAad(kdf: KdfDescriptor): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    TEXT_ENCODER.encode(
      `lateo-vault:v${VAULT_SCHEMA_VERSION}:meta:${kdf.alg}:${kdf.iterations}:${kdf.salt}`
    )
  );
}

function blobAad(
  walletId: string,
  kind: WalletBlobKind,
  syncedHeight: number
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(syncedHeight) || syncedHeight < 0) {
    throw new Error("Blob syncedHeight must be a non-negative integer");
  }
  return new Uint8Array(
    TEXT_ENCODER.encode(
      `lateo-vault:v${VAULT_SCHEMA_VERSION}:blob:${walletId}:${kind}:${syncedHeight}`
    )
  );
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto SubtleCrypto is unavailable in this context");
  }
  return subtle;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function zeroize(buffer: Uint8Array | undefined): void {
  if (buffer) {
    buffer.fill(0);
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateCorePassword(): string {
  const bytes = randomBytes(32);
  try {
    return toHex(bytes);
  } finally {
    zeroize(bytes);
  }
}

export function generateWalletId(): string {
  return toHex(randomBytes(16));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBufferCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

export async function deriveKek(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  if (password.length === 0) {
    throw new Error("Vault password must not be empty");
  }
  if (salt.byteLength !== VAULT_SALT_BYTES) {
    throw new Error(`Vault salt must be ${VAULT_SALT_BYTES} bytes`);
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Vault KDF iteration count is out of bounds");
  }
  const subtle = getSubtle();
  const passwordBytes = toArrayBufferCopy(TEXT_ENCODER.encode(password));
  try {
    const keyMaterial = await subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
      "deriveKey"
    ]);
    return await subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    zeroize(passwordBytes);
  }
}

export async function generateDek(): Promise<{
  readonly dekKey: CryptoKey;
  readonly dekBase64: string;
}> {
  const raw = randomBytes(32);
  try {
    const dekKey = await importDek(raw);
    return { dekKey, dekBase64: toBase64(raw) };
  } finally {
    zeroize(raw);
  }
}

export async function importDek(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new Error("DEK must be 32 bytes");
  }
  return getSubtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt"
  ]);
}

export async function encryptVaultMetaWithKek(
  manifest: VaultManifestPlaintext,
  kek: CryptoKey,
  kdf: KdfDescriptor
): Promise<EncryptedVaultMetaRecord> {
  assertValidKdfDescriptor(kdf);
  const iv = randomBytes(VAULT_IV_BYTES);
  const plaintext = toArrayBufferCopy(TEXT_ENCODER.encode(JSON.stringify(manifest)));
  try {
    const encrypted = await getSubtle().encrypt(
      { name: "AES-GCM", iv, additionalData: metaAad(kdf) },
      kek,
      plaintext
    );
    return {
      id: "primary",
      schemaVersion: VAULT_SCHEMA_VERSION,
      kdf,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted)),
      updatedAt: Date.now()
    };
  } finally {
    zeroize(plaintext);
  }
}

export async function encryptVaultMeta(
  manifest: VaultManifestPlaintext,
  password: string,
  options?: { readonly iterations?: number }
): Promise<{
  readonly record: EncryptedVaultMetaRecord;
  readonly kek: CryptoKey;
  readonly kdf: KdfDescriptor;
}> {
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = randomBytes(VAULT_SALT_BYTES);
  const kdf: KdfDescriptor = {
    alg: "PBKDF2-SHA256",
    iterations,
    salt: toBase64(salt)
  };
  const kek = await deriveKek(password, salt, iterations);
  const record = await encryptVaultMetaWithKek(manifest, kek, kdf);
  return { record, kek, kdf };
}

export async function decryptVaultMeta(
  record: EncryptedVaultMetaRecord,
  password: string
): Promise<{
  readonly manifest: VaultManifestPlaintext;
  readonly kek: CryptoKey;
  readonly kdf: KdfDescriptor;
  readonly dekKey: CryptoKey;
}> {
  if (record.schemaVersion !== VAULT_SCHEMA_VERSION) {
    throw new Error("Unsupported vault schema version");
  }
  assertValidKdfDescriptor(record.kdf);
  const salt = fromBase64(record.kdf.salt);
  const iv = fromBase64(record.iv);
  if (salt.byteLength !== VAULT_SALT_BYTES) {
    throw new Error("Invalid vault salt length");
  }
  if (iv.byteLength !== VAULT_IV_BYTES) {
    throw new Error("Invalid vault IV length");
  }
  const ciphertext = fromBase64(record.ciphertext);
  const kek = await deriveKek(password, salt, record.kdf.iterations);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await getSubtle().decrypt(
      { name: "AES-GCM", iv, additionalData: metaAad(record.kdf) },
      kek,
      ciphertext
    );
  } catch {
    throw new VaultAuthError();
  }

  const plaintextBytes = new Uint8Array(decryptedBuffer);
  try {
    const parsed = JSON.parse(TEXT_DECODER.decode(plaintextBytes)) as VaultManifestPlaintext;
    if (
      parsed.schemaVersion !== VAULT_SCHEMA_VERSION ||
      typeof parsed.dek !== "string" ||
      !Array.isArray(parsed.wallets)
    ) {
      throw new Error("Malformed vault manifest");
    }
    const rawDek = fromBase64(parsed.dek);
    try {
      const dekKey = await importDek(rawDek);
      return { manifest: parsed, kek, kdf: record.kdf, dekKey };
    } finally {
      zeroize(rawDek);
    }
  } finally {
    zeroize(plaintextBytes);
  }
}

export async function encryptWalletBlob(
  dekKey: CryptoKey,
  walletId: string,
  kind: WalletBlobKind,
  plaintext: Uint8Array,
  syncedHeight: number
): Promise<EncryptedWalletBlobRecord> {
  const iv = randomBytes(VAULT_IV_BYTES);
  const aad = blobAad(walletId, kind, syncedHeight);
  const payload = toArrayBufferCopy(plaintext);
  try {
    const encrypted = await getSubtle().encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      dekKey,
      payload
    );
    return {
      key: `${walletId}:${kind}`,
      walletId,
      kind,
      schemaVersion: VAULT_SCHEMA_VERSION,
      iv: toBase64(iv),
      ciphertext: new Uint8Array(encrypted),
      syncedHeight,
      updatedAt: Date.now()
    };
  } finally {
    zeroize(payload);
  }
}

export async function decryptWalletBlob(
  dekKey: CryptoKey,
  record: EncryptedWalletBlobRecord
): Promise<Uint8Array> {
  if (record.schemaVersion !== VAULT_SCHEMA_VERSION) {
    throw new Error("Unsupported blob schema version");
  }
  const iv = fromBase64(record.iv);
  if (iv.byteLength !== VAULT_IV_BYTES) {
    throw new Error("Invalid blob IV length");
  }
  const aad = blobAad(record.walletId, record.kind, record.syncedHeight);
  const ciphertext = toArrayBufferCopy(record.ciphertext);
  const decrypted = await getSubtle().decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    dekKey,
    ciphertext
  );
  return new Uint8Array(decrypted);
}
