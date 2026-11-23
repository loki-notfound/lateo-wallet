export const VAULT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 10_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const VAULT_SALT_BYTES = 16;
export const VAULT_IV_BYTES = 12;

export interface Pbkdf2KdfDescriptor {
  readonly alg: "PBKDF2-SHA256";
  readonly iterations: number;
  /** Base64-encoded 16-byte random salt */
  readonly salt: string;
}

export type KdfDescriptor = Pbkdf2KdfDescriptor;

export interface EncryptedVaultMetaRecord {
  readonly id: "primary";
  readonly schemaVersion: typeof VAULT_SCHEMA_VERSION;
  readonly kdf: KdfDescriptor;
  /** Base64-encoded 12-byte random IV */
  readonly iv: string;
  /** Base64-encoded AES-256-GCM ciphertext + auth tag */
  readonly ciphertext: string;
  readonly updatedAt: number;
}

export type WalletBlobKind = "keys" | "cache" | "relay";

export interface EncryptedWalletBlobRecord {
  readonly key: `${string}:${WalletBlobKind}`;
  readonly walletId: string;
  readonly kind: WalletBlobKind;
  readonly schemaVersion: typeof VAULT_SCHEMA_VERSION;
  /** Base64-encoded 12-byte random IV */
  readonly iv: string;
  /** Encrypted AES-256-GCM ciphertext + auth tag */
  readonly ciphertext: Uint8Array;
  readonly syncedHeight: number;
  readonly updatedAt: number;
}

export type RestoreHeightSource = "daemon" | "offline-estimate" | "user";

export interface WalletManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly network: "mainnet" | "testnet" | "stagenet";
  readonly restoreHeight: number;
  readonly restoreHeightSource: RestoreHeightSource;
  readonly createdAt: string;
  readonly viewOnly: boolean;
  readonly seedBackupVerified: boolean;
  /** 64-char hex random secret passed to zephyr-ts inner encryption */
  readonly corePassword: string;
  readonly primaryAddress: string;
  readonly customNodeUrl?: string;
}

export interface VaultManifestPlaintext {
  readonly schemaVersion: typeof VAULT_SCHEMA_VERSION;
  /** Base64-encoded random 256-bit Data Encryption Key (DEK) */
  readonly dek: string;
  readonly wallets: readonly WalletManifestEntry[];
}
