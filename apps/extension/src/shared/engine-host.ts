import {
  VaultAuthError,
  WalletEngine,
  type EngineRequest,
  type EngineResponse,
  type HostKind,
  type WalletSnapshot
} from "@lateo-wallet/core";
import { IndexedDbVaultStore } from "./idb-store.js";

export interface ExtensionEngineHostOptions {
  readonly hostKind: HostKind;
  readonly onSnapshot?: (snapshot: WalletSnapshot) => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

export class ExtensionEngineHost {
  private readonly engine: WalletEngine;
  private readonly onBusyChange: ((busy: boolean) => void) | undefined;
  private activeOps = 0;

  constructor(options: ExtensionEngineHostOptions) {
    this.onBusyChange = options.onBusyChange;
    const store = new IndexedDbVaultStore();
    this.engine = new WalletEngine({
      store,
      hostKind: options.hostKind,
      proxyToWorker: true,
      ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {})
    });
  }

  isBusy(): boolean {
    return this.activeOps > 0;
  }

  private async trackOp<T>(fn: () => Promise<T>): Promise<T> {
    this.activeOps++;
    if (this.activeOps === 1) this.onBusyChange?.(true);
    try {
      return await fn();
    } finally {
      this.activeOps = Math.max(0, this.activeOps - 1);
      if (this.activeOps === 0) this.onBusyChange?.(false);
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
      return {
        id: req.id,
        ok: false,
        error: {
          code: "ENGINE_ERROR",
          message: err instanceof Error ? err.message : "Operation failed"
        }
      };
    }
  }
}
