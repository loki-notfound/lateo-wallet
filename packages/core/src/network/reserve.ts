import {
  ZephyrDaemonRpc,
  type ZephyrBlockHeader,
  type ZephyrPricingRecord,
  type ZephyrReserveInfo,
  type ZephyrWallet
} from "@loki-notfound/zephyr-ts";
import { formatAtomicParts } from "../assets/index.js";
import type {
  ConversionAvailabilityDto,
  OraclePricesDto,
  ReserveHealthState,
  ReserveStatusDto
} from "../rpc/protocol.js";
import { retryWithBackoff, type RetryOptions } from "./backoff.js";

const MIN_RATIO_ZSD_MINT = 4.0;
const MAX_RATIO_ZRS_MINT = 8.0;
const WARNING_BUFFER = 0.5;
const MIN_ZSD_FOR_ZRS_CAP = 100n * 1_000_000_000_000n;

function formatPrice4(atomic: bigint): string {
  const parts = formatAtomicParts(atomic, 4);
  return `${parts.negative ? "-" : ""}${parts.whole}.${parts.fracPrimary}`;
}

export function deriveConversionAvailability(
  reserveRatioSpot: number,
  reserveRatioMa: number,
  numStables: bigint,
  zephReserve: bigint
): {
  readonly health: ReserveHealthState;
  readonly conversions: ConversionAvailabilityDto;
  readonly statusSummary: string;
} {
  const ratiosValid =
    Number.isFinite(reserveRatioSpot) &&
    Number.isFinite(reserveRatioMa) &&
    reserveRatioSpot >= 0 &&
    reserveRatioMa >= 0;
  const safeSpot = ratiosValid ? reserveRatioSpot : 0;
  const safeMa = ratiosValid ? reserveRatioMa : 0;
  const effectiveLow = Math.min(safeSpot, safeMa);
  const effectiveHigh = Math.max(safeSpot, safeMa);

  const mintZsd = ratiosValid && effectiveLow >= MIN_RATIO_ZSD_MINT;
  const redeemZsd = zephReserve > 0n;
  const zrsCapActive = numStables >= MIN_ZSD_FOR_ZRS_CAP;
  const mintZrs = ratiosValid && (!zrsCapActive || effectiveHigh < MAX_RATIO_ZRS_MINT);
  const redeemZrs = ratiosValid && effectiveLow >= MIN_RATIO_ZSD_MINT;
  const mintZys = true;
  const redeemZys = true;

  let health: ReserveHealthState;
  let statusSummary: string;

  if (!ratiosValid) {
    health = "critical";
    statusSummary =
      "Reserve ratio data is invalid — ZSD minting, ZRS minting, and ZRS redeeming are paused until a valid reading is received.";
  } else if (!mintZsd) {
    health = "critical";
    statusSummary =
      "Reserve ratio below 4.0x — ZSD minting and ZRS redeeming are paused; ZRS minting, ZSD redeeming, and ZYS conversions remain open.";
  } else if (
    effectiveLow < MIN_RATIO_ZSD_MINT + WARNING_BUFFER ||
    (zrsCapActive && effectiveHigh >= MAX_RATIO_ZRS_MINT - WARNING_BUFFER)
  ) {
    health = "warning";
    statusSummary = !mintZrs
      ? "Reserve ratio above 8.0x — ZRS minting is capped; ZSD mint/redeem, ZRS redeem, and ZYS conversions are open."
      : "Reserve ratio near protocol boundary — spot and moving-average spread may restrict conversions.";
  } else {
    health = "healthy";
    statusSummary = "Reserve ratio healthy — all Zephyr protocol conversions are available.";
  }

  return {
    health,
    conversions: { mintZsd, redeemZsd, mintZrs, redeemZrs, mintZys, redeemZys },
    statusSummary
  };
}

function mapOraclePrices(pr: ZephyrPricingRecord | undefined): OraclePricesDto | null {
  if (!pr) return null;
  return {
    zphUsdSpot: formatPrice4(pr.spot),
    zphUsdMa: formatPrice4(pr.movingAverage),
    zsdSpot: formatPrice4(pr.stable),
    zsdMa: formatPrice4(pr.stableMa),
    zrsSpot: formatPrice4(pr.reserve),
    zrsMa: formatPrice4(pr.reserveMa),
    zysPrice: formatPrice4(pr.yieldPrice),
    timestamp: Number(pr.timestamp)
  };
}

export interface ReserveFetcher {
  getReserveInfo(): Promise<ZephyrReserveInfo>;
  getLastBlockHeader(): Promise<ZephyrBlockHeader>;
}

export class ReserveService {
  private lastKnownHeight = 0;
  private lastStatus: ReserveStatusDto | null = null;
  private readonly retryOptions: RetryOptions;

  constructor(retryOptions: RetryOptions = {}) {
    this.retryOptions = {
      maxAttempts: 3,
      baseDelayMs: 400,
      maxDelayMs: 3_000,
      ...retryOptions
    };
  }

  resetForNodeSwitch(): void {
    this.lastKnownHeight = 0;
    this.lastStatus = null;
  }

  getCached(): ReserveStatusDto | null {
    return this.lastStatus;
  }

  seedCachedForTest(status: ReserveStatusDto | null): void {
    this.lastStatus = status;
    this.lastKnownHeight = status?.height ?? 0;
  }

  async refreshFromWalletAndNode(
    wallet: ZephyrWallet,
    nodeUrl: string
  ): Promise<ReserveStatusDto> {
    const rpc = new ZephyrDaemonRpc(nodeUrl);
    return this.refreshWithFetcher({
      getReserveInfo: () => wallet.getReserveInfo(),
      getLastBlockHeader: () => rpc.getLastBlockHeader()
    });
  }

  async refreshWithFetcher(fetcher: ReserveFetcher): Promise<ReserveStatusDto> {
    const [reserve, header] = await Promise.all([
      retryWithBackoff(() => fetcher.getReserveInfo(), this.retryOptions),
      retryWithBackoff(() => fetcher.getLastBlockHeader(), this.retryOptions)
    ]);

    const spotRatio = Number(reserve.reserveRatio);
    const maRatio = Number(reserve.reserveRatioMa);

    // Monotonic height guard against 1-2 block HA replica lag
    const headerHeight =
      Number.isSafeInteger(header.height) && header.height >= 0 ? header.height : 0;
    const monotonicHeight = Math.max(this.lastKnownHeight, headerHeight);
    this.lastKnownHeight = monotonicHeight;

    const { health, conversions, statusSummary } = deriveConversionAvailability(
      spotRatio,
      maRatio,
      reserve.numStables,
      reserve.zephReserve
    );

    const status: ReserveStatusDto = {
      height: monotonicHeight,
      hfVersion: reserve.hfVersion,
      reserveRatio: reserve.reserveRatio,
      reserveRatioMa: reserve.reserveRatioMa,
      health,
      conversions,
      statusSummary,
      prices: mapOraclePrices(header.pricingRecord),
      updatedAt: Date.now()
    };

    this.lastStatus = status;
    return status;
  }
}
