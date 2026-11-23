export type HostKind = "chrome-offscreen" | "firefox-event-page" | "memory";

export interface BalanceEntryDto {
  readonly asset: string;
  readonly total: string;
  readonly unlocked: string;
}

export interface WalletSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly network: "mainnet" | "testnet" | "stagenet";
  readonly primaryAddress: string;
  readonly restoreHeight: number;
  readonly createdAt: string;
  readonly viewOnly: boolean;
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
  | {
      readonly id: string;
      readonly type: "CREATE_DISPOSABLE_WALLET";
      readonly password: string;
      readonly name: string;
      readonly network?: "mainnet" | "testnet" | "stagenet";
    }
  | {
      readonly id: string;
      readonly type: "UNLOCK_WALLET";
      readonly password: string;
    }
  | { readonly id: string; readonly type: "LOCK_WALLET" }
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
  createDisposableWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: "mainnet" | "testnet" | "stagenet";
  }): Promise<WalletSnapshot>;
  unlockWallet(password: string): Promise<WalletSnapshot>;
  lockWallet(): Promise<WalletSnapshot>;
  resetVault(): Promise<WalletSnapshot>;
  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void;
}
