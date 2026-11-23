<script lang="ts">
  import { formatAtomicParts } from "@lateo-wallet/core/assets";
  import type {
    BalanceEntryDto,
    PreparedTxDto,
    ReserveStatusDto,
    TxPriorityDto,
    WalletClient
  } from "@lateo-wallet/core/rpc";
  import {
    CONVERSION_MAX_DECIMALS,
    CONVERSION_PAIRS,
    PRICING_RECORD_VALIDITY_BLOCKS,
    TX_PRIORITIES,
    estimateConversionOutput,
    evaluateConversionGate,
    validateConversionAmount
  } from "@lateo-wallet/core/tx";
  import AssetBadge from "./AssetBadge.svelte";

  interface Props {
    client: WalletClient;
    balances: readonly BalanceEntryDto[];
    reserve: ReserveStatusDto | null;
    daemonHeight: number;
    primaryAddress: string;
    nodeHost: string;
    viewOnly: boolean;
    disabled?: boolean;
    reserveBusy?: boolean;
    onRefreshReserve: () => void;
    onPrepared: (prepared: PreparedTxDto) => void;
  }

  let {
    client,
    balances,
    reserve,
    daemonHeight,
    primaryAddress,
    nodeHost,
    viewOnly,
    disabled = false,
    reserveBusy = false,
    onRefreshReserve,
    onPrepared
  }: Props = $props();

  let selectedPairId = $state<string>("ZPH-ZSD");
  let amount = $state<string>("");
  let customAddress = $state<string>("");
  let priority = $state<TxPriorityDto>("default");
  let preparing = $state(false);
  let formError = $state<string | null>(null);

  const activePair = $derived(
    CONVERSION_PAIRS.find((p) => p.id === selectedPairId) ?? CONVERSION_PAIRS[0]!
  );

  const sourceBalance = $derived.by(() => {
    const entry = balances.find((b) => b.asset === activePair.source);
    return BigInt(entry?.unlocked ?? "0");
  });

  const sourceUnlockedParts = $derived(formatAtomicParts(sourceBalance, 4));

  const gate = $derived(
    evaluateConversionGate(reserve, activePair.source, activePair.destination)
  );

  const amountValidation = $derived(
    amount.trim().length > 0 ? validateConversionAmount(amount) : null
  );

  const estimatedOutputAtomic = $derived(
    amountValidation && amountValidation.ok
      ? estimateConversionOutput(
          reserve?.prices ?? null,
          activePair.source,
          activePair.destination,
          amountValidation.atomic
        )
      : null
  );

  const estimatedOutputParts = $derived(
    estimatedOutputAtomic !== null ? formatAtomicParts(estimatedOutputAtomic, 4) : null
  );

  const oracleRateSummary = $derived.by(() => {
    const p = reserve?.prices;
    if (!p) return "Oracle pricing loads with reserve status";
    switch (activePair.id) {
      case "ZPH-ZSD":
      case "ZSD-ZPH":
        return `1 ZSD ≈ ${p.zsdSpot} ZPH (spot) / ${p.zsdMa} ZPH (MA) · ZPH/USD $${p.zphUsdSpot}`;
      case "ZPH-ZRS":
      case "ZRS-ZPH":
        return `1 ZRS ≈ ${p.zrsSpot} ZPH (spot) / ${p.zrsMa} ZPH (MA)`;
      case "ZSD-ZYS":
      case "ZYS-ZSD":
        return `1 ZYS ≈ ${p.zysPrice} ZSD`;
      default:
        return "";
    }
  });

  function selectPair(pairId: string): void {
    selectedPairId = pairId;
    formError = null;
  }

  async function handleSubmit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    formError = null;

    if (viewOnly) {
      formError = "View-only wallets cannot sign or convert assets";
      return;
    }

    const check = validateConversionAmount(amount);
    if (!check.ok) {
      formError = check.error;
      return;
    }

    if (!gate.allowed) {
      formError = gate.reason ?? "This conversion pair is currently blocked by the reserve ratio";
      return;
    }

    preparing = true;
    try {
      const trimmedAddr = customAddress.trim();
      const prepared = await client.prepareConversion({
        sourceAsset: activePair.source,
        destinationAsset: activePair.destination,
        amount: amount.trim(),
        ...(trimmedAddr.length > 0 ? { address: trimmedAddr } : {}),
        priority
      });
      onPrepared(prepared);
    } catch (err) {
      formError = err instanceof Error ? err.message : "Failed to prepare conversion";
    } finally {
      preparing = false;
    }
  }
