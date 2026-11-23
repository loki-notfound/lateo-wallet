import type { ThemePreference, WalletPrefs } from "../storage/types.js";
import type { RestoreHeightSource } from "../vault/types.js";

export type HostKind = "chrome-offscreen" | "firefox-event-page" | "memory";
export type ZephyrNetwork = "mainnet" | "testnet" | "stagenet";

export interface BalanceEntryDto {
  readonly asset: string;
  readonly total: string;
  readonly unlocked: string;
}

export interface WalletSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly network: ZephyrNetwork;
  readonly primaryAddress: string;
  readonly restoreHeight: number;
  readonly restoreHeightSource: RestoreHeightSource;
  readonly createdAt: string;
  readonly viewOnly: boolean;
  readonly seedBackupVerified: boolean;
}

export interface WalletSnapshot {
  readonly hasVault: boolean;
  readonly locked: boolean;
  readonly savingState: boolean;
  readonly activeWallet: WalletSummaryDto | null;
  readonly balances: readonly BalanceEntryDto[];
  readonly lastPersistedAt: number | null;
  readonly hostKind: HostKind;
  readonly offscreenActive?: boolean;
  readonly keepAliveActive?: boolean;
}

/**
 * Returned once on Create Wallet so the onboarding UI can render the 25-word
 * seed backup grid and 3-word quiz. Never persisted inside WalletSnapshot.
 */
export interface CreateWalletResultDto {
  readonly snapshot: WalletSnapshot;
  readonly seed: string;
  readonly restoreHeight: number;
  readonly restoreHeightSource: RestoreHeightSource;
  readonly createdAt: string;
}

/**
 * Returned only from explicit password-verified Danger Zone secret reveal.
 */
export interface RevealedSecretsDto {
  readonly primaryAddress: string;
  readonly seed: string | null;
  readonly privateViewKey: string;
  readonly privateSpendKey: string | null;
  readonly restoreHeight: number;
  readonly viewOnly: boolean;
}

export interface HostDiagnosticsDto {
  readonly hostKind: HostKind;
  readonly offscreenExists: boolean;
  readonly keepAliveActive: boolean;
  readonly defaultNodeHostPermissionGranted: boolean;
  readonly grantedOrigins: readonly string[];
}

export type EngineRequest =
  | { readonly id: string; readonly type: "GET_SNAPSHOT" }
  | { readonly id: string; readonly type: "GET_DIAGNOSTICS" }
  | { readonly id: string; readonly type: "GET_PREFS" }
  | {
      readonly id: string;
      readonly type: "UPDATE_PREFS";
      readonly patch: Partial<{
        readonly theme: ThemePreference;
        readonly autoLockMinutes: number;
        readonly activePublicNode: string;
      }>;
    }
  | {
      readonly id: string;
      readonly type: "CREATE_WALLET";
      readonly password: string;
      readonly name: string;
      readonly network?: ZephyrNetwork;
    }
  | {
      readonly id: string;
      readonly type: "RESTORE_FROM_SEED";
      readonly password: string;
      readonly name: string;
      readonly seed: string;
      readonly restoreHeight: number;
      readonly network?: ZephyrNetwork;
    }
  | {
      readonly id: string;
      readonly type: "RESTORE_VIEW_ONLY";
      readonly password: string;
      readonly name: string;
      readonly primaryAddress: string;
      readonly privateViewKey: string;
      readonly restoreHeight: number;
      readonly network?: ZephyrNetwork;
    }
  | { readonly id: string; readonly type: "MARK_SEED_BACKUP_VERIFIED" }
  | {
      readonly id: string;
      readonly type: "UNLOCK_WALLET";
      readonly password: string;
    }
  | { readonly id: string; readonly type: "LOCK_WALLET" }
  | {
      readonly id: string;
      readonly type: "CHANGE_VAULT_PASSWORD";
      readonly currentPassword: string;
      readonly newPassword: string;
    }
  | {
      readonly id: string;
      readonly type: "REVEAL_SECRETS";
      readonly password: string;
    }
  | { readonly id: string; readonly type: "RESET_VAULT" };

export type EngineRequestPayload =
  EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, "id"> : never) : never;

export type EngineResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type EngineEvent = {
  readonly type: "SNAPSHOT_UPDATED";
  readonly snapshot: WalletSnapshot;
};

export interface WalletClient {
  getSnapshot(): Promise<WalletSnapshot>;
  getDiagnostics(): Promise<HostDiagnosticsDto>;
  getPrefs(): Promise<WalletPrefs>;
  updatePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs>;
  createWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: ZephyrNetwork;
  }): Promise<CreateWalletResultDto>;
  restoreFromSeed(params: {
    readonly password: string;
    readonly name: string;
    readonly seed: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot>;
  restoreViewOnly(params: {
    readonly password: string;
    readonly name: string;
    readonly primaryAddress: string;
    readonly privateViewKey: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot>;
  markSeedBackupVerified(): Promise<WalletSnapshot>;
  unlockWallet(password: string): Promise<WalletSnapshot>;
  lockWallet(): Promise<WalletSnapshot>;
  changeVaultPassword(params: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void>;
  revealSecrets(password: string): Promise<RevealedSecretsDto>;
  resetVault(): Promise<WalletSnapshot>;
  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void;
}
