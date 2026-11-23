import type { ThemePreference, WalletPrefs } from "../storage/types.js";
import type { RestoreHeightSource } from "../vault/types.js";

export type HostKind = "chrome-offscreen" | "firefox-event-page" | "web-worker" | "memory";
export type ZephyrNetwork = "mainnet" | "testnet" | "stagenet";

export interface BalanceEntryDto {
  readonly asset: string;
  readonly total: string;
  readonly unlocked: string;
  readonly locked: string;
}

export type SyncStateKind =
  | "idle"
  | "syncing"
  | "synced"
  | "reconnecting"
  | "offline"
  | "permission-required";

export interface SyncStatusDto {
  readonly state: SyncStateKind;
  readonly nodeUrl: string;
  readonly nodeHost: string;
  readonly walletHeight: number;
  readonly daemonHeight: number;
  readonly percentDone: number;
  readonly lastSyncedAt: number | null;
  readonly lastCheckpointAt: number | null;
  readonly errorMessage: string | null;
  readonly permissionOriginRequired: string | null;
}

export type ReserveHealthState = "healthy" | "warning" | "critical";

export interface OraclePricesDto {
  readonly zphUsdSpot: string;
  readonly zphUsdMa: string;
  readonly zsdSpot: string;
  readonly zsdMa: string;
  readonly zrsSpot: string;
  readonly zrsMa: string;
  readonly zysPrice: string;
  readonly timestamp: number;
}

export interface ConversionAvailabilityDto {
  readonly mintZsd: boolean;
  readonly redeemZsd: boolean;
  readonly mintZrs: boolean;
  readonly redeemZrs: boolean;
  readonly mintZys: boolean;
  readonly redeemZys: boolean;
}

export interface ReserveStatusDto {
  readonly height: number;
  readonly hfVersion: number;
  readonly reserveRatio: string;
  readonly reserveRatioMa: string;
  readonly health: ReserveHealthState;
  readonly conversions: ConversionAvailabilityDto;
  readonly statusSummary: string;
  readonly prices: OraclePricesDto | null;
  readonly updatedAt: number;
}

export interface SubaddressDto {
  readonly accountIndex: number;
  readonly index: number;
  readonly address: string;
  readonly label: string;
  readonly isUsed: boolean;
  readonly numUnspentOutputs: number;
}

export interface TxTransferDto {
  readonly direction: "incoming" | "outgoing";
  readonly asset: string | null;
  readonly amount: string;
  readonly accountIndex: number;
  readonly subaddressIndex?: number;
  readonly destinations?: readonly {
    readonly address?: string;
    readonly amount: string;
    readonly asset?: string;
  }[];
}

export interface TxConversionDto {
  readonly sourceAsset: string;
  readonly destinationAsset: string;
  readonly sourceAmount: string;
  readonly destinationAmount: string;
}

export interface WalletTxDto {
  readonly hash: string;
  readonly height: number | null;
  readonly timestamp: number | null;
  readonly confirmations: number;
  readonly isConfirmed: boolean;
  readonly inPool: boolean;
  readonly isFailed: boolean;
  readonly isLocked: boolean;
  readonly isMinerTx: boolean;
  readonly fee: string | null;
  readonly feeAsset: string | null;
  readonly incomingTransfers: readonly TxTransferDto[];
  readonly outgoingTransfer: TxTransferDto | null;
  readonly conversion: TxConversionDto | null;
}

export type ProofKind = "tx_key" | "tx_proof" | "spend_proof";