</script>

<section class="lt-panel lt-stack" data-testid="convert-view">
  <div class="lt-panel-header">
    <div>
      <h2 class="lt-panel-title">Convert V2 Assets</h2>
      <p class="lt-panel-subtitle">
        On-chain protocol mint &amp; redeem across all 6 V2 pairs via
        <span class="lt-hash-short"><bdi>{nodeHost}</bdi></span>. Maximum
        {CONVERSION_MAX_DECIMALS} decimal places; pricing record valid for
        {PRICING_RECORD_VALIDITY_BLOCKS} blocks.
      </p>
    </div>
    <button
      type="button"
      class="lt-btn lt-btn-secondary"
      disabled={reserveBusy || preparing}
      onclick={onRefreshReserve}
      data-testid="convert-refresh-reserve-btn"
    >
      {reserveBusy ? "Updating..." : "Refresh reserve"}
    </button>
  </div>

  {#if viewOnly}
    <div class="lt-alert lt-alert-warning" role="status" data-testid="convert-view-only-notice">
      <div class="lt-alert-body">
        This is a view-only wallet. On-chain conversions require a full spend-key wallet.
      </div>
    </div>
  {/if}

  <!-- Live reserve-ratio gating banner explaining blocked pairs and which pairs remain open -->
  <div
    class={gate.allowed
      ? "lt-callout lt-callout-success"
      : reserve
        ? "lt-callout lt-callout-danger"
        : "lt-callout lt-callout-warning"}
    role="status"
    data-testid="convert-reserve-gate-banner"
  >
    <div class="lt-sync-row">
      <span class="lt-callout-title" data-testid="convert-gate-headline">
        {#if !reserve}
          Reserve status required before converting
        {:else if gate.allowed}
          {activePair.action} ({activePair.label}) is OPEN at reserve ratio {reserve.reserveRatio}x
          (MA {reserve.reserveRatioMa}x)
        {:else}
          {activePair.action} ({activePair.label}) is BLOCKED by reserve ratio
          {reserve.reserveRatio}x (MA {reserve.reserveRatioMa}x)
        {/if}
      </span>
      <span class="lt-hash-short" data-testid="convert-pricing-height-badge">
        Pricing height: #{Math.max(daemonHeight, reserve?.height ?? 0)}
      </span>
    </div>

    {#if gate.reason}
      <p class="lt-compact" data-testid="convert-gate-reason"><bdi>{gate.reason}</bdi></p>
    {:else if reserve}
      <p class="lt-compact" data-testid="convert-gate-reason">
        <bdi>{reserve.statusSummary}</bdi>
      </p>
    {/if}

    {#if reserve}
      <div class="lt-meta-pills" data-testid="convert-gate-pair-pills">
        <span class="lt-compact">
          <strong>Open pairs ({gate.openPairs.length}):</strong>
          {gate.openPairs.length > 0 ? gate.openPairs.join(", ") : "None"}
        </span>
        {#if gate.blockedPairs.length > 0}
          <span class="lt-compact" data-testid="convert-blocked-pairs-list">
            · <strong>Blocked ({gate.blockedPairs.length}):</strong>
            {gate.blockedPairs.join(", ")}
          </span>
        {/if}
      </div>
    {/if}
  </div>

  {#if formError}
    <div class="lt-alert lt-alert-danger" role="alert" data-testid="convert-error-banner">
      <div class="lt-alert-body"><bdi>{formError}</bdi></div>
    </div>
  {/if}

  <!-- All 6 V2 conversion pairs chooser -->
  <div class="lt-convert-pair-grid" role="group" aria-label="V2 conversion pairs" data-testid="convert-pair-grid">
    {#each CONVERSION_PAIRS as pair (pair.id)}
      {@const pairOpen = reserve ? reserve.conversions[pair.availabilityKey] : false}
      <button
        type="button"
        class={pair.id === selectedPairId
          ? "lt-choice-card lt-pair-card-active"
          : "lt-choice-card"}
        aria-pressed={pair.id === selectedPairId}
        disabled={disabled || preparing}
        onclick={() => selectPair(pair.id)}
        data-testid={`convert-pair-${pair.id}`}
      >
        <div class="lt-sync-row">
          <span class="lt-choice-title">{pair.label}</span>
          <span
            class={pairOpen ? "lt-tx-badge lt-tx-confirmed" : "lt-tx-badge lt-tx-failed"}
            data-testid={`convert-pair-status-${pair.id}`}
          >
            {pairOpen ? "Open" : "Blocked"}
          </span>
        </div>
        <span class="lt-choice-desc">{pair.action}</span>
      </button>
    {/each}
  </div>

  <form class="lt-stack" onsubmit={handleSubmit} data-testid="convert-form">
    <div class="lt-grid lt-grid-2">
      <div class="lt-field">
        <label class="lt-label" for="convert-amount-input">
          Amount to convert ({activePair.source}, max {CONVERSION_MAX_DECIMALS} decimals)
        </label>
        <input
          id="convert-amount-input"
          type="text"
          inputmode="decimal"
          class="lt-input"
          placeholder="0.0000"
          aria-invalid={amountValidation !== null && !amountValidation.ok}
          bind:value={amount}
          disabled={disabled || preparing || viewOnly}
          autocomplete="off"
          data-testid="convert-amount-input"
        />
        {#if amountValidation && !amountValidation.ok}
          <p class="lt-field-error" data-testid="convert-amount-error">
            {amountValidation.error}
          </p>
        {/if}
        <div class="lt-help" data-testid="convert-source-balance">
          Spendable {activePair.source}:
          <strong class="lt-num">
            {sourceUnlockedParts.whole}.{sourceUnlockedParts.fracPrimary}<span
              class="lt-amount-tail">{sourceUnlockedParts.fracTail}</span
            >
            {activePair.source}
          </strong>
        </div>
      </div>

      <div class="lt-field">
        <label class="lt-label" for="convert-priority-select">Fee priority</label>
        <select
          id="convert-priority-select"
          class="lt-select"
          bind:value={priority}
          disabled={disabled || preparing || viewOnly}
          data-testid="convert-priority-select"
        >
          {#each TX_PRIORITIES as p (p.value)}
            <option value={p.value}>{p.label} ({p.value})</option>
          {/each}
        </select>
        <div class="lt-help" data-testid="convert-oracle-rate">
          {oracleRateSummary}
        </div>
      </div>
    </div>

    <div class="lt-panel lt-stack" data-testid="convert-estimate-box">
      <div class="lt-sync-row">
        <span class="lt-label">Indicative output (before protocol fee &amp; spread)</span>
        <span class="lt-amount" data-testid="convert-estimated-output">
          <AssetBadge asset={activePair.destination} />
          {#if estimatedOutputParts}
            <span>
              ≈ {estimatedOutputParts.whole}.{estimatedOutputParts.fracPrimary}
              {activePair.destination}
            </span>
          {:else}
            <span class="lt-muted">— {activePair.destination}</span>
          {/if}
        </span>
      </div>
      <p class="lt-compact">
        The exact minted {activePair.destination} amount, network fee, and 10-block pricing record
        height are computed by the wallet core and displayed on the full review screen before
        relay.
      </p>
    </div>

    <details class="lt-disclosure">
      <summary class="lt-disclosure-summary">
        Settlement address (defaults to this wallet's primary address)
      </summary>
      <div class="lt-disclosure-body">
        <div class="lt-field">
          <label class="lt-label" for="convert-address-input">
            Optional custom settlement address
          </label>
          <input
            id="convert-address-input"
            type="text"
            class="lt-input"
            placeholder={primaryAddress}
            bind:value={customAddress}
            disabled={disabled || preparing || viewOnly}
            autocomplete="off"
            spellcheck="false"
            data-testid="convert-address-input"
          />
        </div>
      </div>
    </details>

    <div class="lt-form-actions">
      <button
        type="submit"
        class="lt-btn lt-btn-primary"
        disabled={disabled ||
          preparing ||
          viewOnly ||
          !gate.allowed ||
          (amountValidation !== null && !amountValidation.ok)}
        data-testid="prepare-convert-btn"
      >
        {preparing
          ? "Preparing conversion..."
          : `Prepare & Review ${activePair.action}`}
      </button>
    </div>
  </form>
</section>
