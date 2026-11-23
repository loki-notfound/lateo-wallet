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
import type { LateoDesktopBridge, NodeAuthorizationScope } from "../shared/bridge.js";
import { DesktopWalletClient } from "./desktop-wallet-client.js";

type TestZephyrWallet = Parameters<WalletEngine["attachTestWalletSession"]>[0]["wallet"];

const VALID_ADDR =
  "ZEPHYR2a9A1h4F6j9K2m5N8p1Q4r7S0t3U6v9W2x5Y8z1A4b7C0d3E6f9G2h5J8k1M4n7P0q3R6s9T2u5V8w1X4y7Z0a3B6c9";
const TX_HASH = "a".repeat(64);

class MemoryStore implements VaultBlobStore {
  private meta: EncryptedVaultMetaRecord | undefined;
  private blobs = new Map<string, EncryptedWalletBlobRecord>();

  async readMeta() {
    return this.meta;
  }
  async writeMeta(r: EncryptedVaultMetaRecord) {
    this.meta = r;
  }
  async readBlob(id: string, kind: WalletBlobKind) {
    return this.blobs.get(`${id}:${kind}`);
  }
  async writeBlob(r: EncryptedWalletBlobRecord) {
    this.blobs.set(r.key, r);
  }
  async writeBlobsAtomic(blobs: readonly EncryptedWalletBlobRecord[]) {
    for (const b of blobs) this.blobs.set(b.key, b);
  }
  async writeVaultAtomic(m: EncryptedVaultMetaRecord, blobs: readonly EncryptedWalletBlobRecord[]) {
    this.meta = m;
    for (const b of blobs) this.blobs.set(b.key, b);
  }
  async deleteWalletBlobs(id: string) {
    this.blobs.delete(`${id}:keys`);
    this.blobs.delete(`${id}:cache`);
    this.blobs.delete(`${id}:relay`);
  }
  async clearAll() {
    this.meta = undefined;
    this.blobs.clear();
  }
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

class FakeEventTarget {
  private map = new Map<string, Set<EventListenerOrEventListenerObject>>();
  visibilityState = "visible";

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.map.get(type)?.delete(listener);
  }
  dispatch(type: string, event: Event): void {
    for (const l of this.map.get(type) ?? []) {
      if (typeof l === "function") l(event);
      else l.handleEvent(event);
    }
  }
}