export interface NodeProbeResultDto {
  readonly url: string;
  readonly host: string;
  readonly originPattern: string;
  readonly isLocal: boolean;
  readonly reachable: boolean;
  readonly height: number | null;
  readonly isSynchronized: boolean | null;
  readonly network: ZephyrNetwork | null;
  readonly version: string | null;
  readonly permissionRequired: boolean;
  readonly errorMessage: string | null;
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

export type TxPriorityDto = "default" | "unimportant" | "normal" | "elevated";
export type PreparedTxKind = "transfer" | "sweep" | "conversion";
/**
 * `ready`: built, awaiting review + Confirm & Relay.
 * `relay-unknown`: a relay attempt ended without a usable answer (or only part
 * of a multi-transaction build was accepted); the exact signed build is kept so
 * the user can explicitly retry it or discard and sync to verify.
 */
export type PreparedTxStatus = "ready" | "relay-unknown";
export type RelayTxOutcomeDto = "accepted" | "rejected" | "unknown" | "notSent";

export interface PreparedTxPartDto {
  readonly hash: string;
  readonly amount: string;
  readonly fee: string;
  readonly feeAsset: string;
  readonly totalDebited: string;
  readonly outcome: RelayTxOutcomeDto | null;
}

export interface PreparedDestinationDto {
  readonly address: string;
  readonly amount: string;
}

/**
 * Review description of a prepared transaction. `token` is an opaque,
 * short-lived engine handle; signed bytes and keys never leave the engine.
 */
export interface PreparedTxDto {
  readonly token: string;
  readonly kind: PreparedTxKind;
  readonly status: PreparedTxStatus;
  readonly sourceAsset: string;
  readonly destinationAsset: string;
  readonly destinations: readonly PreparedDestinationDto[];
  readonly txs: readonly PreparedTxPartDto[];
  readonly totalAmount: string;
  readonly totalFee: string;
  readonly feeAsset: string;
  readonly totalDebited: string;
  readonly amountMinted: string | null;
  readonly pricingRecordHeight: number | null;
  readonly pricingRecordExpiresAtHeight: number | null;
  readonly daemonHeightAtPrepare: number;
  readonly priority: TxPriorityDto;
  readonly nodeUrl: string;
  readonly nodeHost: string;
  readonly preparedAt: number;
  readonly expiresAt: number;
  readonly relayAttempts: number;
  readonly maxRelayAttempts: number;
  readonly lastRelayError: string | null;
}

export type SavingKind = "post-relay" | "checkpoint";

export interface PersistFailureDto {
  readonly txHashes: readonly string[];
  readonly failedAt: number;
  readonly message: string;
}

/**
 * Encrypted marker persisted when a relay ends in an uncertain state so locking
 * or restarting the extension never lets the user silently rebuild and double-pay.
 */
export interface UnresolvedRelayDto {
  readonly txHashes: readonly string[];
  readonly recordedAt: number;
  readonly nodeHost: string;
  readonly reason: string;
}

export type RelayOutcomeDto =
  | {
      readonly kind: "relayed";
      readonly txHashes: readonly string[];
      readonly relayedAt: number;
      readonly nodeHost: string;
      readonly persisted: true;
      readonly notRelayed?: boolean;
    }
  | {
      readonly kind: "relayed-unsaved";
      readonly txHashes: readonly string[];
      readonly relayedAt: number;
      readonly nodeHost: string;
      readonly message: string;
      readonly notRelayed?: boolean;
    }
  | {
      readonly kind: "relay-unknown";
      readonly pending: PreparedTxDto;
      readonly reason: string;
      readonly message: string;
      readonly canRetry: boolean;
      readonly persisted: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly message: string;
      readonly verifyRequired?: boolean;
    }
  | {
      readonly kind: "expired";
      readonly reason: string;
      readonly message: string;
    };

export interface WalletSnapshot {
  readonly hasVault: boolean;
  readonly locked: boolean;
  readonly savingState: boolean;
  readonly savingKind: SavingKind | null;
  readonly pendingTx: PreparedTxDto | null;
  readonly persistFailure: PersistFailureDto | null;
  readonly unresolvedRelay?: UnresolvedRelayDto | null;
  readonly activeWallet: WalletSummaryDto | null;
  readonly balances: readonly BalanceEntryDto[];
  readonly sync: SyncStatusDto;
  readonly reserve: ReserveStatusDto | null;
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
        readonly customNodes: readonly string[];
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
  | { readonly id: string; readonly type: "RESET_VAULT" }
  | { readonly id: string; readonly type: "SYNC_NOW" }
  | { readonly id: string; readonly type: "REFRESH_RESERVE" }
  | { readonly id: string; readonly type: "PROBE_NODE"; readonly url: string }
  | {
      readonly id: string;
      readonly type: "SWITCH_NODE";
      readonly url: string;
      readonly saveAsCustom?: boolean;
    }
  | { readonly id: string; readonly type: "LIST_SUBADDRESSES" }
  | { readonly id: string; readonly type: "CREATE_SUBADDRESS"; readonly label?: string }
  | {
      readonly id: string;
      readonly type: "SET_SUBADDRESS_LABEL";
      readonly index: number;
      readonly label: string;
    }
  | {
      readonly id: string;
      readonly type: "GET_HISTORY";
      readonly asset?: string;
      readonly direction?: "incoming" | "outgoing";
    }
  | { readonly id: string; readonly type: "REFRESH_POOL" }
  | {
      readonly id: string;
      readonly type: "EXPORT_TX_PROOF";
      readonly kind: ProofKind;
      readonly txHash: string;
      readonly address?: string;
      readonly message?: string;
    }
  | {
      readonly id: string;
      readonly type: "PREPARE_TRANSFER";
      readonly asset: string;
      readonly destinations: readonly { readonly address: string; readonly amount: string }[];
      readonly priority?: TxPriorityDto;
    }
  | {
      readonly id: string;
      readonly type: "PREPARE_SWEEP";
      readonly asset: string;
      readonly address: string;
      readonly priority?: TxPriorityDto;
    }
  | {
      readonly id: string;
      readonly type: "PREPARE_CONVERSION";
      readonly sourceAsset: string;
      readonly destinationAsset: string;
      readonly amount: string;
      readonly address?: string;
      readonly priority?: TxPriorityDto;
    }
  | { readonly id: string; readonly type: "RELAY_PREPARED"; readonly token: string }
  | {
      readonly id: string;
      readonly type: "DISCARD_PREPARED";
      readonly token: string;
      readonly verify?: boolean;
    }
  | { readonly id: string; readonly type: "RETRY_PERSIST" }
  | { readonly id: string; readonly type: "RELEASE_PREPARED" }
  | { readonly id: string; readonly type: "CLEAR_UNRESOLVED_RELAY" };

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
  syncNow(): Promise<WalletSnapshot>;
  refreshReserve(): Promise<ReserveStatusDto | null>;
  probeNode(url: string): Promise<NodeProbeResultDto>;
  switchNode(url: string, saveAsCustom?: boolean): Promise<WalletSnapshot>;
  listSubaddresses(): Promise<readonly SubaddressDto[]>;
  createSubaddress(label?: string): Promise<SubaddressDto>;
  setSubaddressLabel(index: number, label: string): Promise<readonly SubaddressDto[]>;
  getHistory(filter?: {
    readonly asset?: string;
    readonly direction?: "incoming" | "outgoing";
  }): Promise<readonly WalletTxDto[]>;
  refreshPool(): Promise<{ readonly poolCount: number; readonly txs: readonly WalletTxDto[] }>;
  exportTxProof(params: {
    readonly kind: ProofKind;
    readonly txHash: string;
    readonly address?: string;
    readonly message?: string;
  }): Promise<string>;
  prepareTransfer(params: {
    readonly asset: string;
    readonly destinations: readonly { readonly address: string; readonly amount: string }[];
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto>;
  prepareSweep(params: {
    readonly asset: string;
    readonly address: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto>;
  prepareConversion(params: {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly amount: string;
    readonly address?: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto>;
  relayPrepared(token: string): Promise<RelayOutcomeDto>;
  discardPrepared(token: string, verify?: boolean): Promise<WalletSnapshot>;
  retryPersist(): Promise<WalletSnapshot>;
  clearUnresolvedRelay?(): Promise<WalletSnapshot>;
  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void;
}

/** Error codes the engine attaches to rejected transaction-flow requests. */
export type TxFlowErrorCode =
  | "LOCKED"
  | "VIEW_ONLY"
  | "INVALID_ASSET"
  | "INVALID_ADDRESS"
  | "INVALID_AMOUNT"
  | "INVALID_DESTINATIONS"
  | "INVALID_PRIORITY"
  | "INSUFFICIENT_FUNDS"
  | "RESERVE_BLOCKED"
  | "PRICING_RECORD_EXPIRED"
  | "RELAY_PENDING"
  | "SAVE_PENDING"
  | "TOKEN_UNKNOWN"
  | "BUILD_FAILED"
  | "VERIFICATION_FAILED"
  | "LOCK_DEFERRED";
