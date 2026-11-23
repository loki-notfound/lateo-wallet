import type {
  ZephyrBuiltTx,
  ZephyrConversionConfig,
  ZephyrPreparedConversion,
  ZephyrPreparedSweep,
  ZephyrPreparedTransfer,
  ZephyrRelayResult,
  ZephyrSweepUnlockedConfig,
  ZephyrTransferConfig
} from "@loki-notfound/zephyr-ts";
import { isV2Asset } from "../assets/index.js";
import type {
  PreparedDestinationDto,
  PreparedTxDto,
  PreparedTxKind,
  PreparedTxPartDto,
  RelayOutcomeDto,
  ReserveStatusDto,
  TxFlowErrorCode,
  TxPriorityDto,
  ZephyrNetwork
} from "../rpc/protocol.js";
import {
  MAX_TRANSFER_DESTINATIONS,
  MAX_U64_ATOMIC,
  PREPARED_TX_TTL_MS,
  evaluateConversionGate,
  findConversionPair,
  isTxPriority,
  pricingRecordStatus,
  validateConversionAmount,
  validateTransferAmount
} from "../tx/validation.js";

/** Upstream voids a kept build after three relay calls. */
export const MAX_RELAY_ATTEMPTS = 3;
export const DEFAULT_RELAY_TIMEOUT_MS = 120_000;

export class TxFlowError extends Error {
  readonly code: TxFlowErrorCode;

  constructor(code: TxFlowErrorCode, message: string) {
    super(message);
    this.name = "TxFlowError";
    this.code = code;
  }
}

/** The subset of a full ZephyrWallet the two-step flow needs (mockable offline). */
export interface TxFlowWallet {
  isViewOnly(): Promise<boolean>;
  getPrimaryAddress(): Promise<string>;
  prepareTransfer(config: ZephyrTransferConfig): Promise<ZephyrPreparedTransfer>;
  prepareSweepUnlocked(config: ZephyrSweepUnlockedConfig): Promise<ZephyrPreparedSweep>;
  prepareConversion(config: ZephyrConversionConfig): Promise<ZephyrPreparedConversion>;
  relayPrepared(token: string): Promise<ZephyrRelayResult>;
  discardPrepared(token: string): Promise<boolean>;
}

export interface TxFlowOptions {
  readonly validateAddress: (address: string, network: ZephyrNetwork) => Promise<void>;
  /** Monotonic daemon height (HA replica drift safe). */
  readonly getDaemonHeight: () => number;
  /** Optional fresh daemon height probe invoked immediately before relaying a conversion. */
  readonly refreshDaemonHeight?: () => Promise<number | null>;
  readonly getReserve: () => ReserveStatusDto | null;
  readonly getNode: () => { readonly url: string; readonly host: string };
  readonly getUnlockedBalance: (asset: string) => bigint | null;
  /**
   * Mandatory post-relay persistence barrier: getData() -> encrypt -> atomic
   * IndexedDB commit. Must reject when the commit is not durable.
   */
  readonly persistAfterRelay: (txHashes: readonly string[]) => Promise<void>;
  /** Called when a relay that timed out locally is later accepted by the node. */
  readonly onLateRelayAccepted?: (txHashes: readonly string[]) => void;
  /** Called whenever a relay enters an ambiguous state so the engine can persist a marker. */
  readonly onRelayUnknown?: (info: {
    readonly txHashes: readonly string[];
    readonly nodeHost: string;
    readonly reason: string;
  }) => void | Promise<void>;
  /** Called when a retry after an uncertain attempt is rejected (e.g. DOUBLE_SPEND). */
  readonly onUncertainRejection?: (info: {
    readonly txHashes: readonly string[];
    readonly nodeHost: string;
    readonly reason: string;
  }) => void | Promise<void>;
  /** Called when a relay completes and is confirmed relayed cleanly. */
  readonly onRelayConfirmed?: () => void | Promise<void>;
  /** Pause/resume background sync while a build is prepared or relaying. */
  readonly onSyncPauseChange?: (paused: boolean) => void;
  /** Returns a reason when a new transaction must not be started (e.g. unsaved relay). */
  readonly blockNewTransaction?: () => string | null;
  readonly beforeRelay?: () => Promise<void>;
  readonly afterRelay?: () => void;
  readonly onChange?: () => void;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly ttlMs?: number;
  readonly relayTimeoutMs?: number;
}

interface PendingEntry {
  readonly token: string;
  readonly coreToken: string;
  readonly kind: PreparedTxKind;
  status: PreparedTxDto["status"];
  readonly sourceAsset: string;
  readonly destinationAsset: string;
  readonly destinations: readonly PreparedDestinationDto[];
  txs: PreparedTxPartDto[];
  readonly totalAmount: bigint;
  readonly totalFee: bigint;
  readonly totalDebited: bigint;
  readonly amountMinted: bigint | null;
  readonly pricingRecordHeight: number | null;
  readonly daemonHeightAtPrepare: number;
  readonly priority: TxPriorityDto;
  nodeUrl: string;
  nodeHost: string;
  readonly preparedAt: number;
  readonly expiresAt: number;
  relayAttempts: number;
  lastRelayError: string | null;
}

