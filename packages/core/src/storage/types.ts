import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind
} from "../vault/types.js";

export interface VaultBlobStore {
  readMeta(): Promise<EncryptedVaultMetaRecord | undefined>;
  writeMeta(record: EncryptedVaultMetaRecord): Promise<void>;
  readBlob(walletId: string, kind: WalletBlobKind): Promise<EncryptedWalletBlobRecord | undefined>;
  writeBlob(record: EncryptedWalletBlobRecord): Promise<void>;
  /**
   * Atomically persist multiple encrypted wallet blobs (keys + cache) in a
   * single readwrite transaction (`tx.oncomplete`).
   */
  writeBlobsAtomic?(blobs: readonly EncryptedWalletBlobRecord[]): Promise<void>;
  /**
   * Atomically persist encrypted wallet blobs alongside vault_meta in a single
   * transaction when the backing store supports multi-store transactions.
   */
  writeVaultAtomic?(
    meta: EncryptedVaultMetaRecord,
    blobs: readonly EncryptedWalletBlobRecord[]
  ): Promise<void>;
  deleteWalletBlobs(walletId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export type ThemePreference = "system" | "light" | "dark";

export const AUTO_LOCK_PRESET_MINUTES = [5, 15, 30, 60] as const;

export interface WalletPrefs {
  readonly theme: ThemePreference;
  readonly autoLockMinutes: number;
  readonly activePublicNode: string;
  readonly customNodes: readonly string[];
}

export const DEFAULT_WALLET_PREFS: WalletPrefs = Object.freeze({
  theme: "system",
  autoLockMinutes: 15,
  activePublicNode: "https://node.lateo.dev",
  customNodes: []
});

export interface PrefsStore {
  readPrefs(): Promise<WalletPrefs>;
  writePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs>;
}
