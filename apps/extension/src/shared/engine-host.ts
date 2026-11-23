import {
  TxFlowError,
  VaultAuthError,
  WalletEngine,
  WalletValidationError,
  type EngineRequest,
  type EngineResponse,
  type HostKind,
  type WalletSnapshot
} from "@lateo-wallet/core";
import { IndexedDbVaultStore } from "./idb-store.js";

export interface ExtensionEngineHostOptions {
  readonly hostKind: HostKind;
  readonly defaultNodeUrl?: string;
  readonly checkOriginPermission?: (originPattern: string) => Promise<boolean>;
  readonly onSnapshot?: (snapshot: WalletSnapshot) => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

export class ExtensionEngineHost {
  private readonly engine: WalletEngine;
  private readonly onBusyChange: ((busy: boolean) => void) | undefined;
  private activeOps = 0;
  private syncBusy = false;

  constructor(options: ExtensionEngineHostOptions) {
    this.onBusyChange = options.onBusyChange;
    const store = new IndexedDbVaultStore();
    this.engine = new WalletEngine({
      store,
      hostKind: options.hostKind,
      proxyToWorker: true,
      ...(options.defaultNodeUrl ? { defaultNodeUrl: options.defaultNodeUrl } : {}),
      ...(options.checkOriginPermission
        ? { checkOriginPermission: options.checkOriginPermission }
        : {}),
      ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
      onSyncBusyChange: (busy) => {
        this.syncBusy = busy;
        this.emitBusy();
      }
    });
  }

  isBusy(): boolean {
    return this.activeOps > 0 || this.syncBusy || this.engine.isSavingOrRelayCritical();
  }

  isSavingOrRelayCritical(): boolean {
    return this.engine.isSavingOrRelayCritical();
  }

  setInitialNodeUrl(url: string): void {
    this.engine.setInitialNodeUrl(url);
  }

  getSnapshot(): Promise<WalletSnapshot> {
    return this.engine.getSnapshot();
  }

  private emitBusy(): void {
    this.onBusyChange?.(this.isBusy());
  }

  private async trackOp<T>(fn: () => Promise<T>): Promise<T> {
    this.activeOps++;
    if (this.activeOps === 1) this.emitBusy();
    try {
      return await fn();
    } finally {
      this.activeOps = Math.max(0, this.activeOps - 1);
      this.emitBusy();
    }
  }

