import { describe, expect, it } from "vitest";
import {
  ZephyrWalletError,
  type ZephyrConversionConfig,
  type ZephyrPreparedConversion,
  type ZephyrPreparedSweep,
  type ZephyrPreparedTransfer,
  type ZephyrRelayResult,
  type ZephyrSweepUnlockedConfig,
  type ZephyrTransferConfig,
  type ZephyrWallet
} from "@loki-notfound/zephyr-ts";
import type { ReserveStatusDto, WalletSnapshot } from "../rpc/protocol.js";
import type { VaultBlobStore } from "../storage/types.js";
import { generateCorePassword, generateDek } from "../vault/crypto.js";
import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind,
  WalletManifestEntry
} from "../vault/types.js";
import { TxFlowController, TxFlowError, type TxFlowWallet } from "./tx-flow.js";
import { WalletEngine } from "./wallet-engine.js";

const ADDR_A =
  "ZEPHYR3dc1432222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
const ADDR_B =
  "ZEPHs99ab871111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
const TX_HASH = "e".repeat(64);

function makeHealthyReserve(height = 913_600): ReserveStatusDto {
  return {
    height,
    hfVersion: 11,
    reserveRatio: "5.20",
    reserveRatioMa: "5.15",
    health: "healthy",
    conversions: {
      mintZsd: true,
      redeemZsd: true,
      mintZrs: true,
      redeemZrs: true,
      mintZys: true,
      redeemZys: true
    },
    statusSummary: "Reserve ratio healthy — all Zephyr protocol conversions are available.",
    prices: {
      zphUsdSpot: "2.0000",
      zphUsdMa: "1.9800",
      zsdSpot: "0.5000",
      zsdMa: "0.5050",
      zrsSpot: "1.2500",
      zrsMa: "1.2200",
      zysPrice: "1.0500",
      timestamp: 1_700_000_000
    },
    updatedAt: 1_700_000_000_000
  };
}

