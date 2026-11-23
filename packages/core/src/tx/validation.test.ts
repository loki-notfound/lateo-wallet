import { describe, expect, it } from "vitest";
import type { ReserveStatusDto } from "../rpc/protocol.js";
import {
  CONVERSION_PAIRS,
  PRICING_RECORD_VALIDITY_BLOCKS,
  estimateConversionOutput,
  evaluateConversionGate,
  findConversionPair,
  looksLikeZephyrAddress,
  pricingRecordStatus,
  validateConversionAmount,
  validateTransferAmount
} from "./validation.js";

function makeReserve(patch: Partial<ReserveStatusDto> = {}): ReserveStatusDto {
  return {
    height: 913_600,
    hfVersion: 11,
    reserveRatio: "5.25",
    reserveRatioMa: "5.10",
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
      zphUsdMa: "1.9500",
      zsdSpot: "0.5000",
      zsdMa: "0.5128",
      zrsSpot: "1.2500",
      zrsMa: "1.2000",
      zysPrice: "1.0500",
      timestamp: 1_700_000_000
    },
    updatedAt: 1_700_000_000_000,
    ...patch
  };
}

describe("M1.4 transaction and conversion validation", () => {
  it("parses exact 12-decimal transfer amounts and rejects invalid precision or zero", () => {
    const one = validateTransferAmount("1");
    expect(one).toEqual({ ok: true, atomic: 1_000_000_000_000n });

    const exact12 = validateTransferAmount("0.000000000001");
    expect(exact12).toEqual({ ok: true, atomic: 1n });

    expect(validateTransferAmount("0").ok).toBe(false);
    expect(validateTransferAmount("0.000000000000").ok).toBe(false);
    expect(validateTransferAmount("-1").ok).toBe(false);
    expect(validateTransferAmount("1.0000000000001")).toEqual({
      ok: false,
      error: "Amount allows at most 12 decimal places"
    });
    expect(validateTransferAmount("").ok).toBe(false);
    expect(validateTransferAmount("abc").ok).toBe(false);
  });

  it("enforces strict max-4-decimal validation on conversions (multiple of 10^8 atomic units)", () => {
    expect(validateConversionAmount("25")).toEqual({
      ok: true,
      atomic: 25_000_000_000_000n
    });
    expect(validateConversionAmount("1.2345")).toEqual({
      ok: true,
      atomic: 1_234_500_000_000n
    });
    expect(validateConversionAmount("0.0001")).toEqual({
      ok: true,
      atomic: 100_000_000n
    });

    const tooManyDecimals = validateConversionAmount("1.23456");
    expect(tooManyDecimals).toEqual({
      ok: false,
      error: "Conversion amount allows at most 4 decimal places"
    });
    expect(validateConversionAmount("0.00001").ok).toBe(false);
    expect(validateConversionAmount("0").ok).toBe(false);
  });

  it("defines all 6 V2 conversion pairs and gates them on live reserve status", () => {
    expect(CONVERSION_PAIRS.map((p) => p.id)).toEqual([
      "ZPH-ZSD",
      "ZSD-ZPH",
      "ZPH-ZRS",
      "ZRS-ZPH",
      "ZSD-ZYS",
      "ZYS-ZSD"
    ]);
    expect(findConversionPair("ZPH", "ZYS")).toBeNull();

    // Missing reserve blocks conversions until loaded
    const noReserveGate = evaluateConversionGate(null, "ZPH", "ZSD");
    expect(noReserveGate.allowed).toBe(false);
    expect(noReserveGate.reason).toContain("Reserve ratio not loaded");

    // Critical reserve (< 4.0x): ZPH->ZSD and ZRS->ZPH paused; other 4 pairs remain open
    const lowRatioReserve = makeReserve({
      reserveRatio: "1.98",
      reserveRatioMa: "1.99",
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
    });

    const blockedMintZsd = evaluateConversionGate(lowRatioReserve, "ZPH", "ZSD");
    expect(blockedMintZsd.allowed).toBe(false);
    expect(blockedMintZsd.reason).toContain("Mint ZSD (ZPH → ZSD) is blocked");
    expect(blockedMintZsd.openPairs).toEqual([
      "ZSD → ZPH",
      "ZPH → ZRS",
      "ZSD → ZYS",
      "ZYS → ZSD"
    ]);
    expect(blockedMintZsd.blockedPairs).toEqual(["ZPH → ZSD", "ZRS → ZPH"]);

    const blockedRedeemZrs = evaluateConversionGate(lowRatioReserve, "ZRS", "ZPH");
    expect(blockedRedeemZrs.allowed).toBe(false);

    const openRedeemZsd = evaluateConversionGate(lowRatioReserve, "ZSD", "ZPH");
    expect(openRedeemZsd.allowed).toBe(true);
    expect(openRedeemZsd.reason).toBeNull();

    const openMintZys = evaluateConversionGate(lowRatioReserve, "ZSD", "ZYS");
    expect(openMintZys.allowed).toBe(true);

    // High reserve (>= 8.0x): ZPH->ZRS capped; other 5 pairs remain open
    const highRatioReserve = makeReserve({
      reserveRatio: "8.40",
      reserveRatioMa: "8.15",
      health: "warning",
      conversions: {
        mintZsd: true,
        redeemZsd: true,
        mintZrs: false,
        redeemZrs: true,
        mintZys: true,
        redeemZys: true
      },
      statusSummary:
        "Reserve ratio above 8.0x — ZRS minting is capped; ZSD mint/redeem, ZRS redeem, and ZYS conversions are open."
    });
    const blockedMintZrs = evaluateConversionGate(highRatioReserve, "ZPH", "ZRS");
    expect(blockedMintZrs.allowed).toBe(false);
    expect(blockedMintZrs.blockedPairs).toEqual(["ZPH → ZRS"]);
    expect(blockedMintZrs.openPairs.length).toBe(5);
  });

  it("computes 10-block pricing record countdown and expiration accurately", () => {
    const fresh = pricingRecordStatus(913_500, 913_500);
    expect(fresh).toEqual({
      ageBlocks: 0,
      blocksRemaining: PRICING_RECORD_VALIDITY_BLOCKS,
      expired: false,
      expiresAtHeight: 913_510
    });

    const almostExpired = pricingRecordStatus(913_500, 913_509);
    expect(almostExpired.blocksRemaining).toBe(1);
    expect(almostExpired.expired).toBe(false);

    const expiredAt10 = pricingRecordStatus(913_500, 913_510);
    expect(expiredAt10.ageBlocks).toBe(10);
    expect(expiredAt10.blocksRemaining).toBe(0);
    expect(expiredAt10.expired).toBe(true);
  });

  it("estimates indicative conversion output across all 6 V2 pairs and checks address shape", () => {
    const reserve = makeReserve();
    const tenAtomic = 10_000_000_000_000n;

    // 10 ZPH at 0.5000 ZPH/ZSD -> 20 ZSD
    expect(estimateConversionOutput(reserve.prices, "ZPH", "ZSD", tenAtomic)).toBe(
      20_000_000_000_000n
    );
    // 10 ZSD at 0.5000 ZPH/ZSD -> 5 ZPH
    expect(estimateConversionOutput(reserve.prices, "ZSD", "ZPH", tenAtomic)).toBe(
      5_000_000_000_000n
    );
    // 10 ZPH at 1.2500 ZPH/ZRS -> 8 ZRS
    expect(estimateConversionOutput(reserve.prices, "ZPH", "ZRS", tenAtomic)).toBe(
      8_000_000_000_000n
    );
    // 10 ZRS at 1.2500 ZPH/ZRS -> 12.5 ZPH
    expect(estimateConversionOutput(reserve.prices, "ZRS", "ZPH", tenAtomic)).toBe(
      12_500_000_000_000n
    );
    // 10.5 ZSD at 1.0500 ZSD/ZYS -> 10 ZYS
    expect(
      estimateConversionOutput(reserve.prices, "ZSD", "ZYS", 10_500_000_000_000n)
    ).toBe(10_000_000_000_000n);
    // 10 ZYS at 1.0500 ZSD/ZYS -> 10.5 ZSD
    expect(estimateConversionOutput(reserve.prices, "ZYS", "ZSD", tenAtomic)).toBe(
      10_500_000_000_000n
    );

    expect(
      looksLikeZephyrAddress(
        "ZEPHYR3dc1432222222222222222222222222222222222222222222222222222222222222222222222222222222222222222"
      )
    ).toBe(true);
    expect(looksLikeZephyrAddress("not-an-address")).toBe(false);
  });
});
