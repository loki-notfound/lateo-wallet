import { ATOMIC_DECIMALS, ATOMIC_UNIT, isV2Asset, type ZephyrV2Asset } from "../assets/index.js";
import type {
  ConversionAvailabilityDto,
  OraclePricesDto,
  ReserveStatusDto,
  TxPriorityDto
} from "../rpc/protocol.js";

/** Maximum fractional digits the protocol accepts for a conversion amount. */
export const CONVERSION_MAX_DECIMALS = 4;
/** Conversion amounts must be a multiple of 10^8 atomic units (four decimals). */
export const CONVERSION_ATOMIC_STEP = 100_000_000n;
/** A conversion pricing record stays usable for this many blocks above its height. */
export const PRICING_RECORD_VALIDITY_BLOCKS = 10;
/** Most destinations a single transfer accepts. */
export const MAX_TRANSFER_DESTINATIONS = 15;
/** Wall-clock lifetime of a prepared (not yet relayed) transaction. */
export const PREPARED_TX_TTL_MS = 5 * 60_000;

export const TX_PRIORITIES: readonly {
  readonly value: TxPriorityDto;
  readonly label: string;
}[] = Object.freeze([
  { value: "default", label: "Automatic" },
  { value: "unimportant", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "elevated", label: "High" }
]);

export function isTxPriority(value: unknown): value is TxPriorityDto {
  return TX_PRIORITIES.some((p) => p.value === value);
}

export interface ConversionPairDescriptor {
  readonly source: ZephyrV2Asset;
  readonly destination: ZephyrV2Asset;
  readonly id: string;
  readonly label: string;
  readonly action: string;
  readonly availabilityKey: keyof ConversionAvailabilityDto;
}

/** The six V2 conversion pairs, in display order. */
export const CONVERSION_PAIRS: readonly ConversionPairDescriptor[] = Object.freeze([
  {
    source: "ZPH",
    destination: "ZSD",
    id: "ZPH-ZSD",
    label: "ZPH → ZSD",
    action: "Mint ZSD",
    availabilityKey: "mintZsd"
  },
  {
    source: "ZSD",
    destination: "ZPH",
    id: "ZSD-ZPH",
    label: "ZSD → ZPH",
    action: "Redeem ZSD",
    availabilityKey: "redeemZsd"
  },
  {
    source: "ZPH",
    destination: "ZRS",
    id: "ZPH-ZRS",
    label: "ZPH → ZRS",
    action: "Mint ZRS",
    availabilityKey: "mintZrs"
  },
  {
    source: "ZRS",
    destination: "ZPH",
    id: "ZRS-ZPH",
    label: "ZRS → ZPH",
    action: "Redeem ZRS",
    availabilityKey: "redeemZrs"
  },
  {
    source: "ZSD",
    destination: "ZYS",
    id: "ZSD-ZYS",
    label: "ZSD → ZYS",
    action: "Mint ZYS",
    availabilityKey: "mintZys"
  },
  {
    source: "ZYS",
    destination: "ZSD",
    id: "ZYS-ZSD",
    label: "ZYS → ZSD",
    action: "Redeem ZYS",
    availabilityKey: "redeemZys"
  }
]);

export function findConversionPair(
  source: string,
  destination: string
): ConversionPairDescriptor | null {
  return CONVERSION_PAIRS.find((p) => p.source === source && p.destination === destination) ?? null;
}

export type AmountValidation =
  | { readonly ok: true; readonly atomic: bigint }
  | { readonly ok: false; readonly error: string };

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

function validateDecimal(input: string, maxDecimals: number, label: string): AmountValidation {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (trimmed.length === 0) {
    return { ok: false, error: `${label} is required` };
  }
  if (trimmed.length > 40) {
    return { ok: false, error: `${label} is too long` };
  }
  const m = DECIMAL_RE.exec(trimmed);
  if (!m) {
    return { ok: false, error: `${label} must be a plain decimal number (for example 1.25)` };
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > maxDecimals) {
    return {
      ok: false,
      error: `${label} allows at most ${maxDecimals} decimal places`
    };
  }
  const atomic = BigInt(whole) * ATOMIC_UNIT + BigInt(frac.padEnd(ATOMIC_DECIMALS, "0") || "0");
  if (atomic <= 0n) {
    return { ok: false, error: `${label} must be greater than zero` };
  }
  // u64 upper bound for a single output amount
  if (atomic > 18_446_744_073_709_551_615n) {
    return { ok: false, error: `${label} is out of range` };
  }
  return { ok: true, atomic };
}

/** Exact 12-decimal BigInt validation for same-asset transfers. */
export function validateTransferAmount(input: string): AmountValidation {
  return validateDecimal(input, ATOMIC_DECIMALS, "Amount");
}

