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

const VALID_MAINNET_ADDR_A =
  "ZEPHYR3dc1432222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
const VALID_MAINNET_ADDR_B =
  "ZEPHs99ab871111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";

const TX_HASH_1 = "a".repeat(64);
const TX_HASH_2 = "b".repeat(64);
const TX_HASH_CONV = "c".repeat(64);

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

class MockTxFlowWallet implements TxFlowWallet {
  viewOnly = false;
  primaryAddress = VALID_MAINNET_ADDR_A;
  pricingRecordHeight = 913_600;
  prepareTransferCalls = 0;
  prepareSweepCalls = 0;
  prepareConversionCalls = 0;
  relayCalls: string[] = [];
  discardCalls: string[] = [];
  private slotCounter = 0;

  relayHandler: (token: string, attempt: number) => Promise<ZephyrRelayResult> = async () => ({
    txs: [{ hash: TX_HASH_1, outcome: "accepted", notRelayed: false }],
    complete: true
  });

  async isViewOnly(): Promise<boolean> {
    return this.viewOnly;
  }

  async getPrimaryAddress(): Promise<string> {
    return this.primaryAddress;
  }

  async prepareTransfer(config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer> {
    this.prepareTransferCalls++;
    const token = `coreslot${String(++this.slotCounter).padStart(24, "0")}`;
    const totalAmount = config.destinations.reduce((s, d) => s + d.amount, 0n);
    const fee = 15_000_000_000n; // 0.015000000000
    return {
      token,
      build: {
        multipleTxs: false,
        txs: [
          {
            hash: TX_HASH_1,
            sourceAsset: config.asset,
            destinationAsset: config.asset,
            destinations: config.destinations.map((d) => ({
              address: d.address,
              amount: d.amount
            })),
            amount: totalAmount,
            fee,
            feeAsset: config.asset,
            totalDebited: totalAmount + fee,
            change: 1_000_000_000_000n,
            ringSize: 16,
            inputs: 1,
            outputs: config.destinations.length + 1,
            weight: 2100,
            unlockTime: 0n
          }
        ]
      }
    };
  }

  async prepareSweepUnlocked(config: ZephyrSweepUnlockedConfig): Promise<ZephyrPreparedSweep> {
    this.prepareSweepCalls++;
    const token = `sweepslot${String(++this.slotCounter).padStart(23, "0")}`;
    const amount1 = 60_000_000_000_000n;
    const fee1 = 10_000_000_000n;
    const amount2 = 39_970_000_000_000n;
    const fee2 = 20_000_000_000n;
    return {
      token,
      build: {
        multipleTxs: true,
        totalAmount: amount1 + amount2,
        totalFee: fee1 + fee2,
        txs: [
          {
            hash: TX_HASH_1,
            sourceAsset: config.asset,
            destinationAsset: config.asset,
            destinations: [{ address: config.address, amount: amount1 }],
            amount: amount1,
            fee: fee1,
            feeAsset: config.asset,
            totalDebited: amount1 + fee1,
            change: 0n,
            ringSize: 16,
            inputs: 2,
            outputs: 1,
            weight: 2400,
            unlockTime: 0n
          },
          {
            hash: TX_HASH_2,
            sourceAsset: config.asset,
            destinationAsset: config.asset,
            destinations: [{ address: config.address, amount: amount2 }],
            amount: amount2,
            fee: fee2,
            feeAsset: config.asset,
            totalDebited: amount2 + fee2,
            change: 0n,
            ringSize: 16,
            inputs: 2,
            outputs: 1,
            weight: 2400,
            unlockTime: 0n
          }
        ]
      }
    };
  }

  async prepareConversion(config: ZephyrConversionConfig): Promise<ZephyrPreparedConversion> {
    this.prepareConversionCalls++;
    const token = `convslot${String(++this.slotCounter).padStart(24, "0")}`;
    const fee = 25_000_000_000n;
    const minted = config.destination.amount * 2n;
    return {
      token,
      build: {
        hash: TX_HASH_CONV,
        sourceAsset: config.sourceAsset,
        destinationAsset: config.destinationAsset,
        destination: {
          address: config.destination.address,
          amount: config.destination.amount
        },
        amountBurnt: config.destination.amount,
        amountMinted: minted,
        fee,
        feeAsset: config.sourceAsset,
        totalDebited: config.destination.amount + fee,
        change: 500_000_000_000n,
        ringSize: 16,
        inputs: 1,
        outputs: 4,
        weight: 2600,
        unlockTime: 0n,
        pricingRecordHeight: this.pricingRecordHeight
      }
    };
  }

  async relayPrepared(token: string): Promise<ZephyrRelayResult> {
    this.relayCalls.push(token);
    return this.relayHandler(token, this.relayCalls.length);
  }

  async discardPrepared(token: string): Promise<boolean> {
    this.discardCalls.push(token);
    return true;
  }
}

describe("TxFlowController M1.4 two-step prepare, review, relay & recovery", () => {
  function setupController(overrides?: {
    viewOnly?: boolean;
    daemonHeight?: number;
    reserve?: ReserveStatusDto | null;
    unlockedZph?: bigint;
    persistAfterRelay?: (txHashes: readonly string[]) => Promise<void>;
    relayTimeoutMs?: number;
  }) {
    const wallet = new MockTxFlowWallet();
    wallet.viewOnly = overrides?.viewOnly ?? false;
    let daemonHeight = overrides?.daemonHeight ?? 913_600;
    let reserve: ReserveStatusDto | null =
      overrides?.reserve !== undefined ? overrides.reserve : makeHealthyReserve(daemonHeight);
    let unlockedZph = overrides?.unlockedZph ?? 100_000_000_000_000n; // 100 ZPH
    const persistedBatches: (readonly string[])[] = [];

    const controller = new TxFlowController({
      validateAddress: async (address) => {
        if (address !== VALID_MAINNET_ADDR_A && address !== VALID_MAINNET_ADDR_B) {
          throw new Error("Invalid address");
        }
      },
      getDaemonHeight: () => daemonHeight,
      getReserve: () => reserve,
      getNode: () => ({ url: "https://node.lateo.dev", host: "node.lateo.dev" }),
      getUnlockedBalance: (asset) => (asset === "ZPH" ? unlockedZph : 50_000_000_000_000n),
      persistAfterRelay:
        overrides?.persistAfterRelay ??
        (async (txHashes) => {
          persistedBatches.push(txHashes);
        }),
      ...(overrides?.relayTimeoutMs !== undefined
        ? { relayTimeoutMs: overrides.relayTimeoutMs }
        : {})
    });

    controller.attach(wallet, "mainnet", wallet.viewOnly);
    return {
      wallet,
      controller,
      persistedBatches,
      setDaemonHeight: (h: number) => {
        daemonHeight = h;
      },
      setReserve: (r: ReserveStatusDto | null) => {
        reserve = r;
      },
      setUnlockedZph: (v: bigint) => {
        unlockedZph = v;
      }
    };
  }

  it("rejects view-only wallets on transfer, sweep, and conversion before calling core", async () => {
    const { controller, wallet } = setupController({ viewOnly: true });

    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "1.0" }]
      })
    ).rejects.toMatchObject({ code: "VIEW_ONLY" });

    await expect(
      controller.prepareSweep({
        asset: "ZPH",
        address: VALID_MAINNET_ADDR_A
      })
    ).rejects.toMatchObject({ code: "VIEW_ONLY" });

    await expect(
      controller.prepareConversion({
        sourceAsset: "ZPH",
        destinationAsset: "ZSD",
        amount: "1.0"
      })
    ).rejects.toMatchObject({ code: "VIEW_ONLY" });

    expect(wallet.prepareTransferCalls).toBe(0);
    expect(wallet.prepareSweepCalls).toBe(0);
    expect(wallet.prepareConversionCalls).toBe(0);
  });

  it("rejects invalid addresses, legacy V1 assets, >12 decimals on transfer, >4 decimals on conversion, and insufficient balance", async () => {
    const { controller, wallet } = setupController();

    // Legacy V1 asset ZEPH rejected
    await expect(
      controller.prepareTransfer({
        asset: "ZEPH",
        destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "1" }]
      })
    ).rejects.toMatchObject({ code: "INVALID_ASSET" });

    // Invalid address rejected
    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: "ZEPHYR-bad-checksum", amount: "1" }]
      })
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });

    // >12 decimals on transfer rejected
    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "1.0000000000009" }]
      })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });

    // >4 decimals on conversion strictly rejected
    await expect(
      controller.prepareConversion({
        sourceAsset: "ZPH",
        destinationAsset: "ZSD",
        amount: "1.12345"
      })
    ).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
      message: "Conversion amount allows at most 4 decimal places"
    });

    // Insufficient unlocked balance rejected
    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "500" }]
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(wallet.prepareTransferCalls).toBe(0);
    expect(wallet.prepareConversionCalls).toBe(0);
  });

  it("enforces live reserve-ratio gating on blocked pairs while allowing open pairs", async () => {
    const criticalReserve: ReserveStatusDto = {
      ...makeHealthyReserve(913_600),
      reserveRatio: "2.10",
      reserveRatioMa: "2.05",
      health: "critical",
      conversions: {
        mintZsd: false,
        redeemZsd: true,
        mintZrs: true,
        redeemZrs: false,
        mintZys: true,
        redeemZys: true
      },
      statusSummary:
        "Reserve ratio below 4.0x — ZSD minting and ZRS redeeming are paused; ZRS minting, ZSD redeeming, and ZYS conversions remain open."
    };

    const { controller, wallet } = setupController({ reserve: criticalReserve });

    // Blocked pair ZPH -> ZSD rejected with clear explanation listing open pairs
    await expect(
      controller.prepareConversion({
        sourceAsset: "ZPH",
        destinationAsset: "ZSD",
        amount: "5.25"
      })
    ).rejects.toMatchObject({
      code: "RESERVE_BLOCKED"
    });
    expect(wallet.prepareConversionCalls).toBe(0);

    // Open pair ZPH -> ZRS succeeds at the same reserve ratio
    const preparedOpen = await controller.prepareConversion({
      sourceAsset: "ZPH",
      destinationAsset: "ZRS",
      amount: "5.25",
      priority: "normal"
    });
    expect(preparedOpen.kind).toBe("conversion");
    expect(preparedOpen.sourceAsset).toBe("ZPH");
    expect(preparedOpen.destinationAsset).toBe("ZRS");
    expect(preparedOpen.totalAmount).toBe("5250000000000");
    expect(preparedOpen.amountMinted).toBe("10500000000000");
    expect(preparedOpen.pricingRecordHeight).toBe(913_600);
    expect(preparedOpen.pricingRecordExpiresAtHeight).toBe(913_610);
    expect(preparedOpen.nodeHost).toBe("node.lateo.dev");
  });

  it("enforces 10-block pricing record countdown and expires stale conversions before relay", async () => {
    const { controller, wallet, setDaemonHeight } = setupController({ daemonHeight: 913_600 });
    wallet.pricingRecordHeight = 913_600;

    const prepared = await controller.prepareConversion({
      sourceAsset: "ZPH",
      destinationAsset: "ZSD",
      amount: "10.0000"
    });
    expect(prepared.pricingRecordHeight).toBe(913_600);
    expect(prepared.pricingRecordExpiresAtHeight).toBe(913_610);

    // Advance daemon height by 10 blocks -> pricing record is now expired
    setDaemonHeight(913_610);
    const outcome = await controller.relay(prepared.token);
    expect(outcome.kind).toBe("expired");
    if (outcome.kind === "expired") {
      expect(outcome.reason).toBe("PRICING_RECORD_AGE");
    }
    // Core relayPrepared must NOT be called once pricing record expired
    expect(wallet.relayCalls.length).toBe(0);
    expect(controller.getPending()).toBeNull();
  });

  it("prepares multi-destination transfers and multi-tx sweeps with opaque tokens and full review invariants", async () => {
    const { controller, wallet } = setupController();

    const transfer = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [
        { address: VALID_MAINNET_ADDR_A, amount: "1.5" },
        { address: VALID_MAINNET_ADDR_B, amount: "2.25" }
      ],
      priority: "elevated"
    });
    expect(transfer.kind).toBe("transfer");
    expect(transfer.status).toBe("ready");
    expect(transfer.token).toMatch(/^[0-9a-f]{32}$/);
    expect(transfer.destinations).toHaveLength(2);
    expect(transfer.totalAmount).toBe("3750000000000"); // 3.75 ZPH
    expect(transfer.totalFee).toBe("15000000000"); // 0.015 ZPH
    expect(transfer.totalDebited).toBe("3765000000000");
    expect(transfer.priority).toBe("elevated");
    expect(transfer.nodeHost).toBe("node.lateo.dev");

    // Preparing a sweep voids the previous ready token and describes the multi-tx sweep
    const sweep = await controller.prepareSweep({
      asset: "ZPH",
      address: VALID_MAINNET_ADDR_B
    });
    expect(sweep.kind).toBe("sweep");
    expect(sweep.token).not.toBe(transfer.token);
    expect(sweep.txs).toHaveLength(2);
    expect(sweep.totalAmount).toBe("99970000000000");
    expect(sweep.totalFee).toBe("30000000000");
    expect(sweep.totalDebited).toBe("100000000000000");
    expect(wallet.discardCalls.length).toBe(1);

    // Detach (Lock) immediately clears and voids the prepared token
    await controller.detach();
    expect(controller.getPending()).toBeNull();
    expect(wallet.discardCalls.length).toBe(2);
  });

  it("handles RELAY_UNKNOWN across HA replicas with (a) retry exact token and (b) discard & sync, proving ZERO silent rebuilds", async () => {
    const { controller, wallet, persistedBatches } = setupController();

    const prepared = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "4.0" }]
    });
    expect(wallet.prepareTransferCalls).toBe(1);

    // Attempt 1: HA replica fails with RELAY_UNKNOWN / NO_ANSWER
    wallet.relayHandler = async () => {
      throw new ZephyrWalletError("RELAY_UNKNOWN", "NO_ANSWER");
    };
    const firstAttempt = await controller.relay(prepared.token);
    expect(firstAttempt.kind).toBe("relay-unknown");
    if (firstAttempt.kind === "relay-unknown") {
      expect(firstAttempt.canRetry).toBe(true);
      expect(firstAttempt.pending.token).toBe(prepared.token);
      expect(firstAttempt.pending.status).toBe("relay-unknown");
      expect(firstAttempt.pending.txs[0]?.hash).toBe(TX_HASH_1);
      expect(firstAttempt.pending.relayAttempts).toBe(1);
    }
    // ZERO silent rebuilds: prepareTransferCalls is still 1
    expect(wallet.prepareTransferCalls).toBe(1);

    // Attempting to prepare a new transaction while RELAY_UNKNOWN is unresolved is blocked
    await expect(
      controller.prepareTransfer({
        asset: "ZPH",
        destinations: [{ address: VALID_MAINNET_ADDR_A, amount: "1.0" }]
      })
    ).rejects.toMatchObject({ code: "RELAY_PENDING" });
    expect(wallet.prepareTransferCalls).toBe(1);

    // UI release() on popup close does NOT drop a relay-unknown transaction
    controller.release();
    expect(controller.getPending()?.status).toBe("relay-unknown");

    // Choice (a): Retry relaying the exact prepared token -> succeeds on attempt 2
    wallet.relayHandler = async () => ({
      txs: [{ hash: TX_HASH_1, outcome: "accepted", notRelayed: false }],
      complete: true
    });
    const retryOutcome = await controller.relay(prepared.token);
    expect(retryOutcome).toEqual({
      kind: "relayed",
      txHashes: [TX_HASH_1],
      relayedAt: expect.any(Number),
      nodeHost: "node.lateo.dev",
      persisted: true
    });
    // Both relay attempts used the exact same core slot token; prepareTransfer was called only once
    expect(wallet.prepareTransferCalls).toBe(1);
    expect(wallet.relayCalls).toHaveLength(2);
    expect(wallet.relayCalls[0]).toBe(wallet.relayCalls[1]);
    expect(persistedBatches).toEqual([[TX_HASH_1]]);
    expect(controller.getPending()).toBeNull();

    // Now test Choice (b): Discard & sync on a DAEMON_BUSY / DAEMON_UNREACHABLE failure
    const prepared2 = await controller.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: VALID_MAINNET_ADDR_B, amount: "2.0" }]
    });
    expect(wallet.prepareTransferCalls).toBe(2);

    wallet.relayHandler = async () => {
      throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_BUSY");
    };
    const busyAttempt = await controller.relay(prepared2.token);
    expect(busyAttempt.kind).toBe("relay-unknown");

    const discardRes = await controller.discard(prepared2.token);
    expect(discardRes.wasRelayUnknown).toBe(true);
    expect(controller.getPending()).toBeNull();
    expect(wallet.prepareTransferCalls).toBe(2);
  });
});