interface WalletErrorLike {
  readonly code: string;
  readonly diagnostic?: string | undefined;
}

function asWalletError(err: unknown): WalletErrorLike | null {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    const diag = "diagnostic" in err && typeof err.diagnostic === "string" ? err.diagnostic : undefined;
    return { code: err.code, diagnostic: diag };
  }
  return null;
}

function defaultRandomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const INSUFFICIENT_DIAGNOSTICS = new Set([
  "NOT_ENOUGH_UNLOCKED",
  "NOT_ENOUGH_MONEY",
  "NOT_ENOUGH_FOR_FEE"
]);
const ADDRESS_DIAGNOSTICS = new Set([
  "ADDRESS_NETWORK",
  "INTEGRATED_ADDRESS",
  "CORE_INVALID_ADDRESS",
  "ADDRESS_TYPE"
]);
const AMOUNT_DIAGNOSTICS = new Set([
  "AMOUNT_ZERO",
  "AMOUNT_RANGE",
  "AMOUNT_PRECISION",
  "CONVERSION_AMOUNT"
]);

/** Map a build-time SDK rejection to a stable, secret-free engine error. */
export function mapBuildError(err: unknown): TxFlowError {
  if (err instanceof TxFlowError) return err;
  const we = asWalletError(err);
  const diag = we?.diagnostic ?? "";
  if (INSUFFICIENT_DIAGNOSTICS.has(diag)) {
    return new TxFlowError(
      "INSUFFICIENT_FUNDS",
      diag === "NOT_ENOUGH_FOR_FEE"
        ? "Not enough unlocked balance to cover the network fee"
        : "Not enough unlocked balance for this transaction"
    );
  }
  if (we?.code === "INVALID_ADDRESS" || ADDRESS_DIAGNOSTICS.has(diag)) {
    return new TxFlowError("INVALID_ADDRESS", "Destination address is not valid for this network");
  }
  if (AMOUNT_DIAGNOSTICS.has(diag)) {
    return new TxFlowError("INVALID_AMOUNT", "Amount is not accepted by the protocol");
  }
  if (diag === "RESERVE_RATIO") {
    return new TxFlowError(
      "RESERVE_BLOCKED",
      "The reserve ratio does not currently allow this conversion pair"
    );
  }
  if (diag === "VIEW_ONLY_TX" || diag === "KEYS_ONLY_TX") {
    return new TxFlowError("VIEW_ONLY", "View-only wallets cannot sign or send transactions");
  }
  if (diag === "TOO_MANY_DESTINATIONS" || diag === "DESTINATIONS") {
    return new TxFlowError("INVALID_DESTINATIONS", "Too many or invalid destinations");
  }
  if (diag === "PRICING_RECORD" || diag === "PRICING_RECORD_UNAVAILABLE") {
    return new TxFlowError(
      "BUILD_FAILED",
      "Pricing record unavailable — sync the wallet and prepare again"
    );
  }
  if (diag === "NOT_ENOUGH_OUTS_TO_MIX") {
    return new TxFlowError("BUILD_FAILED", "Not enough decoy outputs available on this node");
  }
  if (diag === "TX_TOO_LARGE") {
    return new TxFlowError("BUILD_FAILED", "Transaction too large — send a smaller amount");
  }
  if (we?.code === "DAEMON_ERROR") {
    return new TxFlowError("BUILD_FAILED", "Node unavailable while building the transaction");
  }
  return new TxFlowError("BUILD_FAILED", "The transaction could not be built");
}

const REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  DOUBLE_SPEND: "The node rejected the transaction: inputs already spent (sync the wallet)",
  FEE_TOO_LOW: "The node rejected the transaction: fee too low",
  LOW_RING_SIZE: "The node rejected the transaction: ring size too low",
  TOO_BIG: "The node rejected the transaction: too large",
  OVERSPEND: "The node rejected the transaction: overspend",
  INVALID_INPUT: "The node rejected the transaction: invalid input",
  INVALID_OUTPUT: "The node rejected the transaction: invalid output",
  NOT_RELAYED: "The node kept the transaction without relaying it"
};

export class TxFlowController {
  private readonly opts: TxFlowOptions;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly ttlMs: number;
  private readonly relayTimeoutMs: number;

  private wallet: TxFlowWallet | null = null;
  private network: ZephyrNetwork = "mainnet";
  private viewOnly = false;
  private pending: PendingEntry | null = null;
  private relayInFlight = false;
  private lateRelaysInFlight = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(options: TxFlowOptions) {
    this.opts = options;
    this.now = options.now ?? (() => Date.now());
    this.randomToken = options.randomToken ?? defaultRandomToken;
    this.ttlMs = options.ttlMs ?? PREPARED_TX_TTL_MS;
    this.relayTimeoutMs = options.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
  }

  private syncPauseState(): void {
    this.opts.onSyncPauseChange?.(this.pending !== null || this.isRelayInFlight());
  }

