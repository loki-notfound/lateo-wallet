import type {
  CreateWalletResultDto,
  EngineEvent,
  EngineRequestPayload,
  EngineResponse,
  HostDiagnosticsDto,
  RevealedSecretsDto,
  WalletClient,
  WalletSnapshot,
  ZephyrNetwork
} from "@lateo-wallet/core/rpc";
import type { WalletPrefs } from "@lateo-wallet/core/storage";

type PendingResolver = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
};

export class PortWalletClient implements WalletClient {
  private port: chrome.runtime.Port | null = null;
  private reqCounter = 0;
  private readonly pending = new Map<string, PendingResolver>();
  private readonly listeners = new Set<(snapshot: WalletSnapshot) => void>();

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: "lateo-ui" });
    port.onMessage.addListener((msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      if ("type" in msg && (msg as EngineEvent).type === "SNAPSHOT_UPDATED") {
        const snap = (msg as EngineEvent).snapshot;
        for (const listener of this.listeners) {
          listener(snap);
        }
        return;
      }
      if ("id" in msg && "ok" in msg) {
        const res = msg as EngineResponse;
        const entry = this.pending.get(res.id);
        if (!entry) return;
        this.pending.delete(res.id);
        if (res.ok) {
          entry.resolve(res.result);
        } else {
          entry.reject(new Error(res.error.message));
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) {
        this.port = null;
      }
      for (const [, entry] of this.pending) {
        entry.reject(new Error("Engine port disconnected"));
      }
      this.pending.clear();
    });
    this.port = port;
    return port;
  }

  private request<T>(payload: EngineRequestPayload): Promise<T> {
    const id = `req-${++this.reqCounter}`;
    const port = this.ensurePort();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      port.postMessage({ ...payload, id });
    });
  }

  getSnapshot(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "GET_SNAPSHOT" });
  }

  getDiagnostics(): Promise<HostDiagnosticsDto> {
    return this.request<HostDiagnosticsDto>({ type: "GET_DIAGNOSTICS" });
  }

  getPrefs(): Promise<WalletPrefs> {
    return this.request<WalletPrefs>({ type: "GET_PREFS" });
  }

  updatePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    return this.request<WalletPrefs>({ type: "UPDATE_PREFS", patch });
  }

  createWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: ZephyrNetwork;
  }): Promise<CreateWalletResultDto> {
    return this.request<CreateWalletResultDto>({
      type: "CREATE_WALLET",
      password: params.password,
      name: params.name,
      ...(params.network ? { network: params.network } : {})
    });
  }

  restoreFromSeed(params: {
    readonly password: string;
    readonly name: string;
    readonly seed: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({
      type: "RESTORE_FROM_SEED",
      password: params.password,
      name: params.name,
      seed: params.seed,
      restoreHeight: params.restoreHeight,
      ...(params.network ? { network: params.network } : {})
    });
  }

  restoreViewOnly(params: {
    readonly password: string;
    readonly name: string;
    readonly primaryAddress: string;
    readonly privateViewKey: string;
    readonly restoreHeight: number;
    readonly network?: ZephyrNetwork;
  }): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({
      type: "RESTORE_VIEW_ONLY",
      password: params.password,
      name: params.name,
      primaryAddress: params.primaryAddress,
      privateViewKey: params.privateViewKey,
      restoreHeight: params.restoreHeight,
      ...(params.network ? { network: params.network } : {})
    });
  }

  markSeedBackupVerified(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "MARK_SEED_BACKUP_VERIFIED" });
  }

  unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "UNLOCK_WALLET", password });
  }

  lockWallet(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "LOCK_WALLET" });
  }

  async changeVaultPassword(params: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    await this.request<null>({
      type: "CHANGE_VAULT_PASSWORD",
      currentPassword: params.currentPassword,
      newPassword: params.newPassword
    });
  }

  revealSecrets(password: string): Promise<RevealedSecretsDto> {
    return this.request<RevealedSecretsDto>({ type: "REVEAL_SECRETS", password });
  }

  resetVault(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "RESET_VAULT" });
  }

  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.ensurePort();
    return () => {
      this.listeners.delete(listener);
    };
  }
}