/** Strict maximum-4-decimal validation for conversions (multiple of 10^8 atomic units). */
export function validateConversionAmount(input: string): AmountValidation {
  const res = validateDecimal(input, CONVERSION_MAX_DECIMALS, "Conversion amount");
  if (res.ok && res.atomic % CONVERSION_ATOMIC_STEP !== 0n) {
    return { ok: false, error: "Conversion amount allows at most 4 decimal places" };
  }
  return res;
}

const ADDRESS_SHAPE_RE = /^ZEPH[1-9A-HJ-NP-Za-km-z]{90,130}$/;

/**
 * Cheap client-side shape pre-check (Base58, `ZEPH` prefix). The engine always
 * performs the authoritative network/checksum validation before preparing.
 */
export function looksLikeZephyrAddress(input: string): boolean {
  return ADDRESS_SHAPE_RE.test(input.trim());
}

export interface ConversionGate {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly openPairs: readonly string[];
  readonly blockedPairs: readonly string[];
}

/** Gate a conversion pair on the live reserve status (null reserve = unknown, blocked). */
export function evaluateConversionGate(
  reserve: ReserveStatusDto | null,
  source: string,
  destination: string
): ConversionGate {
  const pair = findConversionPair(source, destination);
  if (!reserve) {
    return {
      allowed: false,
      reason: "Reserve ratio not loaded yet — refresh the reserve status before converting.",
      openPairs: [],
      blockedPairs: CONVERSION_PAIRS.map((p) => p.label)
    };
  }
  const openPairs = CONVERSION_PAIRS.filter((p) => reserve.conversions[p.availabilityKey]).map(
    (p) => p.label
  );
  const blockedPairs = CONVERSION_PAIRS.filter(
    (p) => !reserve.conversions[p.availabilityKey]
  ).map((p) => p.label);
  if (!pair) {
    return {
      allowed: false,
      reason: `${source} → ${destination} is not a supported V2 conversion pair.`,
      openPairs,
      blockedPairs
    };
  }
  if (!reserve.conversions[pair.availabilityKey]) {
    const openText = openPairs.length > 0 ? openPairs.join(", ") : "none";
    return {
      allowed: false,
      reason: `${pair.action} (${pair.label}) is blocked by the reserve ratio: ${reserve.statusSummary} Open pairs: ${openText}.`,
      openPairs,
      blockedPairs
    };
  }
  return { allowed: true, reason: null, openPairs, blockedPairs };
}

export interface PricingRecordStatus {
  readonly ageBlocks: number;
  readonly blocksRemaining: number;
  readonly expired: boolean;
  readonly expiresAtHeight: number;
}

/**
 * Countdown for a conversion pricing record against the monotonic daemon height.
 * The record is treated as stale once it is PRICING_RECORD_VALIDITY_BLOCKS old.
 */
export function pricingRecordStatus(
  pricingRecordHeight: number,
  daemonHeight: number
): PricingRecordStatus {
  const age = Math.max(0, daemonHeight - pricingRecordHeight);
  const remaining = Math.max(0, PRICING_RECORD_VALIDITY_BLOCKS - age);
  return {
    ageBlocks: age,
    blocksRemaining: remaining,
    expired: remaining <= 0,
    expiresAtHeight: pricingRecordHeight + PRICING_RECORD_VALIDITY_BLOCKS
  };
}

const PRICE_SCALE = 10_000n; // oracle prices are formatted with 4 decimals

function parsePrice4(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!m) return null;
  const value = BigInt(m[1] ?? "0") * PRICE_SCALE + BigInt((m[2] ?? "").padEnd(4, "0"));
  return value > 0n ? value : null;
}

/**
 * Indicative output of a conversion from the cached oracle spot prices (before
 * fees and protocol spread). The exact minted amount comes from the prepared
 * transaction on the review screen.
 */
export function estimateConversionOutput(
  prices: OraclePricesDto | null,
  source: string,
  destination: string,
  amountAtomic: bigint
): bigint | null {
  if (!prices || amountAtomic <= 0n || !isV2Asset(source) || !isV2Asset(destination)) return null;
  const zsd = parsePrice4(prices.zsdSpot); // ZPH per ZSD
  const zrs = parsePrice4(prices.zrsSpot); // ZPH per ZRS
  const zys = parsePrice4(prices.zysPrice); // ZSD per ZYS
  const pair = `${source}-${destination}`;
  switch (pair) {
    case "ZPH-ZSD":
      return zsd ? (amountAtomic * PRICE_SCALE) / zsd : null;
    case "ZSD-ZPH":
      return zsd ? (amountAtomic * zsd) / PRICE_SCALE : null;
    case "ZPH-ZRS":
      return zrs ? (amountAtomic * PRICE_SCALE) / zrs : null;
    case "ZRS-ZPH":
      return zrs ? (amountAtomic * zrs) / PRICE_SCALE : null;
    case "ZSD-ZYS":
      return zys ? (amountAtomic * PRICE_SCALE) / zys : null;
    case "ZYS-ZSD":
      return zys ? (amountAtomic * zys) / PRICE_SCALE : null;
    default:
      return null;
  }
}