  attach(wallet: TxFlowWallet, network: ZephyrNetwork, viewOnly: boolean): void {
    this.clearPending();
    this.generation++;
    this.lateRelaysInFlight = 0;
    this.wallet = wallet;
    this.network = network;
    this.viewOnly = viewOnly;
    this.syncPauseState();
  }

  /** Lock / close: void and forget any prepared build immediately. */
  async detach(): Promise<void> {
    const wallet = this.wallet;
    const entry = this.pending;
    this.clearPending();
    this.generation++;
    this.wallet = null;
    this.relayInFlight = false;
    this.lateRelaysInFlight = 0;
    this.syncPauseState();
    if (wallet && entry) {
      try {
        await wallet.discardPrepared(entry.coreToken);
      } catch {
        // Closing the wallet voids the slot regardless
      }
    }
  }

  isRelayInFlight(): boolean {
    return this.relayInFlight || this.lateRelaysInFlight > 0;
  }

  getPending(): PreparedTxDto | null {
    const e = this.pending;
    if (!e) return null;
    return {
      token: e.token,
      kind: e.kind,
      status: e.status,
      sourceAsset: e.sourceAsset,
      destinationAsset: e.destinationAsset,
      destinations: e.destinations,
      txs: e.txs,
      totalAmount: e.totalAmount.toString(),
      totalFee: e.totalFee.toString(),
      feeAsset: e.sourceAsset,
      totalDebited: e.totalDebited.toString(),
      amountMinted: e.amountMinted !== null ? e.amountMinted.toString() : null,
      pricingRecordHeight: e.pricingRecordHeight,
      pricingRecordExpiresAtHeight:
        e.pricingRecordHeight !== null
          ? pricingRecordStatus(e.pricingRecordHeight, 0).expiresAtHeight
          : null,
      daemonHeightAtPrepare: e.daemonHeightAtPrepare,
      priority: e.priority,
      nodeUrl: e.nodeUrl,
      nodeHost: e.nodeHost,
      preparedAt: e.preparedAt,
      expiresAt: e.expiresAt,
      relayAttempts: e.relayAttempts,
      maxRelayAttempts: MAX_RELAY_ATTEMPTS,
      lastRelayError: e.lastRelayError
    };
  }

  private clearPending(): void {
    this.pending = null;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.syncPauseState();
  }

  private notify(): void {
    this.opts.onChange?.();
  }

  private async assertCanPrepare(): Promise<TxFlowWallet> {
    const wallet = this.wallet;
    if (!wallet) {
      throw new TxFlowError("LOCKED", "Wallet must be unlocked");
    }
    if (this.viewOnly || (await wallet.isViewOnly())) {
      throw new TxFlowError("VIEW_ONLY", "View-only wallets cannot sign or send transactions");
    }
    if (this.isRelayInFlight() || this.pending?.status === "relay-unknown") {
      throw new TxFlowError(
        "RELAY_PENDING",
        "A previous transaction has an unknown broadcast status — retry it or discard and sync first"
      );
    }
    const blocked = this.opts.blockNewTransaction?.() ?? null;
    if (blocked) {
      throw new TxFlowError("SAVE_PENDING", blocked);
    }
    return wallet;
  }

  private parsePriority(priority: unknown): TxPriorityDto {
    if (priority === undefined) return "default";
    if (!isTxPriority(priority)) {
      throw new TxFlowError("INVALID_PRIORITY", "Unknown transaction priority");
    }
    return priority;
  }

  private assertAsset(asset: unknown, label = "Asset"): string {
    if (typeof asset !== "string" || !isV2Asset(asset)) {
      throw new TxFlowError("INVALID_ASSET", `${label} must be one of ZPH, ZSD, ZRS, ZYS`);
    }
    return asset;
  }

