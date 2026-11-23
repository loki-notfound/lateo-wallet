import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateCorePassword,
  generateDek,
  type EncryptedVaultMetaRecord,
  type EncryptedWalletBlobRecord,
  type VaultBlobStore,
  type WalletBlobKind,
  type WalletEngine,
  type WalletManifestEntry
} from "@lateo-wallet/core";

type TestZephyrWallet = Parameters<WalletEngine["attachTestWalletSession"]>[0]["wallet"];
import { resolveWebDefaultNodeUrl } from "./default-node.js";
import {
  WEB_PREFS_STORAGE_KEY,
  WebPrefsStore,
  type KeyValueStorageLike
} from "./prefs-store.js";
import { WebWalletClient, type WindowEventTargetLike } from "./web-wallet-client.js";

const VALID_ADDR =
  "ZEPHYR3dc1432222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
const TX_HASH = "a".repeat(64);

class MemoryStorage implements KeyValueStorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class FakeWindowTarget implements WindowEventTargetLike {
  private readonly handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.handlers.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event): void {
    for (const h of this.handlers.get(type) ?? []) {
      if (typeof h === "function") h(event);
      else h.handleEvent(event);
    }
  }
}

class ControlledStore implements VaultBlobStore {
  meta: EncryptedVaultMetaRecord | undefined;
  readonly blobs = new Map<string, EncryptedWalletBlobRecord>();
  atomicWriteHook: ((blobs: readonly EncryptedWalletBlobRecord[]) => Promise<void>) | undefined;

  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    return this.meta;
  }
  async writeMeta(record: EncryptedVaultMetaRecord): Promise<void> {
    this.meta = record;
  }
  async readBlob(
    walletId: string,
    kind: WalletBlobKind
  ): Promise<EncryptedWalletBlobRecord | undefined> {
    return this.blobs.get(`${walletId}:${kind}`);
  }
  async writeBlob(record: EncryptedWalletBlobRecord): Promise<void> {
    this.blobs.set(record.key, record);
  }
  async writeBlobsAtomic(blobs: readonly EncryptedWalletBlobRecord[]): Promise<void> {
    if (this.atomicWriteHook) {
      await this.atomicWriteHook(blobs);
    }
    for (const b of blobs) {
      this.blobs.set(b.key, b);
    }
  }
  async deleteWalletBlobs(walletId: string): Promise<void> {
    this.blobs.delete(`${walletId}:keys`);
    this.blobs.delete(`${walletId}:cache`);
    this.blobs.delete(`${walletId}:relay`);
  }
  async clearAll(): Promise<void> {
    this.meta = undefined;
    this.blobs.clear();
  }
}

function makeFakeWallet(): TestZephyrWallet {
  let closed = false;
  const fake = {
    proxied: false,
    isClosed: () => closed,
    isViewOnly: async () => false,
    close: async () => {
      closed = true;
    },
    terminate: async () => {
      closed = true;
    },
    getPrimaryAddress: async () => VALID_ADDR,
    getHeight: async () => 913_600,
    getDaemonHeight: async () => 913_600,
    setDaemonConnection: async () => {},
    getBalance: async () => new Map([["ZPH", 100_000_000_000_000n]]),
    getUnlockedBalance: async () => new Map([["ZPH", 100_000_000_000_000n]]),
    getData: async () => ({
      keys: new Uint8Array([1, 2, 3, 4]),
      cache: new Uint8Array([5, 6, 7, 8])
    }),
    sync: async () => ({ numBlocksFetched: 0, receivedMoney: false }),
    prepareTransfer: async (cfg: {
      readonly asset: string;
      readonly destinations: readonly { readonly address: string; readonly amount: bigint }[];
    }) => {
      const amount = cfg.destinations.reduce((acc, d) => acc + d.amount, 0n);
      const fee = 10_000_000_000n;
      return {
        token: "tok-web-test",
        build: {
          multipleTxs: false,
          txs: [
            {
              hash: TX_HASH,
              fee,
              feeAsset: cfg.asset,
              amount,
              totalDebited: amount + fee,
              sourceAsset: cfg.asset,
              destinationAsset: cfg.asset,
              destinations: cfg.destinations.map((d) => ({
                address: d.address,
                amount: d.amount
              })),
              change: 0n,
              ringSize: 16,
              inputs: 1,
              outputs: 2,
              weight: 2000,
              unlockTime: 0n
            }
          ]
        }
      };
    },
    relayPrepared: async () => ({
      txs: [{ hash: TX_HASH, outcome: "accepted" as const, notRelayed: false }],
      complete: true
    }),
    discardPrepared: async () => {}
  };
  return fake as unknown as TestZephyrWallet;
}

