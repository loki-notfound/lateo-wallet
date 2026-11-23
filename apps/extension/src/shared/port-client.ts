import type {
  CreateWalletResultDto,
  EngineEvent,
  EngineRequestPayload,
  EngineResponse,
  HostDiagnosticsDto,
  NodeProbeResultDto,
  ProofKind,
  ReserveStatusDto,
  RevealedSecretsDto,
  SubaddressDto,
  WalletClient,
  WalletSnapshot,
  WalletTxDto,
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

  syncNow(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "SYNC_NOW" });
  }

  refreshReserve(): Promise<ReserveStatusDto | null> {
    return this.request<ReserveStatusDto | null>({ type: "REFRESH_RESERVE" });
  }

  probeNode(url: string): Promise<NodeProbeResultDto> {
    return this.request<NodeProbeResultDto>({ type: "PROBE_NODE", url });
  }

  switchNode(url: string, saveAsCustom?: boolean): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({
      type: "SWITCH_NODE",
      url,
      ...(saveAsCustom !== undefined ? { saveAsCustom } : {})
    });
  }

  listSubaddresses(): Promise<readonly SubaddressDto[]> {
    return this.request<readonly SubaddressDto[]>({ type: "LIST_SUBADDRESSES" });
  }

  createSubaddress(label?: string): Promise<SubaddressDto> {
    return this.request<SubaddressDto>({
      type: "CREATE_SUBADDRESS",
      ...(label !== undefined ? { label } : {})
    });
  }

  setSubaddressLabel(index: number, label: string): Promise<readonly SubaddressDto[]> {
    return this.request<readonly SubaddressDto[]>({
      type: "SET_SUBADDRESS_LABEL",
      index,
      label
    });
  }

  getHistory(filter?: {
    readonly asset?: string;
    readonly direction?: "incoming" | "outgoing";
  }): Promise<readonly WalletTxDto[]> {
    return this.request<readonly WalletTxDto[]>({
      type: "GET_HISTORY",
      ...(filter?.asset ? { asset: filter.asset } : {}),
      ...(filter?.direction ? { direction: filter.direction } : {})
    });
  }

  refreshPool(): Promise<{ readonly poolCount: number; readonly txs: readonly WalletTxDto[] }> {
    return this.request<{ readonly poolCount: number; readonly txs: readonly WalletTxDto[] }>({
      type: "REFRESH_POOL"
    });
  }

  exportTxProof(params: {
    readonly kind: ProofKind;
    readonly txHash: string;
    readonly address?: string;
    readonly message?: string;
  }): Promise<string> {
    return this.request<string>({
      type: "EXPORT_TX_PROOF",
      kind: params.kind,
      txHash: params.txHash,
      ...(params.address ? { address: params.address } : {}),
      ...(params.message !== undefined ? { message: params.message } : {})
    });
  }

  subscribe(listener: (snapshot: WalletSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.ensurePort();
    return () => {
      this.listeners.delete(listener);
    };
  }
}
