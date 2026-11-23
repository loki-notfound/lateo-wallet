export const ATOMIC_DECIMALS = 12;
export const ATOMIC_UNIT = 1_000_000_000_000n;

export const V2_ASSET_CODES = ["ZPH", "ZSD", "ZRS", "ZYS"] as const;
export type ZephyrV2Asset = (typeof V2_ASSET_CODES)[number];

export interface AssetDescriptor {
  readonly code: ZephyrV2Asset;
  readonly name: string;
  readonly cssClass: string;
  readonly tokenVar: string;
}

export const ASSET_ALLOWLIST: Readonly<Record<ZephyrV2Asset, AssetDescriptor>> = Object.freeze({
  ZPH: Object.freeze({
    code: "ZPH",
    name: "Zephyr",
    cssClass: "lt-asset-zeph",
    tokenVar: "--lt-asset-zeph"
  }),
  ZSD: Object.freeze({
    code: "ZSD",
    name: "Zephyr Stable Dollar",
    cssClass: "lt-asset-zsd",
    tokenVar: "--lt-asset-zsd"
  }),
  ZRS: Object.freeze({
    code: "ZRS",
    name: "Zephyr Reserve Share",
    cssClass: "lt-asset-zrs",
    tokenVar: "--lt-asset-zrs"
  }),
  ZYS: Object.freeze({
    code: "ZYS",
    name: "Zephyr Yield Share",
    cssClass: "lt-asset-zys",
    tokenVar: "--lt-asset-zys"
  })
});

export function isV2Asset(code: string): code is ZephyrV2Asset {
  return Object.prototype.hasOwnProperty.call(ASSET_ALLOWLIST, code);
}

/**
 * Resolve a protocol asset code through the explicit V2 allowlist.
 * Unknown or legacy strings are never interpreted as HTML and receive a safe label.
 */
export function describeAsset(rawCode: string): {
  readonly known: boolean;
  readonly code: string;
  readonly name: string;
  readonly cssClass: string;
} {
  if (isV2Asset(rawCode)) {
    const d = ASSET_ALLOWLIST[rawCode];
    return { known: true, code: d.code, name: d.name, cssClass: d.cssClass };
  }
  const safeCode = rawCode.replace(/[^\x20-\x7E]/g, "").slice(0, 16) || "UNKNOWN";
  return { known: false, code: safeCode, name: "Unknown asset", cssClass: "" };
}

/**
 * Format atomic BigInt units (10^-12) into exact decimal parts without floating-point loss.
 */
export function formatAtomicParts(
  atomic: bigint,
  primaryDecimals = 4
): {
  readonly negative: boolean;
  readonly whole: string;
  readonly fracPrimary: string;
  readonly fracTail: string;
  readonly full: string;
} {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = (abs / ATOMIC_UNIT).toString();
  const fracFull = (abs % ATOMIC_UNIT).toString().padStart(ATOMIC_DECIMALS, "0");
  const clamped = Math.max(0, Math.min(ATOMIC_DECIMALS, primaryDecimals));
  const fracPrimary = fracFull.slice(0, clamped);
  const fracTail = fracFull.slice(clamped);
  const full = `${negative ? "-" : ""}${whole}.${fracFull}`;
  return { negative, whole, fracPrimary, fracTail, full };
}

/**
 * Parse a non-negative decimal string (up to 12 fractional digits) into atomic BigInt units.
 */
export function parseAtomicAmount(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,12})?$/.test(trimmed)) {
    throw new RangeError("Invalid decimal amount");
  }
  const [wholePart = "0", fracPart = ""] = trimmed.split(".");
  const paddedFrac = fracPart.padEnd(ATOMIC_DECIMALS, "0");
  return BigInt(wholePart) * ATOMIC_UNIT + BigInt(paddedFrac);
}
