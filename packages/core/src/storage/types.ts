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
  deleteWalletBlobs(walletId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export type ThemePreference = "system" | "light" | "dark";

export interface WalletPrefs {
  readonly theme: ThemePreference;
  readonly autoLockMinutes: number;
  readonly activePublicNode: string;
}

export const DEFAULT_WALLET_PREFS: WalletPrefs = Object.freeze({
  theme: "system",
  autoLockMinutes: 15,
  activePublicNode: "https://node.lateo.dev"
});

export interface PrefsStore {
  readPrefs(): Promise<WalletPrefs>;
  writePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs>;
}
