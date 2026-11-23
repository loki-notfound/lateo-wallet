import { describe, expect, it } from "vitest";
import { ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import { ReserveService, deriveConversionAvailability } from "./reserve.js";

describe("ReserveService & protocol conversion gating", () => {
  it("classifies healthy, warning, and critical reserve ratios accurately", () => {
    const critical = deriveConversionAvailability(2.1, 1.95, 500_000_000_000_000n, 1_000_000n);
    expect(critical.health).toBe("critical");
    expect(critical.conversions.mintZsd).toBe(false);
    expect(critical.conversions.redeemZrs).toBe(false);
    expect(critical.conversions.mintZrs).toBe(true);
    expect(critical.conversions.redeemZsd).toBe(true);
    expect(critical.conversions.mintZys).toBe(true);

    const healthy = deriveConversionAvailability(5.5, 5.2, 500_000_000_000_000n, 1_000_000n);
    expect(healthy.health).toBe("healthy");
    expect(healthy.conversions.mintZsd).toBe(true);
    expect(healthy.conversions.mintZrs).toBe(true);
    expect(healthy.conversions.redeemZrs).toBe(true);

    const capped = deriveConversionAvailability(8.4, 8.1, 500_000_000_000_000n, 1_000_000n);
    expect(capped.health).toBe("warning");
    expect(capped.conversions.mintZrs).toBe(false);
    expect(capped.conversions.mintZsd).toBe(true);
  });

  it("retries transient daemon failures and keeps monotonic block height", async () => {
    let attempts = 0;
    let headerHeight = 910_005;
    const service = new ReserveService({
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      sleep: async () => {}
    });

    const fetcher = {
      getReserveInfo: async () => {
        attempts++;
        if (attempts === 1) {
          throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_BUSY");
        }
        return {
          zephReserve: 10_000_000_000_000_000n,
          numStables: 2_000_000_000_000_000n,
          numReserves: 1_000_000_000_000_000n,
          assets: 12_000_000_000_000_000n,
          assetsMa: 0n,
          liabilities: 2_000_000_000_000_000n,
          equity: 10_000_000_000_000_000n,
          equityMa: 0n,
          reserveRatio: "6.0",
          reserveRatioMa: "5.8",
          hfVersion: 11,
          zyieldCirc: 500_000_000_000_000n,
          zyieldRsv: 600_000_000_000_000n
        };
      },
      getLastBlockHeader: async () => ({
        hash: "0".repeat(64),
        height: headerHeight,
        timestamp: 1795300000,
        size: 1000,
        weight: 1000,
        longTermWeight: 1000,
        depth: 0,
        difficulty: 100n,
        cumulativeDifficulty: 1000n,
        majorVersion: 11,
        minorVersion: 11,
        nonce: 1,
        minerTxHash: "0".repeat(64),
        numTxs: 1,
        orphanStatus: false,
        prevHash: "0".repeat(64),
        reward: 1n,
        pricingRecord: {
          spot: 1_250_000_000_000n,
          movingAverage: 1_200_000_000_000n,
          stable: 800_000_000_000n,
          stableMa: 833_300_000_000n,
          reserve: 450_000_000_000n,
          reserveMa: 440_000_000_000n,
          reserveRatio: 6_000_000_000_000n,
          reserveRatioMa: 5_800_000_000_000n,
          yieldPrice: 1_120_000_000_000n,
          timestamp: 1795300000n,
          signature: "a".repeat(128)
        }
      })
    };

    const first = await service.refreshWithFetcher(fetcher);
    expect(attempts).toBe(2);
    expect(first.height).toBe(910_005);
    expect(first.health).toBe("healthy");
    expect(first.prices?.zphUsdSpot).toBe("1.2500");
    expect(first.prices?.zysPrice).toBe("1.1200");

    // Simulate lagging HA replica returning height -2 -> height stays monotonic
    headerHeight = 910_003;
    const second = await service.refreshWithFetcher(fetcher);
    expect(second.height).toBe(910_005);
  });

  it("enforces exact 4.0x / 8.0x boundaries, spot vs MA divergence, 100-ZSD cap, zero reserve, and non-finite guards", () => {
    const aboveCapZsd = 100n * 1_000_000_000_000n;
    const belowCapZsd = 99n * 1_000_000_000_000n;
    const reserve = 1_000_000_000_000n;

    // Exact 4.0 boundary is allowed; 3.9999 is blocked
    expect(deriveConversionAvailability(4.0, 4.0, aboveCapZsd, reserve).conversions).toMatchObject({
      mintZsd: true,
      redeemZrs: true,
      mintZrs: true
    });
    expect(deriveConversionAvailability(3.9999, 4.5, aboveCapZsd, reserve).conversions).toMatchObject({
      mintZsd: false,
      redeemZrs: false,
      mintZrs: true
    });
    // Opposite sides of 4.0 (spot high, MA low) must block via min(spot, ma)
    expect(deriveConversionAvailability(5.0, 3.9, aboveCapZsd, reserve).conversions).toMatchObject({
      mintZsd: false,
      redeemZrs: false
    });

    // Exact 8.0 boundary is capped when numStables >= 100 ZSD; 7.9999 is open
    expect(deriveConversionAvailability(8.0, 8.0, aboveCapZsd, reserve).conversions.mintZrs).toBe(false);
    expect(deriveConversionAvailability(7.9999, 7.9999, aboveCapZsd, reserve).conversions.mintZrs).toBe(true);
    // Opposite sides of 8.0 (spot < 8, MA >= 8) must cap via max(spot, ma)
    expect(deriveConversionAvailability(7.5, 8.0, aboveCapZsd, reserve).conversions.mintZrs).toBe(false);
    // Fewer than 100 ZSD in circulation lifts the 8.0x ZRS mint cap
    expect(deriveConversionAvailability(10.0, 10.0, belowCapZsd, reserve).conversions.mintZrs).toBe(true);

    // Zero ZEPH reserve blocks ZSD redemption
    expect(deriveConversionAvailability(5.0, 5.0, aboveCapZsd, 0n).conversions.redeemZsd).toBe(false);

    // Non-finite or negative ratios fail closed
    const nanState = deriveConversionAvailability(Number.NaN, 5.0, aboveCapZsd, reserve);
    expect(nanState.health).toBe("critical");
    expect(nanState.conversions).toMatchObject({
      mintZsd: false,
      mintZrs: false,
      redeemZrs: false
    });
    const infState = deriveConversionAvailability(Number.POSITIVE_INFINITY, 5.0, aboveCapZsd, reserve);
    expect(infState.health).toBe("critical");
    expect(infState.conversions.mintZsd).toBe(false);
    expect(infState.conversions.mintZrs).toBe(false);
  });
});