class ControlledVaultStore implements VaultBlobStore {
  meta: EncryptedVaultMetaRecord | undefined = undefined;
  readonly blobs = new Map<string, EncryptedWalletBlobRecord>();
  failReadMeta = false;
  failNextAtomicWrite = false;
  atomicWriteHook: ((blobs: readonly EncryptedWalletBlobRecord[]) => Promise<void>) | undefined;

  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    if (this.failReadMeta) {
      throw new Error("Simulated IndexedDB readMeta failure");
    }
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
    if (this.failNextAtomicWrite) {
      this.failNextAtomicWrite = false;
      throw new Error("Simulated IDB atomic write failure");
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

function makeFakeWallet(overrides?: {
  syncHandler?: () => Promise<{ numBlocksFetched: number; receivedMoney: boolean }>;
  relayHandler?: (token: string) => Promise<ZephyrRelayResult>;
  refreshPoolHandler?: () => Promise<number>;
  getDataHandler?: () => Promise<{ keys: Uint8Array; cache: Uint8Array }>;
  prepareTransferHandler?: (c: ZephyrTransferConfig) => Promise<ZephyrPreparedTransfer>;
  prepareSweepHandler?: (c: ZephyrSweepUnlockedConfig) => Promise<ZephyrPreparedSweep>;
  proxied?: boolean;
}) {
  let closed = false;
  let terminated = false;
  let slot = 0;

  const wallet = {
    isViewOnly: async () => false,
    getPrimaryAddress: async () => ADDR_A,
    setDaemonConnection: async () => {},
    getHeight: async () => 913_600,
    getDaemonHeight: async () => 913_600,
    getBalance: async () => new Map([["ZPH", 100_000_000_000_000n]]),
    getUnlockedBalance: async () => new Map([["ZPH", 100_000_000_000_000n]]),
    sync: async () =>
      overrides?.syncHandler
        ? overrides.syncHandler()
        : { numBlocksFetched: 0, receivedMoney: false },
    refreshPool: async () => (overrides?.refreshPoolHandler ? overrides.refreshPoolHandler() : 0),
    getData: async () =>
      overrides?.getDataHandler
        ? overrides.getDataHandler()
        : { keys: new Uint8Array([1, 2, 3]), cache: new Uint8Array([4, 5, 6]) },
    prepareTransfer: async (config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer> => {
      if (overrides?.prepareTransferHandler) return overrides.prepareTransferHandler(config);
      const total = config.destinations.reduce((s, d) => s + d.amount, 0n);
      const fee = 10_000_000_000n;
      return {
        token: `slot-${++slot}`,
        build: {
          multipleTxs: false,
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
    prepareSweepUnlocked: async (
      config: ZephyrSweepUnlockedConfig
    ): Promise<ZephyrPreparedSweep> => {
      if (overrides?.prepareSweepHandler) return overrides.prepareSweepHandler(config);
      const amt = 50_000_000_000_000n;
      const fee = 10_000_000_000n;
      return {
        token: `sweep-${++slot}`,
        build: {
          multipleTxs: false,
          totalAmount: amt,
          totalFee: fee,
          txs: [
            {
              hash: TX_HASH,
              sourceAsset: config.asset,
              destinationAsset: config.asset,
              destinations: [{ address: config.address, amount: amt }],
              amount: amt,
              fee,
              feeAsset: config.asset,
              totalDebited: amt + fee,
              change: 0n,
              ringSize: 16,
              inputs: 1,
              outputs: 1,
              weight: 2000,
              unlockTime: 0n
            }
          ]
        }
      };
    },
    prepareConversion: async (
      config: ZephyrConversionConfig
    ): Promise<ZephyrPreparedConversion> => {
      const fee = 10_000_000_000n;
      return {
        token: `conv-${++slot}`,
        build: {
          hash: TX_HASH,
          sourceAsset: config.sourceAsset,
          destinationAsset: config.destinationAsset,
          destination: { address: config.destination.address, amount: config.destination.amount },
          amountBurnt: config.destination.amount,
          amountMinted: config.destination.amount * 2n,
          fee,
          feeAsset: config.sourceAsset,
          totalDebited: config.destination.amount + fee,
          change: 0n,
          ringSize: 16,
          inputs: 1,
          outputs: 2,
          weight: 2000,
          unlockTime: 0n,
          pricingRecordHeight: 913_600
        }
      };
    },
    relayPrepared: async (token: string): Promise<ZephyrRelayResult> =>
      overrides?.relayHandler
        ? overrides.relayHandler(token)
        : { txs: [{ hash: TX_HASH, outcome: "accepted", notRelayed: false }], complete: true },
    discardPrepared: async () => true,
    isClosed: () => closed || terminated,
    close: async () => {
      closed = true;
    },
    proxied: overrides?.proxied ?? true,
    terminate: async () => {
      terminated = true;
    }
  } as unknown as ZephyrWallet;

  return {
    wallet,
    isClosed: () => closed,
    isTerminated: () => terminated
  };
}

describe("Security audit hardening regressions", () => {
  it("F-02: lockWallet pre-empts a hung WASM sync and terminates the proxied worker promptly", async () => {
    const store = new ControlledVaultStore();
    const { dekKey } = await generateDek();
    let syncStarted!: () => void;
    const syncStartedPromise = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });

    const fake = makeFakeWallet({
      proxied: true,
      syncHandler: () =>
        new Promise(() => {
          // Simulates a stalled long chain scan that never resolves until worker termination
          syncStarted();
        }),
      getDataHandler: () =>
        new Promise(() => {
          // Simulates zephyr-ts serializing getData() behind the stalled sync()
        })
    });

    const engine = new WalletEngine({
      store,
      hostKind: "chrome-offscreen",
      enableBackgroundSync: false,
      lockCheckpointTimeoutMs: 100,
      closeTimeoutMs: 100
    });

    const entry: WalletManifestEntry = {
      id: "w-f02",
      name: "Lock During Sync",
      network: "mainnet",
      restoreHeight: 0,
      restoreHeightSource: "user",
      createdAt: "2026-11-23T00:00:00Z",
      viewOnly: false,
      seedBackupVerified: true,
      corePassword: generateCorePassword(),
      primaryAddress: ADDR_A
    };

    engine.attachTestWalletSession({
      wallet: fake.wallet,
      entry,
      dekKey,
      daemonHeight: 913_600
    });

    void engine.syncNow();
    await syncStartedPromise;

    const start = Date.now();
    const lockedSnap = await engine.lockWallet();
    const elapsed = Date.now() - start;

    expect(lockedSnap.locked).toBe(true);
    expect(fake.isTerminated()).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("F-03: relay timeout keeps in-flight barrier active until settled and ignores stale-generation late completions", async () => {
    let resolveRelay!: (r: ZephyrRelayResult) => void;
    const fake = makeFakeWallet({
      relayHandler: () =>
        new Promise<ZephyrRelayResult>((resolve) => {
          resolveRelay = resolve;
        })
    });
    const pauseEvents: boolean[] = [];
    const lateAccepted: (readonly string[])[] = [];
    let afterRelayCalls = 0;

    const controller = new TxFlowController({
      validateAddress: async () => {},
      getDaemonHeight: () => 913_600,
      getReserve: () => makeHealthyReserve(913_600),
      getNode: () => ({ url: "https://node.lateo.dev", host: "node.lateo.dev" }),
      getUnlockedBalance: () => 100_000_000_000_000n,
      persistAfterRelay: async () => {},
      onSyncPauseChange: (paused) => pauseEvents.push(paused),
      onLateRelayAccepted: (hashes) => lateAccepted.push(hashes),
      afterRelay: () => {
        afterRelayCalls++;
      },
      relayTimeoutMs: 25
    });

    controller.attach(fake.wallet as unknown as TxFlowWallet, "mainnet", false);
    const prepared = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    expect(pauseEvents[pauseEvents.length - 1]).toBe(true);

    const outcome = await controller.relay(prepared.token);
    expect(outcome.kind).toBe("relay-unknown");
    // Late promise is still pending: barrier MUST stay active and discard MUST be blocked
    expect(controller.isRelayInFlight()).toBe(true);
    expect(afterRelayCalls).toBe(0);
    await expect(controller.discard(prepared.token)).rejects.toMatchObject({
      code: "RELAY_PENDING"
    });

    // Settle the late relay promise while still attached -> triggers onLateRelayAccepted and releases barrier
    resolveRelay({ txs: [{ hash: TX_HASH, outcome: "accepted", notRelayed: false }], complete: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(controller.isRelayInFlight()).toBe(false);
    expect(afterRelayCalls).toBe(1);
    expect(lateAccepted).toEqual([[TX_HASH]]);

    // Second test: detach before late relay settles -> stale generation callback is ignored
    let resolveLate2!: (r: ZephyrRelayResult) => void;
    const fake2 = makeFakeWallet({
      relayHandler: () =>
        new Promise<ZephyrRelayResult>((resolve) => {
          resolveLate2 = resolve;
        })
    });
    controller.attach(fake2.wallet as unknown as TxFlowWallet, "mainnet", false);
    const prepared2 = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    await controller.relay(prepared2.token);
    await controller.detach();
    resolveLate2({ txs: [{ hash: TX_HASH, outcome: "accepted", notRelayed: false }], complete: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(lateAccepted).toHaveLength(1);
  });

  it("F-04 & F-05: persists unresolved-relay marker, surfaces discard verify failure, flags DOUBLE_SPEND retry, and surfaces notRelayed", async () => {
    const store = new ControlledVaultStore();
    const { dekKey } = await generateDek();
    let mode: "unknown" | "double-spend" | "not-relayed" = "unknown";
    let failRefreshPool = false;

    const fake = makeFakeWallet({
      relayHandler: async () => {
        if (mode === "unknown") {
          throw new ZephyrWalletError("RELAY_UNKNOWN", "NO_ANSWER");
        }
        if (mode === "double-spend") {
          throw new ZephyrWalletError("TX_REJECTED", "DOUBLE_SPEND");
        }
        return {
          txs: [{ hash: TX_HASH, outcome: "accepted", notRelayed: true }],
          complete: true
        };
      },
      refreshPoolHandler: async () => {
        if (failRefreshPool) throw new Error("Node unreachable");
        return 0;
      }
    });

    const engine = new WalletEngine({
      store,
      hostKind: "memory",
      enableBackgroundSync: false,
      validateAddressFn: async () => {}
    });

    const entry: WalletManifestEntry = {
      id: "w-f04",
      name: "Relay Marker Wallet",
      network: "mainnet",
      restoreHeight: 913_000,
      restoreHeightSource: "daemon",
      createdAt: "2026-11-23T00:00:00Z",
      viewOnly: false,
      seedBackupVerified: true,
      corePassword: generateCorePassword(),
      primaryAddress: ADDR_A
    };

    engine.attachTestWalletSession({
      wallet: fake.wallet,
      entry,
      dekKey,
      balances: [
        { asset: "ZPH", total: "100000000000000", unlocked: "100000000000000", locked: "0" },
        { asset: "ZSD", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZRS", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZYS", total: "0", unlocked: "0", locked: "0" }
      ],
      daemonHeight: 913_600
    });

    // 1. Trigger RELAY_UNKNOWN -> encrypted relay marker is persisted in store
    const p1 = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    const r1 = await engine.relayPrepared(p1.token);
    expect(r1.kind).toBe("relay-unknown");
    await new Promise((r) => setTimeout(r, 15));
    expect(store.blobs.has("w-f04:relay")).toBe(true);

    // 2. Discard & verify when node is unreachable -> throws VERIFICATION_FAILED and keeps unresolvedRelay blocking prepares
    failRefreshPool = true;
    await expect(engine.discardPrepared(p1.token, true)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED"
    });
    expect((await engine.getSnapshot()).unresolvedRelay).not.toBeNull();
    await expect(
      engine.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: ADDR_B, amount: "1.0" }]
      })
    ).rejects.toMatchObject({ code: "SAVE_PENDING" });

    // 3. Clearing unresolved relay via successful sync unblocks prepares
    failRefreshPool = false;
    await engine.syncNow();
    expect((await engine.getSnapshot()).unresolvedRelay).toBeNull();

    // 4. F-05: Retry after RELAY_UNKNOWN returning DOUBLE_SPEND sets verifyRequired=true
    const p2 = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    mode = "unknown";
    expect((await engine.relayPrepared(p2.token)).kind).toBe("relay-unknown");
    mode = "double-spend";
    const retryDoubleSpend = await engine.relayPrepared(p2.token);
    expect(retryDoubleSpend.kind).toBe("rejected");
    if (retryDoubleSpend.kind === "rejected") {
      expect(retryDoubleSpend.verifyRequired).toBe(true);
      expect(retryDoubleSpend.message).toContain("earlier attempt");
    }

    await engine.clearUnresolvedRelay();

    // 5. F-05: notRelayed=true is surfaced on accepted outcome
    const p3 = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    mode = "not-relayed";
    const notRelayedOut = await engine.relayPrepared(p3.token);
    expect(notRelayedOut.kind).toBe("relayed");
    if (notRelayedOut.kind === "relayed") {
      expect(notRelayedOut.notRelayed).toBe(true);
    }
  });

  it("F-07 & F-08: savingState never wedges on readMeta failure and post-relay persistFailure is not clobbered by checkpoint", async () => {
    const store = new ControlledVaultStore();
    const { dekKey } = await generateDek();
    const fake = makeFakeWallet();
    const snapshots: WalletSnapshot[] = [];

    const engine = new WalletEngine({
      store,
      hostKind: "memory",
      enableBackgroundSync: false,
      validateAddressFn: async () => {},
      onSnapshot: (s) => snapshots.push(s)
    });

    const entry: WalletManifestEntry = {
      id: "w-f07",
      name: "Persist Hardening",
      network: "mainnet",
      restoreHeight: 913_000,
      restoreHeightSource: "daemon",
      createdAt: "2026-11-23T00:00:00Z",
      viewOnly: false,
      seedBackupVerified: true,
      corePassword: generateCorePassword(),
      primaryAddress: ADDR_A
    };

    engine.attachTestWalletSession({
      wallet: fake.wallet,
      entry,
      dekKey,
      balances: [
        { asset: "ZPH", total: "100000000000000", unlocked: "100000000000000", locked: "0" },
        { asset: "ZSD", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZRS", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZYS", total: "0", unlocked: "0", locked: "0" }
      ],
      daemonHeight: 913_600
    });

    // F-07: readMeta throws during post-relay save -> savingState must still clear cleanly
    store.failReadMeta = true;
    store.failNextAtomicWrite = true;
    const prepared = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    const out = await engine.relayPrepared(prepared.token);
    expect(out.kind).toBe("relayed-unsaved");
    const snap = await engine.getSnapshot();
    expect(snap.savingState).toBe(false);
    expect(snap.persistFailure).not.toBeNull();
    // F-18: raw store error text must not leak into persistFailure.message
    expect(snap.persistFailure?.message).toBe("IndexedDB commit failed after relay");

    // F-08: a subsequent sync checkpoint must NOT clobber the unresolved post-relay persistFailure
    store.failReadMeta = false;
    await engine.syncNow();
    expect((await engine.getSnapshot()).persistFailure).not.toBeNull();

    // Explicit retryPersist clears it
    const retried = await engine.retryPersist();
    expect(retried.persistFailure).toBeNull();
    expect(retried.savingState).toBe(false);
  });

  it("F-20 & F-21: enforces full destination invariants, sweep destination presence, attempt accounting after beforeRelay, and relay-time node host", async () => {
    let activeHost = "node-a.example.org";
    let denyPermission = true;
    let corruptTransferDest = false;
    let omitSweepDest = false;

    const fake = makeFakeWallet({
      prepareTransferHandler: async (config) => ({
        token: "slot-bad",
        build: {
          multipleTxs: false,
          txs: [
            {
              hash: TX_HASH,
              sourceAsset: config.asset,
              destinationAsset: config.asset,
              destinations: corruptTransferDest
                ? [{ address: ADDR_A, amount: config.destinations[0]!.amount }]
                : config.destinations.map((d) => ({ address: d.address, amount: d.amount })),
              amount: config.destinations.reduce((s, d) => s + d.amount, 0n),
              fee: 10_000_000_000n,
              feeAsset: config.asset,
              totalDebited: config.destinations.reduce((s, d) => s + d.amount, 0n) + 10_000_000_000n,
              change: 0n,
              ringSize: 16,
              inputs: 1,
              outputs: 2,
              weight: 2000,
              unlockTime: 0n
            }
          ]
        }
      }),
      prepareSweepHandler: async (config) => ({
        token: "sweep-bad",
        build: {
          multipleTxs: false,
          totalAmount: 10_000_000_000_000n,
          totalFee: 10_000_000_000n,
          txs: [
            {
              hash: TX_HASH,
              sourceAsset: config.asset,
              destinationAsset: config.asset,
              ...(omitSweepDest ? {} : { destinations: [{ address: config.address, amount: 10_000_000_000_000n }] }),
              amount: 10_000_000_000_000n,
              fee: 10_000_000_000n,
              feeAsset: config.asset,
              totalDebited: 10_010_000_000_000n,
              change: 0n,
              ringSize: 16,
              inputs: 1,
              outputs: 1,
              weight: 2000,
              unlockTime: 0n
            }
          ]
        }
      })
    });

    const controller = new TxFlowController({
      validateAddress: async () => {},
      getDaemonHeight: () => 913_600,
      getReserve: () => makeHealthyReserve(913_600),
      getNode: () => ({ url: `https://${activeHost}`, host: activeHost }),
      getUnlockedBalance: () => 100_000_000_000_000n,
      persistAfterRelay: async () => {},
      beforeRelay: async () => {
        if (denyPermission) {
          throw new TxFlowError("BUILD_FAILED", "Host permission required");
        }
      }
    });
    controller.attach(fake.wallet as unknown as TxFlowWallet, "mainnet", false);

    // F-20: divergent transfer destination address rejected
    corruptTransferDest = true;
    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: ADDR_B, amount: "1.0" }]
      })
    ).rejects.toMatchObject({ code: "BUILD_FAILED" });
    corruptTransferDest = false;

    // F-20: sweep with missing destinations rejected
    omitSweepDest = true;
    await expect(
      controller.prepareSweep({ asset: "ZPH", address: ADDR_B })
    ).rejects.toMatchObject({ code: "BUILD_FAILED" });
    omitSweepDest = false;

    // F-21: permission failure in beforeRelay must NOT burn a relay attempt
    const prepared = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: ADDR_B, amount: "1.0" }]
    });
    await expect(controller.relay(prepared.token)).rejects.toMatchObject({ code: "BUILD_FAILED" });
    expect(controller.getPending()?.relayAttempts).toBe(0);

    // F-21: node switched before relay -> receipt records the active node at relay time
    denyPermission = false;
    activeHost = "node-b.example.org";
    const outcome = await controller.relay(prepared.token);
    expect(outcome.kind).toBe("relayed");
    if (outcome.kind === "relayed") {
      expect(outcome.nodeHost).toBe("node-b.example.org");
    }
  });

  it("F-09: setInitialNodeUrl configures startup node without overriding explicit setActiveNode", async () => {
    const store = new ControlledVaultStore();
    const engine = new WalletEngine({
      store,
      hostKind: "firefox-event-page",
      enableBackgroundSync: false
    });
    engine.setInitialNodeUrl("https://custom.example.org:17767");
    expect((await engine.getSnapshot()).sync.nodeUrl).toBe("https://custom.example.org:17767");

    await engine.setActiveNode("https://switched.example.org");
    engine.setInitialNodeUrl("https://stale.example.org");
    expect((await engine.getSnapshot()).sync.nodeUrl).toBe("https://switched.example.org");
  });
});