  async handleRequest(req: EngineRequest): Promise<EngineResponse> {
    try {
      switch (req.type) {
        case "GET_SNAPSHOT": {
          const result = await this.engine.getSnapshot();
          return { id: req.id, ok: true, result };
        }
        case "CREATE_WALLET": {
          const result = await this.trackOp(() =>
            this.engine.createWallet({
              password: req.password,
              name: req.name,
              ...(req.network ? { network: req.network } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "RESTORE_FROM_SEED": {
          const result = await this.trackOp(() =>
            this.engine.restoreFromSeed({
              password: req.password,
              name: req.name,
              seed: req.seed,
              restoreHeight: req.restoreHeight,
              ...(req.network ? { network: req.network } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "RESTORE_VIEW_ONLY": {
          const result = await this.trackOp(() =>
            this.engine.restoreViewOnly({
              password: req.password,
              name: req.name,
              primaryAddress: req.primaryAddress,
              privateViewKey: req.privateViewKey,
              restoreHeight: req.restoreHeight,
              ...(req.network ? { network: req.network } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "MARK_SEED_BACKUP_VERIFIED": {
          const result = await this.trackOp(() => this.engine.markSeedBackupVerified());
          return { id: req.id, ok: true, result };
        }
        case "UNLOCK_WALLET": {
          const result = await this.trackOp(() => this.engine.unlockWallet(req.password));
          return { id: req.id, ok: true, result };
        }
        case "LOCK_WALLET": {
          const result = await this.trackOp(() => this.engine.lockWallet());
          return { id: req.id, ok: true, result };
        }
        case "CHANGE_VAULT_PASSWORD": {
          await this.trackOp(() =>
            this.engine.changeVaultPassword({
              currentPassword: req.currentPassword,
              newPassword: req.newPassword
            })
          );
          return { id: req.id, ok: true, result: null };
        }
        case "REVEAL_SECRETS": {
          const result = await this.trackOp(() => this.engine.revealSecrets(req.password));
          return { id: req.id, ok: true, result };
        }
        case "RESET_VAULT": {
          const result = await this.trackOp(() => this.engine.resetVault());
          return { id: req.id, ok: true, result };
        }
        case "SYNC_NOW": {
          const result = await this.trackOp(() => this.engine.syncNow());
          return { id: req.id, ok: true, result };
        }
        case "REFRESH_RESERVE": {
          const result = await this.trackOp(() => this.engine.refreshReserve());
          return { id: req.id, ok: true, result };
        }
        case "PROBE_NODE": {
          const result = await this.trackOp(() => this.engine.probeNode(req.url));
          return { id: req.id, ok: true, result };
        }
        case "SWITCH_NODE": {
          const result = await this.trackOp(() => this.engine.setActiveNode(req.url));
          return { id: req.id, ok: true, result };
        }
        case "LIST_SUBADDRESSES": {
          const result = await this.trackOp(() => this.engine.listSubaddresses());
          return { id: req.id, ok: true, result };
        }
        case "CREATE_SUBADDRESS": {
          const result = await this.trackOp(() => this.engine.createSubaddress(req.label));
          return { id: req.id, ok: true, result };
        }
        case "SET_SUBADDRESS_LABEL": {
          const result = await this.trackOp(() =>
            this.engine.setSubaddressLabel(req.index, req.label)
          );
          return { id: req.id, ok: true, result };
        }
        case "GET_HISTORY": {
          const result = await this.trackOp(() =>
            this.engine.getHistory({
              ...(req.asset ? { asset: req.asset } : {}),
              ...(req.direction ? { direction: req.direction } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "REFRESH_POOL": {
          const result = await this.trackOp(() => this.engine.refreshPool());
          return { id: req.id, ok: true, result };
        }
        case "EXPORT_TX_PROOF": {
          const result = await this.trackOp(() =>
            this.engine.exportTxProof({
              kind: req.kind,
              txHash: req.txHash,
              ...(req.address ? { address: req.address } : {}),
              ...(req.message !== undefined ? { message: req.message } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "PREPARE_TRANSFER": {
          const result = await this.trackOp(() =>
            this.engine.prepareTransfer({
              asset: req.asset,
              destinations: req.destinations,
              ...(req.priority ? { priority: req.priority } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "PREPARE_SWEEP": {
          const result = await this.trackOp(() =>
            this.engine.prepareSweep({
              asset: req.asset,
              address: req.address,
              ...(req.priority ? { priority: req.priority } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "PREPARE_CONVERSION": {
          const result = await this.trackOp(() =>
            this.engine.prepareConversion({
              sourceAsset: req.sourceAsset,
              destinationAsset: req.destinationAsset,
              amount: req.amount,
              ...(req.address ? { address: req.address } : {}),
              ...(req.priority ? { priority: req.priority } : {})
            })
          );
          return { id: req.id, ok: true, result };
        }
        case "RELAY_PREPARED": {
          const result = await this.trackOp(() => this.engine.relayPrepared(req.token));
          return { id: req.id, ok: true, result };
        }
        case "DISCARD_PREPARED": {
          const result = await this.trackOp(() =>
            this.engine.discardPrepared(req.token, req.verify ?? false)
          );
          return { id: req.id, ok: true, result };
        }
        case "RETRY_PERSIST": {
          const result = await this.trackOp(() => this.engine.retryPersist());
          return { id: req.id, ok: true, result };
        }
        case "RELEASE_PREPARED": {
          const result = await this.trackOp(() => this.engine.releasePrepared());
          return { id: req.id, ok: true, result };
        }
        case "CLEAR_UNRESOLVED_RELAY": {
          const result = await this.trackOp(() => this.engine.clearUnresolvedRelay());
          return { id: req.id, ok: true, result };
        }
        case "GET_DIAGNOSTICS":
        case "GET_PREFS":
        case "UPDATE_PREFS": {
          return {
            id: req.id,
            ok: false,
            error: {
              code: "UNHANDLED_HOST_CALL",
              message: "Request must be served by the browser background host"
            }
          };
        }
        default: {
          return {
            id: (req as { id?: string }).id ?? "",
            ok: false,
            error: {
              code: "UNKNOWN_REQUEST",
              message: "Unknown request type"
            }
          };
        }
      }
    } catch (err) {
      if (err instanceof VaultAuthError) {
        return {
          id: req.id,
          ok: false,
          error: {
            code: err.code,
            message: "Incorrect vault password"
          }
        };
      }
      if (err instanceof TxFlowError) {
        return {
          id: req.id,
          ok: false,
          error: {
            code: err.code,
            message: err.message
          }
        };
      }
      if (err instanceof WalletValidationError) {
        return {
          id: req.id,
          ok: false,
          error: {
            code: err.code,
            message: err.message
          }
        };
      }
      return {
        id: req.id,
        ok: false,
        error: {
          code: "ENGINE_ERROR",
          message: "Operation failed"
        }
      };
    }
  }
}