function makeFakeWallet(
  relayHandler?: () => Promise<{ txs: Array<{ hash: string; outcome: "accepted"; notRelayed: boolean }>; complete: boolean }>
): TestZephyrWallet {
  let closed = false;
  return {
    proxied: false,
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
    terminate: async () => {
      closed = true;
    },
    isViewOnly: async () => false,
    getPrimaryAddress: async () => VALID_ADDR,
    getHeight: async () => 913_600,
    getDaemonHeight: async () => 913_600,
    setDaemonConnection: async () => {},
    getBalance: async () => new Map([["ZPH", 50_000_000_000_000n]]),
    getUnlockedBalance: async () => new Map([["ZPH", 50_000_000_000_000n]]),
    getData: async () => ({ keys: new Uint8Array([1, 2]), cache: new Uint8Array([3, 4]) }),
    prepareTransfer: async (config: {
      asset: string;
      destinations: ReadonlyArray<{ address: string; amount: bigint }>;
    }) => {
      const total = config.destinations.reduce((acc, d) => acc + d.amount, 0n);
      const fee = 10_000_000_000n;
      return {
        token: "core-token-desktop",
        build: {
          multipleTxs: false,
          totalAmount: total,
          totalFee: fee,
          txs: [
            {
              hash: TX_HASH,
              sourceAsset: config.asset,
              destinationAsset: config.asset,
              destinations: config.destinations.map((d) => ({
                address: d.address,
                amount: d.amount
              })),
              amount: total,
              fee,
              feeAsset: config.asset,
              totalDebited: total + fee,
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
    relayPrepared: async () =>
      relayHandler
        ? relayHandler()
        : { txs: [{ hash: TX_HASH, outcome: "accepted", notRelayed: false }], complete: true },
    discardPrepared: async () => true
  } as unknown as TestZephyrWallet;
}

describe("DesktopWalletClient lifecycle and security guards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces wall-clock idle deadline after OS sleep and responds to powerMonitor lock requests", async () => {
    vi.useFakeTimers();
    const startTime = 1_700_000_000_000;
    vi.setSystemTime(startTime);

    const win = new FakeEventTarget();
    const doc = new FakeEventTarget();
    const authCalls: Array<{ url: string; scope: NodeAuthorizationScope }> = [];
    let systemLockCb: (() => void) | null = null;
    const bridge: LateoDesktopBridge = {
      version: "0.1.0",
      platform: "linux",
      isSafeStorageAvailable: async () => false,
      authorizeNodeOrigin: async (url, scope) => {
        authCalls.push({ url, scope });
        return true;
      },
      onSystemLockRequest: (cb) => {
        systemLockCb = cb;
        return () => {
          systemLockCb = null;
        };
      }
    };

    const client = new DesktopWalletClient({
      store: new MemoryStore(),
      storage: new MemoryStorage(),
      windowTarget: win,
      documentTarget: doc,
      bridge,
      offlineMode: true,
      engineOptions: {
        proxyToWorker: false,
        enableBackgroundSync: false,
        validateAddressFn: async () => {}
      }
    });

    try {
      await client.updatePrefs({ autoLockMinutes: 2 });
      const { dekKey } = await generateDek();
      const entry: WalletManifestEntry = {
        id: "w-desktop-1",
        name: "Desktop Test",
        network: "mainnet",
        restoreHeight: 913_600,
        restoreHeightSource: "daemon",
        createdAt: "2026-11-23T00:00:00Z",
        viewOnly: false,
        seedBackupVerified: true,
        corePassword: generateCorePassword(),
        primaryAddress: VALID_ADDR
      };

      client.engine.attachTestWalletSession({
        wallet: makeFakeWallet(),
        entry,
        dekKey,
        daemonHeight: 913_600
      });
      await client.getSnapshot();
      expect((await client.getSnapshot()).locked).toBe(false);

      // Simulate OS sleep: wall clock advances 3 minutes without firing setTimeout
      vi.setSystemTime(startTime + 3 * 60_000);
      win.dispatch("pointerdown", new Event("pointerdown"));
      await vi.waitFor(async () => {
        expect((await client.getSnapshot()).locked).toBe(true);
      });

      // Re-attach and verify powerMonitor lock-screen/suspend locks immediately
      client.engine.attachTestWalletSession({
        wallet: makeFakeWallet(),
        entry,
        dekKey,
        daemonHeight: 913_600
      });
      await client.getSnapshot();
      expect((await client.getSnapshot()).locked).toBe(false);
      expect(systemLockCb).not.toBeNull();
      systemLockCb!();
      await vi.waitFor(async () => {
        expect((await client.getSnapshot()).locked).toBe(true);
      });

      // Verify switchNode authorizes the new origin with scope "active"
      await client.switchNode("http://127.0.0.1:17767");
      expect(authCalls.some((c) => c.url === "http://127.0.0.1:17767" && c.scope === "active")).toBe(
        true
      );
    } finally {
      client.dispose();
    }
  });

  it("arms beforeunload and defers idle auto-lock while pendingTx is relay-unknown", async () => {
    vi.useFakeTimers();
    const win = new FakeEventTarget();
    const doc = new FakeEventTarget();
    const client = new DesktopWalletClient({
      store: new MemoryStore(),
      storage: new MemoryStorage(),
      windowTarget: win,
      documentTarget: doc,
      bridge: null,
      offlineMode: true,
      deferRetryMs: 5_000,
      engineOptions: {
        proxyToWorker: false,
        enableBackgroundSync: false,
        validateAddressFn: async () => {}
      }
    });

    try {
      await client.updatePrefs({ autoLockMinutes: 1 });
      const { dekKey } = await generateDek();
      const entry: WalletManifestEntry = {
        id: "w-desktop-2",
        name: "Desktop Relay Unknown",
        network: "mainnet",
        restoreHeight: 913_600,
        restoreHeightSource: "daemon",
        createdAt: "2026-11-23T00:00:00Z",
        viewOnly: false,
        seedBackupVerified: true,
        corePassword: generateCorePassword(),
        primaryAddress: VALID_ADDR
      };

      client.engine.attachTestWalletSession({
        wallet: makeFakeWallet(async () => {
          throw Object.assign(new Error("Daemon unreachable"), {
            code: "RELAY_UNKNOWN",
            diagnostic: "DAEMON_UNREACHABLE"
          });
        }),
        entry,
        dekKey,
        balances: [
          { asset: "ZPH", total: "50000000000000", unlocked: "50000000000000", locked: "0" },
          { asset: "ZSD", total: "0", unlocked: "0", locked: "0" },
          { asset: "ZRS", total: "0", unlocked: "0", locked: "0" },
          { asset: "ZYS", total: "0", unlocked: "0", locked: "0" }
        ],
        daemonHeight: 913_600
      });
      await client.getSnapshot();

      const prepared = await client.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_ADDR, amount: "1.0" }]
      });
      const outcome = await client.relayPrepared(prepared.token);
      expect(outcome.kind).toBe("relay-unknown");

      const ev = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault() {
          this.prevented = true;
        }
      };
      win.dispatch("beforeunload", ev as unknown as Event);
      expect(ev.prevented).toBe(true);

      // Advancing past 1 minute must defer locking while relay-unknown is active
      await vi.advanceTimersByTimeAsync(65_000);
      expect((await client.getSnapshot()).locked).toBe(false);
    } finally {
      client.dispose();
    }
  });
});
