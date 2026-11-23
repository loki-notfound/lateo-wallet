import { describe, expect, it } from "vitest";
import {
  ATOMIC_UNIT,
  describeAsset,
  formatAtomicParts,
  isV2Asset,
  parseAtomicAmount
} from "./index.js";

describe("assets and 12-decimal formatting", () => {
  it("accepts only V2 asset codes in allowlist", () => {
    expect(isV2Asset("ZPH")).toBe(true);
    expect(isV2Asset("ZSD")).toBe(true);
    expect(isV2Asset("ZRS")).toBe(true);
    expect(isV2Asset("ZYS")).toBe(true);
    expect(isV2Asset("ZEPH")).toBe(false);
    expect(isV2Asset("<script>")).toBe(false);
  });

  it("returns safe fallback metadata for unknown or control-char asset strings", () => {
    const unknown = describeAsset("ZEPH\u0000\u001b");
    expect(unknown.known).toBe(false);
    expect(unknown.code).toBe("ZEPH");
    expect(unknown.cssClass).toBe("");
  });

  it("formats and parses 12-decimal BigInt amounts without precision loss", () => {
    const big = 9007199254740993n * ATOMIC_UNIT + 428190000n;
    const parts = formatAtomicParts(big, 4);
    expect(parts.whole).toBe("9007199254740993");
    expect(parts.fracPrimary).toBe("0004");
    expect(parts.fracTail).toBe("28190000");
    expect(parts.full).toBe("9007199254740993.000428190000");
    expect(parseAtomicAmount(parts.full)).toBe(big);
  });

  it("rejects malformed decimal strings", () => {
    expect(() => parseAtomicAmount("-1")).toThrow(RangeError);
    expect(() => parseAtomicAmount("1.0000000000001")).toThrow(RangeError);
    expect(() => parseAtomicAmount("abc")).toThrow(RangeError);
  });
});