describe("resolveWebDefaultNodeUrl", () => {
  it("uses same-origin /rpc on HTTPS and localhost origins and falls back otherwise", () => {
    expect(resolveWebDefaultNodeUrl({ origin: "https://wallet.lateo.dev" })).toBe(
      "https://wallet.lateo.dev/rpc"
    );
    expect(resolveWebDefaultNodeUrl({ origin: "http://127.0.0.1:4173" })).toBe(
      "http://127.0.0.1:4173/rpc"
    );
    expect(resolveWebDefaultNodeUrl({ origin: "http://localhost:5173" })).toBe(
      "http://localhost:5173/rpc"
    );
    expect(resolveWebDefaultNodeUrl({ origin: "http://192.168.1.25:4173" })).toBe(
      "https://node.lateo.dev"
    );
    expect(resolveWebDefaultNodeUrl({ origin: "null" })).toBe("https://node.lateo.dev");
  });
});

describe("WebPrefsStore", () => {
  it("persists only sanitized non-sensitive preferences in localStorage", async () => {
    const storage = new MemoryStorage();
    const store = new WebPrefsStore({
      storage,
      defaultNodeUrl: "https://wallet.lateo.dev/rpc"
    });

    const initial = await store.readPrefs();
    expect(initial).toEqual({
      theme: "system",
      autoLockMinutes: 15,
      activePublicNode: "https://wallet.lateo.dev/rpc",
      customNodes: []
    });

    const updated = await store.writePrefs({
      theme: "dark",
      autoLockMinutes: 9999,
      activePublicNode: "https://custom.example.org/",
      customNodes: ["https://wallet.lateo.dev/rpc", "http://bad.example.org", "http://127.0.0.1:17767/"]
    });

    expect(updated).toEqual({
      theme: "dark",
      autoLockMinutes: 1440,
      activePublicNode: "https://custom.example.org",
      customNodes: ["http://127.0.0.1:17767"]
    });

    expect(Array.from(storage.map.keys())).toEqual([WEB_PREFS_STORAGE_KEY]);
    const persisted = JSON.parse(storage.map.get(WEB_PREFS_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([
      "activePublicNode",
      "autoLockMinutes",
      "customNodes",
      "theme"
    ]);
  });
});

describe("WebWalletClient lifecycle guards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers idle auto-lock and triggers beforeunload warning while savingState === true", async () => {
    vi.useFakeTimers();

    const storage = new MemoryStorage();
    const prefsStore = new WebPrefsStore({
      storage,
      defaultNodeUrl: "https://wallet.lateo.dev/rpc"
    });
    await prefsStore.writePrefs({ autoLockMinutes: 1 });

    const store = new ControlledStore();
    const win = new FakeWindowTarget();
    const client = new WebWalletClient({
      store,
      prefsStore,
      defaultNodeUrl: "https://wallet.lateo.dev/rpc",
      windowTarget: win,
      deferRetryMs: 5_000,
      engineOptions: {
        proxyToWorker: false,
        enableBackgroundSync: false,
        validateAddressFn: async () => {}
      }
    });

    try {
      const { dekKey } = await generateDek();
      const entry: WalletManifestEntry = {
        id: "w-web-1",
        name: "Web Test",
        network: "mainnet",
        restoreHeight: 913_600,
        restoreHeightSource: "daemon",
        createdAt: "2026-11-23T00:00:00.000Z",
        viewOnly: false,
        seedBackupVerified: true,
        corePassword: generateCorePassword(),
        primaryAddress: VALID_ADDR
      };
      client.engine.attachTestWalletSession({
        wallet: makeFakeWallet(),
        entry,
        dekKey,
        balances: [
          {
            asset: "ZPH",
            total: "100000000000000",
            unlocked: "100000000000000",
            locked: "0"
          }
        ],
        daemonHeight: 913_600
      });

      const snap0 = await client.getSnapshot();
      expect(snap0.locked).toBe(false);
      expect(snap0.savingState).toBe(false);

      // Before saving: beforeunload must NOT warn
      const evIdle = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault() {
          this.prevented = true;
        }
      };
      win.dispatch("beforeunload", evIdle as unknown as Event);
      expect(evIdle.prevented).toBe(false);

      // Hold the post-relay IndexedDB write open so savingState === true
      let releaseWrite!: () => void;
      let writeStarted!: () => void;
      const writeStartedPromise = new Promise<void>((r) => {
        writeStarted = r;
      });
      store.atomicWriteHook = () => {
        writeStarted();
        return new Promise<void>((r) => {
          releaseWrite = r;
        });
      };

      const prepared = await client.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_ADDR, amount: "1.25" }]
      });
      expect(prepared.kind).toBe("transfer");

      const relayPromise = client.relayPrepared(prepared.token);
      await writeStartedPromise;

      const snapSaving = await client.getSnapshot();
      expect(snapSaving.savingState).toBe(true);
      expect(snapSaving.savingKind).toBe("post-relay");

      // While savingState === true: beforeunload MUST preventDefault
      const evSaving = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault() {
          this.prevented = true;
        }
      };
      win.dispatch("beforeunload", evSaving as unknown as Event);
      expect(evSaving.prevented).toBe(true);
      expect(evSaving.returnValue).toBe("");

      // Advance past the 1-minute idle auto-lock timeout while savingState === true:
      // wallet MUST remain unlocked (deferred)
      await vi.advanceTimersByTimeAsync(65_000);
      expect((await client.getSnapshot()).locked).toBe(false);

      // Release the IndexedDB commit: relay resolves, savingState clears, beforeunload stops warning
      releaseWrite();
      const outcome = await relayPromise;
      expect(outcome.kind).toBe("relayed");

      const snapSaved = await client.getSnapshot();
      expect(snapSaved.savingState).toBe(false);
      expect(snapSaved.locked).toBe(false);

      const evAfter = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault() {
          this.prevented = true;
        }
      };
      win.dispatch("beforeunload", evAfter as unknown as Event);
      expect(evAfter.prevented).toBe(false);

      // Advance past the idle auto-lock timer now that saving is complete -> locks cleanly!
      await vi.advanceTimersByTimeAsync(65_000);
      expect((await client.getSnapshot()).locked).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("resets custom node URL back to defaultNodeUrl on resetVault even after switchNode", async () => {
    const storage = new MemoryStorage();
    const prefsStore = new WebPrefsStore({
      storage,
      defaultNodeUrl: "https://wallet.lateo.dev/rpc"
    });
    const client = new WebWalletClient({
      store: new ControlledStore(),
      prefsStore,
      defaultNodeUrl: "https://wallet.lateo.dev/rpc",
      windowTarget: null,
      documentTarget: null,
      engineOptions: {
        proxyToWorker: false,
        enableBackgroundSync: false
      }
    });

    try {
      const switched = await client.switchNode("https://custom.example.org", true);
      expect(switched.sync.nodeUrl).toBe("https://custom.example.org");
      expect((await client.getPrefs()).customNodes).toEqual(["https://custom.example.org"]);

      const resetSnap = await client.resetVault();
      expect(resetSnap.sync.nodeUrl).toBe("https://wallet.lateo.dev/rpc");
      expect((await client.getPrefs()).activePublicNode).toBe("https://wallet.lateo.dev/rpc");
      expect((await client.getPrefs()).customNodes).toEqual([]);
    } finally {
      client.dispose();
    }
  });
});
