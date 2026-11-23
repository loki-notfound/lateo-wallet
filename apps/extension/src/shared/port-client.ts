import type {
  EngineEvent,
  EngineRequestPayload,
  EngineResponse,
  HostDiagnosticsDto,
  WalletClient,
  WalletSnapshot
} from "@lateo-wallet/core/rpc";

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

  createDisposableWallet(params: {
    readonly password: string;
    readonly name: string;
    readonly network?: "mainnet" | "testnet" | "stagenet";
  }): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({
      type: "CREATE_DISPOSABLE_WALLET",
      password: params.password,
      name: params.name,
      ...(params.network ? { network: params.network } : {})
    });
  }

  unlockWallet(password: string): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "UNLOCK_WALLET", password });
  }

  lockWallet(): Promise<WalletSnapshot> {
    return this.request<WalletSnapshot>({ type: "LOCK_WALLET" });
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