  private async validateDestinationAddress(raw: unknown, index: number | null): Promise<string> {
    const label = index === null ? "Destination address" : `Destination ${index + 1} address`;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new TxFlowError("INVALID_ADDRESS", `${label} is required`);
    }
    const address = raw.trim();
    if (address.length > 256 || /\s/.test(address)) {
      throw new TxFlowError("INVALID_ADDRESS", `${label} is not a valid Zephyr address`);
    }
    try {
      await this.opts.validateAddress(address, this.network);
    } catch {
      throw new TxFlowError(
        "INVALID_ADDRESS",
        `${label} is not a valid Zephyr ${this.network} address`
      );
    }
    return address;
  }

  private assertBalance(asset: string, required: bigint): void {
    const unlocked = this.opts.getUnlockedBalance(asset);
    if (unlocked !== null && required > unlocked) {
      throw new TxFlowError(
        "INSUFFICIENT_FUNDS",
        `Not enough unlocked ${asset} for this transaction`
      );
    }
  }

  private async discardQuietly(wallet: TxFlowWallet, coreToken: string): Promise<void> {
    try {
      await wallet.discardPrepared(coreToken);
    } catch {
      // Best-effort; the slot is voided by the next prepare anyway
    }
  }

  private dropReady(): void {
    if (this.pending && this.pending.status === "ready") {
      const wallet = this.wallet;
      const core = this.pending.coreToken;
      this.clearPending();
      if (wallet) void this.discardQuietly(wallet, core);
    }
  }

  private mapPart(tx: ZephyrBuiltTx): PreparedTxPartDto {
    return {
      hash: tx.hash,
      amount: tx.amount.toString(),
      fee: tx.fee.toString(),
      feeAsset: tx.feeAsset,
      totalDebited: tx.totalDebited.toString(),
      outcome: null
    };
  }

  private install(
    entry: Omit<
      PendingEntry,
      "token" | "preparedAt" | "expiresAt" | "relayAttempts" | "lastRelayError" | "status" | "nodeUrl" | "nodeHost" | "daemonHeightAtPrepare"
    >
  ): PreparedTxDto {
    const node = this.opts.getNode();
    const preparedAt = this.now();
    const full: PendingEntry = {
      ...entry,
      token: this.randomToken(),
      status: "ready",
      nodeUrl: node.url,
      nodeHost: node.host,
      daemonHeightAtPrepare: this.opts.getDaemonHeight(),
      preparedAt,
      expiresAt: preparedAt + this.ttlMs,
      relayAttempts: 0,
      lastRelayError: null
    };
    this.clearPending();
    this.pending = full;
    this.syncPauseState();
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.checkExpiry();
    }, this.ttlMs + 25);
    const dto = this.getPending();
    this.notify();
    if (!dto) throw new TxFlowError("BUILD_FAILED", "Prepared transaction vanished");
    return dto;
  }

  private destinationsMatchRequested(
    txs: readonly ZephyrBuiltTx[],
    requested: readonly { readonly address: string; readonly amount: bigint }[]
  ): boolean {
    const expectedByAddr = new Map<string, bigint>();
    for (const d of requested) {
      expectedByAddr.set(d.address, (expectedByAddr.get(d.address) ?? 0n) + d.amount);
    }
    const builtByAddr = new Map<string, bigint>();
    for (const t of txs) {
      if (!Array.isArray(t.destinations) || t.destinations.length === 0) {
        return false;
      }
      for (const d of t.destinations) {
        if (typeof d.address !== "string" || d.amount <= 0n) {
          return false;
        }
        builtByAddr.set(d.address, (builtByAddr.get(d.address) ?? 0n) + d.amount);
      }
    }
    if (builtByAddr.size !== expectedByAddr.size) return false;
    for (const [addr, amt] of expectedByAddr) {
      if (builtByAddr.get(addr) !== amt) return false;
    }
    return true;
  }

  async prepareTransfer(params: {
    readonly asset: string;
    readonly destinations: readonly { readonly address: string; readonly amount: string }[];
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    const wallet = await this.assertCanPrepare();
    const asset = this.assertAsset(params.asset);
    const priority = this.parsePriority(params.priority);
    if (
      !Array.isArray(params.destinations) ||
      params.destinations.length < 1 ||
      params.destinations.length > MAX_TRANSFER_DESTINATIONS
    ) {
      throw new TxFlowError(
        "INVALID_DESTINATIONS",
        `A transfer needs between 1 and ${MAX_TRANSFER_DESTINATIONS} destinations`
      );
    }
    const destinations: { address: string; amount: bigint }[] = [];
    for (const [i, d] of params.destinations.entries()) {
      const address = await this.validateDestinationAddress(d?.address, i);
      const amount = validateTransferAmount(typeof d?.amount === "string" ? d.amount : "");
      if (!amount.ok) {
        throw new TxFlowError("INVALID_AMOUNT", `Destination ${i + 1}: ${amount.error}`);
      }
      destinations.push({ address, amount: amount.atomic });
    }
    const requested = destinations.reduce((sum, d) => sum + d.amount, 0n);
    if (requested > MAX_U64_ATOMIC) {
      throw new TxFlowError("INVALID_AMOUNT", "Total transfer amount is out of range");
    }
    this.assertBalance(asset, requested);
    this.dropReady();

    const generation = this.generation;
    let prepared: ZephyrPreparedTransfer;
    try {
      prepared = await wallet.prepareTransfer({
        asset,
        destinations: destinations.map((d) => ({ address: d.address, amount: d.amount })),
        accountIndex: 0,
        priority
      });
    } catch (err) {
      throw mapBuildError(err);
    }
    if (generation !== this.generation || this.wallet !== wallet) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("LOCKED", "Wallet was locked while preparing");
    }
    const txs = prepared.build.txs;
    const totalAmount = txs.reduce((s, t) => s + t.amount, 0n);
    const totalFee = txs.reduce((s, t) => s + t.fee, 0n);
    const totalDebited = txs.reduce((s, t) => s + t.totalDebited, 0n);
    // Review invariant: every built destination, asset, fee, and total matches the request
    if (
      txs.length === 0 ||
      totalAmount !== requested ||
      totalFee < 0n ||
      txs.some(
        (t) =>
          t.sourceAsset !== asset ||
          t.destinationAsset !== asset ||
          t.feeAsset !== asset ||
          t.fee < 0n ||
          t.totalDebited !== t.amount + t.fee
      ) ||
      !this.destinationsMatchRequested(txs, destinations)
    ) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("BUILD_FAILED", "Built transaction does not match the request");
    }
    return this.install({
      coreToken: prepared.token,
      kind: "transfer",
      sourceAsset: asset,
      destinationAsset: asset,
      destinations: destinations.map((d) => ({ address: d.address, amount: d.amount.toString() })),
      txs: txs.map((t) => this.mapPart(t)),
      totalAmount,
      totalFee,
      totalDebited,
      amountMinted: null,
      pricingRecordHeight: null,
      priority
    });
  }

  async prepareSweep(params: {
    readonly asset: string;
    readonly address: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    const wallet = await this.assertCanPrepare();
    const asset = this.assertAsset(params.asset);
    const priority = this.parsePriority(params.priority);
    const address = await this.validateDestinationAddress(params.address, null);
    const unlocked = this.opts.getUnlockedBalance(asset);
    if (unlocked !== null && unlocked <= 0n) {
      throw new TxFlowError("INSUFFICIENT_FUNDS", `No unlocked ${asset} available to sweep`);
    }
    this.dropReady();

    const generation = this.generation;
    let prepared: ZephyrPreparedSweep;
    try {
      prepared = await wallet.prepareSweepUnlocked({ asset, address, accountIndex: 0, priority });
    } catch (err) {
      throw mapBuildError(err);
    }
    if (generation !== this.generation || this.wallet !== wallet) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("LOCKED", "Wallet was locked while preparing");
    }
    const build = prepared.build;
    if (
      build.txs.length === 0 ||
      build.totalAmount <= 0n ||
      build.totalFee < 0n ||
      build.txs.some(
        (t) =>
          t.sourceAsset !== asset ||
          t.destinationAsset !== asset ||
          t.feeAsset !== asset ||
          t.fee < 0n ||
          t.totalDebited !== t.amount + t.fee ||
          !Array.isArray(t.destinations) ||
          t.destinations.length === 0 ||
          t.destinations.some((d) => d.address !== address)
      )
    ) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("BUILD_FAILED", "Built sweep does not match the request");
    }
    const totalDebited = build.txs.reduce((s, t) => s + t.totalDebited, 0n);
    return this.install({
      coreToken: prepared.token,
      kind: "sweep",
      sourceAsset: asset,
      destinationAsset: asset,
      destinations: [{ address, amount: build.totalAmount.toString() }],
      txs: build.txs.map((t) => this.mapPart(t)),
      totalAmount: build.totalAmount,
      totalFee: build.totalFee,
      totalDebited,
      amountMinted: null,
      pricingRecordHeight: null,
      priority
    });
  }

  async prepareConversion(params: {
    readonly sourceAsset: string;
    readonly destinationAsset: string;
    readonly amount: string;
    readonly address?: string;
    readonly priority?: TxPriorityDto;
  }): Promise<PreparedTxDto> {
    const wallet = await this.assertCanPrepare();
    const sourceAsset = this.assertAsset(params.sourceAsset, "Source asset");
    const destinationAsset = this.assertAsset(params.destinationAsset, "Destination asset");
    const priority = this.parsePriority(params.priority);
    const pair = findConversionPair(sourceAsset, destinationAsset);
    if (!pair) {
      throw new TxFlowError(
        "INVALID_ASSET",
        `${sourceAsset} → ${destinationAsset} is not a supported V2 conversion pair`
      );
    }
    const amount = validateConversionAmount(typeof params.amount === "string" ? params.amount : "");
    if (!amount.ok) {
      throw new TxFlowError("INVALID_AMOUNT", amount.error);
    }
    const address =
      params.address !== undefined && params.address.trim().length > 0
        ? await this.validateDestinationAddress(params.address, null)
        : await wallet.getPrimaryAddress();

    const gate = evaluateConversionGate(
      this.opts.getReserve(),
      sourceAsset,
      destinationAsset,
      this.opts.getDaemonHeight()
    );
    if (!gate.allowed) {
      throw new TxFlowError("RESERVE_BLOCKED", gate.reason ?? "Conversion pair is blocked");
    }
    this.assertBalance(sourceAsset, amount.atomic);
    this.dropReady();

    const generation = this.generation;
    let prepared: ZephyrPreparedConversion;
    try {
      prepared = await wallet.prepareConversion({
        sourceAsset,
        destinationAsset,
        destination: { address, amount: amount.atomic },
        accountIndex: 0,
        priority
      });
    } catch (err) {
      throw mapBuildError(err);
    }
    if (generation !== this.generation || this.wallet !== wallet) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("LOCKED", "Wallet was locked while preparing");
    }
    const b = prepared.build;
    if (
      b.sourceAsset !== sourceAsset ||
      b.destinationAsset !== destinationAsset ||
      b.destination.address !== address ||
      b.amountBurnt !== amount.atomic ||
      b.feeAsset !== sourceAsset ||
      b.fee < 0n ||
      b.totalDebited !== b.amountBurnt + b.fee ||
      !Number.isSafeInteger(b.pricingRecordHeight) ||
      b.pricingRecordHeight <= 0
    ) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError("BUILD_FAILED", "Built conversion does not match the request");
    }
    const status = pricingRecordStatus(b.pricingRecordHeight, this.opts.getDaemonHeight());
    if (status.expired) {
      await this.discardQuietly(wallet, prepared.token);
      throw new TxFlowError(
        "PRICING_RECORD_EXPIRED",
        `Pricing record at height ${b.pricingRecordHeight} is ${status.ageBlocks} blocks old — sync the wallet and prepare again`
      );
    }
    return this.install({
      coreToken: prepared.token,
      kind: "conversion",
      sourceAsset,
      destinationAsset,
      destinations: [{ address, amount: b.amountBurnt.toString() }],
      txs: [
        {
          hash: b.hash,
          amount: b.amountBurnt.toString(),
          fee: b.fee.toString(),
          feeAsset: b.feeAsset,
          totalDebited: b.totalDebited.toString(),
          outcome: null
        }
      ],
      totalAmount: b.amountBurnt,
      totalFee: b.fee,
      totalDebited: b.totalDebited,
      amountMinted: b.amountMinted,
      pricingRecordHeight: b.pricingRecordHeight,
      priority
    });
  }

  /**
   * Auto-expire a `ready` build on wall-clock TTL or a stale 10-block pricing
   * record. `relay-unknown` builds are kept until the user explicitly retries or
   * discards (never rebuilt automatically).
   */
  checkExpiry(): boolean {
    const e = this.pending;
    if (!e || e.status !== "ready" || this.isRelayInFlight()) return false;
    const ttlExpired = this.now() >= e.expiresAt;
    const pricingExpired =
      e.pricingRecordHeight !== null &&
      pricingRecordStatus(e.pricingRecordHeight, this.opts.getDaemonHeight()).expired;
    if (!ttlExpired && !pricingExpired) return false;
    const wallet = this.wallet;
    this.clearPending();
    if (wallet) void this.discardQuietly(wallet, e.coreToken);
    this.notify();
    return true;
  }

  private expiredOutcome(entry: PendingEntry, reason: string, message: string): RelayOutcomeDto {
    const wallet = this.wallet;
    if (this.pending === entry) this.clearPending();
    if (wallet) void this.discardQuietly(wallet, entry.coreToken);
    return { kind: "expired", reason, message };
  }

  async relay(token: string): Promise<RelayOutcomeDto> {
    const wallet = this.wallet;
    if (!wallet) throw new TxFlowError("LOCKED", "Wallet must be unlocked");
    const entry = this.pending;
    if (!entry || entry.token !== token) {
      throw new TxFlowError(
        "TOKEN_UNKNOWN",
        "This prepared transaction is no longer available — prepare it again"
      );
    }
    if (this.isRelayInFlight()) {
      throw new TxFlowError("RELAY_PENDING", "A relay for this transaction is already running");
    }
    if (entry.status === "ready" && this.now() >= entry.expiresAt) {
      const out = this.expiredOutcome(
        entry,
        "PREPARED_TTL",
        "The prepared transaction expired before it was confirmed — prepare it again"
      );
      this.notify();
      return out;
    }
    if (entry.kind === "conversion") {
      if (
        entry.pricingRecordHeight === null ||
        !Number.isSafeInteger(entry.pricingRecordHeight) ||
        entry.pricingRecordHeight <= 0
      ) {
        const out = this.expiredOutcome(
          entry,
          "PRICING_RECORD_INVALID",
          "The conversion pricing record height is invalid — prepare the conversion again"
        );
        this.notify();
        return out;
      }
      let daemonHeight = this.opts.getDaemonHeight();
      if (this.opts.refreshDaemonHeight) {
        const fresh = await this.opts.refreshDaemonHeight().catch(() => null);
        if (typeof fresh === "number" && Number.isSafeInteger(fresh) && fresh > daemonHeight) {
          daemonHeight = fresh;
        }
      }
      const pr = pricingRecordStatus(entry.pricingRecordHeight, daemonHeight);
      if (pr.expired) {
        const out = this.expiredOutcome(
          entry,
          "PRICING_RECORD_AGE",
          entry.status === "relay-unknown"
            ? "The pricing record expired. If an earlier attempt reached the network it appears after sync; otherwise prepare the conversion again."
            : `The pricing record at height ${entry.pricingRecordHeight} expired (${pr.ageBlocks} blocks old) — prepare the conversion again`
        );
        this.notify();
        return out;
      }
    }
    if (entry.relayAttempts >= MAX_RELAY_ATTEMPTS) {
      return {
        kind: "relay-unknown",
        pending: this.getPending()!,
        reason: "RELAY_ATTEMPTS_EXHAUSTED",
        message: "Relay attempts exhausted — discard and sync to verify the broadcast status",
        canRetry: false,
        persisted: false
      };
    }

    this.relayInFlight = true;
    this.syncPauseState();
    this.notify();
    try {
      // Run pre-relay checks (host permission, sync idle wait, daemon bind) before consuming an attempt.
      await this.opts.beforeRelay?.();
      const relayNode = this.opts.getNode();
      entry.nodeUrl = relayNode.url;
      entry.nodeHost = relayNode.host;
      entry.relayAttempts += 1;
      const relayGeneration = this.generation;
      this.notify();

      type Raced =
        | { readonly t: "ok"; readonly r: ZephyrRelayResult }
        | { readonly t: "err"; readonly e: unknown }
        | { readonly t: "timeout" };
      const relayPromise = wallet.relayPrepared(entry.coreToken);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced: Raced = await Promise.race([
        relayPromise.then(
          (r): Raced => ({ t: "ok", r }),
          (e: unknown): Raced => ({ t: "err", e })
        ),
        new Promise<Raced>((resolve) => {
          timer = setTimeout(() => resolve({ t: "timeout" }), this.relayTimeoutMs);
        })
      ]);
      if (timer !== undefined) clearTimeout(timer);

      if (raced.t === "timeout") {
        this.lateRelaysInFlight += 1;
        this.syncPauseState();
        void relayPromise
          .then(
            (r) => {
              if (relayGeneration === this.generation && this.wallet === wallet) {
                this.handleLateResult(entry, r);
              }
            },
            () => undefined
          )
          .finally(() => {
            if (relayGeneration === this.generation) {
              this.lateRelaysInFlight = Math.max(0, this.lateRelaysInFlight - 1);
              if (!this.isRelayInFlight()) {
                this.opts.afterRelay?.();
              }
              this.syncPauseState();
              this.notify();
            }
          });
        return await this.toRelayUnknown(
          entry,
          "RELAY_TIMEOUT",
          "The node did not answer in time — the transaction may have reached the network",
          false
        );
      }
      if (raced.t === "err") {
        return await this.handleRelayFailure(entry, raced.e);
      }
      return await this.handleRelayResult(entry, raced.r);
    } finally {
      this.relayInFlight = false;
      if (!this.isRelayInFlight()) {
        this.opts.afterRelay?.();
      }
      this.syncPauseState();
      this.notify();
    }
  }

  private async toRelayUnknown(
    entry: PendingEntry,
    reason: string,
    message: string,
    persisted: boolean
  ): Promise<RelayOutcomeDto> {
    entry.status = "relay-unknown";
    entry.lastRelayError = message;
    if (entry.txs.every((t) => t.outcome === null || t.outcome === "notSent")) {
      entry.txs = entry.txs.map((t) => ({ ...t, outcome: t.outcome ?? "unknown" }));
    }
    await this.opts.onRelayUnknown?.({
      txHashes: entry.txs.map((t) => t.hash),
      nodeHost: entry.nodeHost,
      reason
    });
    const pending = this.pending === entry ? this.getPending() : null;
    return {
      kind: "relay-unknown",
      pending: pending ?? {
        ...(this.snapshotOf(entry))
      },
      reason,
      message,
      canRetry: entry.relayAttempts < MAX_RELAY_ATTEMPTS,
      persisted
    };
  }

  private snapshotOf(entry: PendingEntry): PreparedTxDto {
    const saved = this.pending;
    this.pending = entry;
    const dto = this.getPending()!;
    this.pending = saved;
    return dto;
  }

  private async handleRelayFailure(entry: PendingEntry, err: unknown): Promise<RelayOutcomeDto> {
    const we = asWalletError(err);
    const code = we?.code ?? "";
    const diag = we?.diagnostic ?? "";

    if (code === "TX_REJECTED") {
      const hadEarlierUnknown = entry.status === "relay-unknown" || entry.relayAttempts > 1;
      const hashes = entry.txs.map((t) => t.hash);
      const nodeHost = entry.nodeHost;
      if (this.pending === entry) this.clearPending();
      if (hadEarlierUnknown) {
        const reason = diag || "REJECTED";
        await this.opts.onUncertainRejection?.({ txHashes: hashes, nodeHost, reason });
        return {
          kind: "rejected",
          reason,
          verifyRequired: true,
          message:
            diag === "DOUBLE_SPEND"
              ? "The node reported inputs already spent on retry — the earlier attempt likely reached the network. Sync the wallet to verify before sending again."
              : "The node rejected this retry after an earlier uncertain attempt — the earlier attempt may have reached the network. Sync the wallet to verify before sending again."
        };
      }
      return {
        kind: "rejected",
        reason: diag || "REJECTED",
        message: REJECTION_MESSAGES[diag] ?? "The node rejected the transaction"
      };
    }
    if (diag === "RELAY_TOKEN_VOID") {
      const wasUnknown = entry.status === "relay-unknown";
      const hashes = entry.txs.map((t) => t.hash);
      const nodeHost = entry.nodeHost;
      if (this.pending === entry) this.clearPending();
      if (wasUnknown) {
        await this.opts.onUncertainRejection?.({
          txHashes: hashes,
          nodeHost,
          reason: "RELAY_TOKEN_VOID"
        });
      }
      return {
        kind: "expired",
        reason: "RELAY_TOKEN_VOID",
        message: wasUnknown
          ? "The prepared transaction is no longer valid. Sync to verify whether an earlier attempt reached the network."
          : "The prepared transaction is no longer valid — prepare it again"
      };
    }
    if (diag === "PRICING_RECORD_AGE") {
      if (this.pending === entry) this.clearPending();
      return {
        kind: "expired",
        reason: "PRICING_RECORD_AGE",
        message: "The pricing record aged past its validity window — prepare the conversion again"
      };
    }
    // RELAY_UNKNOWN, DAEMON_BUSY, DAEMON_UNREACHABLE, HTTP 5xx, or anything else:
    // the broadcast status is ambiguous across HA replicas. Keep the exact build.
    let message = "No usable answer from the node — the transaction may have reached the network";
    if (diag === "DAEMON_BUSY") message = "The node was busy — the broadcast status is unknown";
    if (diag === "DAEMON_UNREACHABLE") message = "The node was unreachable — the broadcast status is unknown";
    return await this.toRelayUnknown(entry, diag || code || "RELAY_UNKNOWN", message, false);
  }

  private async handleRelayResult(
    entry: PendingEntry,
    result: ZephyrRelayResult
  ): Promise<RelayOutcomeDto> {
    const outcomes = new Map(result.txs.map((t) => [t.hash, t.outcome] as const));
    entry.txs = entry.txs.map((t) => ({ ...t, outcome: outcomes.get(t.hash) ?? t.outcome }));
    const accepted = entry.txs.filter((t) => t.outcome === "accepted").map((t) => t.hash);
    const anyNotRelayed = result.txs.some((t) => t.outcome === "accepted" && Boolean(t.notRelayed));
    const node = { host: entry.nodeHost };
    const relayedAt = this.now();

    if (accepted.length === 0) {
      return await this.toRelayUnknown(
        entry,
        "RELAY_UNKNOWN",
        "No transaction was confirmed as accepted — the broadcast status is unknown",
        false
      );
    }

    let persisted = true;
    let persistMessage = "";
    try {
      await this.opts.persistAfterRelay(accepted);
    } catch {
      persisted = false;
      persistMessage =
        "The transaction was relayed but the wallet state could not be saved — retry saving before closing";
    }

    if (result.complete) {
      if (this.pending === entry) this.clearPending();
      if (anyNotRelayed) {
        await this.opts.onRelayUnknown?.({
          txHashes: accepted,
          nodeHost: node.host,
          reason: "NOT_RELAYED"
        });
      } else {
        await this.opts.onRelayConfirmed?.();
      }
      return persisted
        ? {
            kind: "relayed",
            txHashes: accepted,
            relayedAt,
            nodeHost: node.host,
            persisted: true,
            ...(anyNotRelayed ? { notRelayed: true } : {})
          }
        : {
            kind: "relayed-unsaved",
            txHashes: accepted,
            relayedAt,
            nodeHost: node.host,
            message: persistMessage,
            ...(anyNotRelayed ? { notRelayed: true } : {})
          };
    }
    return await this.toRelayUnknown(
      entry,
      "PARTIAL_RELAY",
      `${accepted.length} of ${entry.txs.length} transactions were accepted — retry the exact remaining transactions or discard and sync`,
      persisted
    );
  }

  private handleLateResult(entry: PendingEntry, result: ZephyrRelayResult): void {
    const outcomes = new Map(result.txs.map((t) => [t.hash, t.outcome] as const));
    entry.txs = entry.txs.map((t) => ({ ...t, outcome: outcomes.get(t.hash) ?? t.outcome }));
    const accepted = entry.txs.filter((t) => t.outcome === "accepted").map((t) => t.hash);
    if (accepted.length > 0) {
      this.opts.onLateRelayAccepted?.(accepted);
    }
    if (result.complete && this.pending === entry) {
      this.clearPending();
      const anyNotRelayed = result.txs.some((t) => t.outcome === "accepted" && Boolean(t.notRelayed));
      if (!anyNotRelayed) {
        this.opts.onRelayConfirmed?.();
      }
    }
    this.notify();
  }

  /** Explicit user discard (also used by "Discard & sync to verify"). */
  async discard(token: string): Promise<{
    readonly wasRelayUnknown: boolean;
    readonly txHashes: readonly string[];
    readonly nodeHost: string;
  }> {
    const entry = this.pending;
    if (!entry) return { wasRelayUnknown: false, txHashes: [], nodeHost: "" };
    if (entry.token !== token) {
      throw new TxFlowError("TOKEN_UNKNOWN", "This prepared transaction is no longer available");
    }
    if (this.isRelayInFlight()) {
      throw new TxFlowError("RELAY_PENDING", "Wait for the running relay to finish");
    }
    const wallet = this.wallet;
    const txHashes = entry.txs.map((t) => t.hash);
    const nodeHost = entry.nodeHost;
    this.clearPending();
    if (wallet) await this.discardQuietly(wallet, entry.coreToken);
    this.notify();
    return { wasRelayUnknown: entry.status === "relay-unknown", txHashes, nodeHost };
  }

  /** UI gone / node switched: drop a `ready` build, keep a `relay-unknown` one. */
  release(): void {
    if (this.isRelayInFlight()) return;
    const had = this.pending?.status === "ready";
    this.dropReady();
    if (had) this.notify();
  }
}