class BarrierMemoryStore implements VaultBlobStore {
  meta: EncryptedVaultMetaRecord | undefined = undefined;
  readonly blobs = new Map<string, EncryptedWalletBlobRecord>();
  atomicCalls = 0;
  failNextAtomicWrite = false;
  onAtomicWriteStart: (() => Promise<void>) | undefined = undefined;

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
    this.atomicCalls++;
    if (this.onAtomicWriteStart) {
      await this.onAtomicWriteStart();
    }
    if (this.failNextAtomicWrite) {
      this.failNextAtomicWrite = false;
      throw new Error("Simulated IndexedDB quota error");
    }
    for (const b of blobs) {
      this.blobs.set(b.key, b);
    }
  }

  async deleteWalletBlobs(walletId: string): Promise<void> {
    this.blobs.delete(`${walletId}:keys`);
    this.blobs.delete(`${walletId}:cache`);
  }

  async clearAll(): Promise<void> {
    this.meta = undefined;
    this.blobs.clear();
  }
}

describe("WalletEngine M1.4 post-relay persistence barrier & deferred lock safety", () => {
  it("emits savingState=true (post-relay) immediately on relay, commits keys+cache atomically, defers concurrent lock until durable, and supports retryPersist on IDB failure", async () => {
    const store = new BarrierMemoryStore();
    const snapshots: WalletSnapshot[] = [];
    const busyEvents: boolean[] = [];

    const engine = new WalletEngine({
      store,
      hostKind: "firefox-event-page",
      proxyToWorker: false,
      enableBackgroundSync: false,
      validateAddressFn: async (addr) => {
        if (addr !== VALID_MAINNET_ADDR_A && addr !== VALID_MAINNET_ADDR_B) {
          throw new Error("Invalid address");
        }
      },
      onSnapshot: (s) => snapshots.push(s),
      onSyncBusyChange: (b) => busyEvents.push(b)
    });

    const mockTxWallet = new MockTxFlowWallet();
    let getDataCalls = 0;
    let closeCalls = 0;
    let refreshPoolCalls = 0;

    const fakeZephyrWallet = {
      isViewOnly: () => mockTxWallet.isViewOnly(),
      getPrimaryAddress: () => mockTxWallet.getPrimaryAddress(),
      prepareTransfer: (c: ZephyrTransferConfig) => mockTxWallet.prepareTransfer(c),
      prepareSweepUnlocked: (c: ZephyrSweepUnlockedConfig) => mockTxWallet.prepareSweepUnlocked(c),
      prepareConversion: (c: ZephyrConversionConfig) => mockTxWallet.prepareConversion(c),
      relayPrepared: (t: string) => mockTxWallet.relayPrepared(t),
      discardPrepared: (t: string) => mockTxWallet.discardPrepared(t),
      setDaemonConnection: async () => {},
      getHeight: async () => 913_600,
      getDaemonHeight: async () => 913_600,
      sync: async () => ({ numBlocksFetched: 0, receivedMoney: false }),
      refreshPool: async () => {
        refreshPoolCalls++;
        return 1;
      },
      getBalance: async () => new Map([["ZPH", 95_000_000_000_000n]]),
      getUnlockedBalance: async () => new Map([["ZPH", 95_000_000_000_000n]]),
      getData: async () => {
        getDataCalls++;
        return {
          keys: new Uint8Array([1, 2, 3, 4, 5]),
          cache: new Uint8Array([6, 7, 8, 9, 10])
        };
      },
      isClosed: () => closeCalls > 0,
      close: async () => {
        closeCalls++;
      },
      proxied: false,
      terminate: async () => {}
    } as unknown as ZephyrWallet;

    const { dekKey } = await generateDek();
    const entry: WalletManifestEntry = {
      id: "w-m14-test",
      name: "M1.4 Barrier Wallet",
      network: "mainnet",
      restoreHeight: 913_000,
      restoreHeightSource: "daemon",
      createdAt: "2026-11-23T00:00:00.000Z",
      viewOnly: false,
      seedBackupVerified: true,
      corePassword: generateCorePassword(),
      primaryAddress: VALID_MAINNET_ADDR_A
    };

    engine.attachTestWalletSession({
      wallet: fakeZephyrWallet,
      entry,
      dekKey,
      balances: [
        {
          asset: "ZPH",
          total: "100000000000000",
          unlocked: "100000000000000",
          locked: "0"
        },
        { asset: "ZSD", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZRS", total: "0", unlocked: "0", locked: "0" },
        { asset: "ZYS", total: "0", unlocked: "0", locked: "0" }
      ],
      reserve: makeHealthyReserve(913_600),
      daemonHeight: 913_600
    });

    // 1. Prepare transfer & verify snapshot carries pendingTx
    const prepared = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: VALID_MAINNET_ADDR_B, amount: "2.5" }]
    });
    expect(prepared.token).toMatch(/^[0-9a-f]{32}$/);

    // 2. Simulate a failure on the first post-relay atomic IDB write
    store.failNextAtomicWrite = true;
    const unsavedOutcome = await engine.relayPrepared(prepared.token);
    expect(unsavedOutcome.kind).toBe("relayed-unsaved");
    const snapAfterFailure = await engine.getSnapshot();
    expect(snapAfterFailure.persistFailure).not.toBeNull();
    expect(snapAfterFailure.persistFailure?.txHashes).toEqual([TX_HASH_1]);
    expect(engine.isSavingOrRelayCritical()).toBe(true);

    // If IDB fails again during lockWallet(), lockWallet() refuses to destroy unsaved post-relay state
    store.failNextAtomicWrite = true;
    await expect(engine.lockWallet()).rejects.toBeInstanceOf(TxFlowError);
    expect(closeCalls).toBe(0);

    // Explicit retryPersist() commits keys + cache atomically and clears persistFailure
    const retriedSnap = await engine.retryPersist();
    expect(retriedSnap.persistFailure).toBeNull();
    expect(retriedSnap.savingState).toBe(false);
    expect(store.blobs.has("w-m14-test:keys")).toBe(true);
    expect(store.blobs.has("w-m14-test:cache")).toBe(true);

    // 3. Prepare a second transfer and verify savingState=true barrier + deferred concurrent lock
    const prepared2 = await engine.prepareTransfer({
      asset: "ZPH",
      destinations: [{ address: VALID_MAINNET_ADDR_B, amount: "1.0" }]
    });

    let unlockWriteGate!: () => void;
    const writeGatePromise = new Promise<void>((resolve) => {
      unlockWriteGate = resolve;
    });
    let writeStartedResolve!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStartedResolve = resolve;
    });

    store.onAtomicWriteStart = async () => {
      writeStartedResolve();
      await writeGatePromise;
    };

    const relayPromise = engine.relayPrepared(prepared2.token);
    await writeStartedPromise;

    // While atomic IDB write is in progress, snapshot has savingState=true, savingKind="post-relay"
    const latestSavingSnap = snapshots[snapshots.length - 1];
    expect(latestSavingSnap?.savingState).toBe(true);
    expect(latestSavingSnap?.savingKind).toBe("post-relay");
    expect(engine.isSavingOrRelayCritical()).toBe(true);
    expect(busyEvents).toContain(true);

    // Request lockWallet() while post-relay save is still in flight -> must defer until write finishes
    let lockResolved = false;
    const lockPromise = engine.lockWallet().then((s) => {
      lockResolved = true;
      return s;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(lockResolved).toBe(false);
    expect(closeCalls).toBe(0);

    // Release the IDB write gate -> relay resolves first, then deferred lock completes cleanly
    store.onAtomicWriteStart = undefined;
    unlockWriteGate();

    const relayRes = await relayPromise;
    expect(relayRes.kind).toBe("relayed");
    const lockedSnap = await lockPromise;
    expect(lockResolved).toBe(true);
    expect(lockedSnap.locked).toBe(true);
    expect(lockedSnap.savingState).toBe(false);
    expect(closeCalls).toBe(1);
    expect(getDataCalls).toBeGreaterThanOrEqual(3);
  });
});
