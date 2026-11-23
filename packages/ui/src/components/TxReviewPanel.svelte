<script lang="ts">
  import { formatAtomicParts } from "@lateo-wallet/core/assets";
  import type { PreparedTxDto } from "@lateo-wallet/core/rpc";
  import { PRICING_RECORD_VALIDITY_BLOCKS, pricingRecordStatus } from "@lateo-wallet/core/tx";
  import AddressChunks from "./AddressChunks.svelte";
  import AssetBadge from "./AssetBadge.svelte";

  interface Props {
    pendingTx: PreparedTxDto;
    daemonHeight: number;
    busy?: boolean;
    errorMessage?: string | null;
    onConfirmRelay: (token: string) => void;
    onDiscard: (token: string, verify: boolean) => void;
  }

  let {
    pendingTx,
    daemonHeight,
    busy = false,
    errorMessage = null,
    onConfirmRelay,
    onDiscard
  }: Props = $props();

  const totalAmountParts = $derived(formatAtomicParts(BigInt(pendingTx.totalAmount), 4));
  const totalFeeParts = $derived(formatAtomicParts(BigInt(pendingTx.totalFee), 4));
  const totalDebitedParts = $derived(formatAtomicParts(BigInt(pendingTx.totalDebited), 4));
  const mintedParts = $derived(
    pendingTx.amountMinted !== null ? formatAtomicParts(BigInt(pendingTx.amountMinted), 4) : null
  );

  const effectiveDaemonHeight = $derived(
    Math.max(daemonHeight, pendingTx.daemonHeightAtPrepare, pendingTx.pricingRecordHeight ?? 0)
  );

  const prStatus = $derived(
    pendingTx.pricingRecordHeight !== null
      ? pricingRecordStatus(pendingTx.pricingRecordHeight, effectiveDaemonHeight)
      : null
  );

  const isExpiredConversion = $derived(prStatus !== null && prStatus.expired);
  const canRetryUnknown = $derived(
    pendingTx.relayAttempts < pendingTx.maxRelayAttempts && !isExpiredConversion
  );

  const kindLabel = $derived.by(() => {
    if (pendingTx.kind === "transfer") return "Transfer";
    if (pendingTx.kind === "sweep") return "Sweep Unlocked";
    return `Conversion (${pendingTx.sourceAsset} → ${pendingTx.destinationAsset})`;
  });
</script>

{#if pendingTx.status === "relay-unknown"}
  <section
    class="lt-panel lt-confirm-box lt-stack"
    role="alert"
    data-testid="relay-unknown-panel"
  >
    <div class="lt-panel-header">
      <div>
        <h2 class="lt-panel-title">Broadcast status uncertain (RELAY_UNKNOWN)</h2>
        <p class="lt-panel-subtitle">
          {kindLabel} via <span class="lt-hash-short"><bdi>{pendingTx.nodeHost}</bdi></span> ·
          Attempt {pendingTx.relayAttempts} of {pendingTx.maxRelayAttempts}
        </p>
      </div>
      <span class="lt-tx-badge lt-tx-pending" data-testid="relay-unknown-badge">
        Status unknown
      </span>
    </div>

    <div class="lt-callout lt-callout-warning" data-testid="relay-unknown-message">
      <p class="lt-callout-title">Do not rebuild a new transaction automatically</p>
      <p class="lt-compact">
        <bdi>{pendingTx.lastRelayError ?? "The node did not return a definitive relay answer."}</bdi>
        Because the signed transaction may already have reached the network across HA replicas,
        Lateo retains the exact prepared build so you can safely retry the identical transaction or
        discard it and sync to check the mempool and chain.
      </p>
    </div>

    {#if errorMessage}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="relay-review-error">
        <div class="lt-alert-body"><bdi>{errorMessage}</bdi></div>
      </div>
    {/if}

    <dl class="lt-kv" data-testid="relay-unknown-summary">
      <div>
        <dt>Total debited</dt>
        <dd class="lt-amount">
          <AssetBadge asset={pendingTx.sourceAsset} />
          <span data-testid="relay-unknown-total-debited">
            {totalDebitedParts.whole}.{totalDebitedParts.fracPrimary}<span class="lt-amount-tail"
              >{totalDebitedParts.fracTail}</span
            >
            {pendingTx.sourceAsset}
          </span>
        </dd>
      </div>
      <div>
        <dt>Network fee</dt>
        <dd class="lt-amount">
          <span data-testid="relay-unknown-fee">
            {totalFeeParts.whole}.{totalFeeParts.fracPrimary}<span class="lt-amount-tail"
              >{totalFeeParts.fracTail}</span
            >
            {pendingTx.feeAsset}
          </span>
        </dd>
      </div>
      <div>
        <dt>Active node</dt>
        <dd class="lt-hash-short" data-testid="relay-unknown-node-host">
          <bdi>{pendingTx.nodeHost}</bdi>
        </dd>
      </div>
      <div>
        <dt>Transaction hash{pendingTx.txs.length > 1 ? "es" : ""}</dt>
        <dd class="lt-stack">
          {#each pendingTx.txs as part (part.hash)}
            <div class="lt-sync-row">
              <code class="lt-hash" data-testid="relay-unknown-tx-hash"><bdi>{part.hash}</bdi></code>
              {#if part.outcome}
                <span class="lt-tx-badge lt-tx-pending">{part.outcome}</span>
              {/if}
            </div>
          {/each}
        </dd>
      </div>
    </dl>

    <div class="lt-form-actions">
      <button
        type="button"
        class="lt-btn lt-btn-primary"
        disabled={busy || !canRetryUnknown}
        onclick={() => onConfirmRelay(pendingTx.token)}
        data-testid="retry-exact-relay-btn"
      >
        {busy ? "Retrying exact transaction..." : "Retry exact prepared transaction"}
      </button>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        disabled={busy}
        onclick={() => onDiscard(pendingTx.token, true)}
        data-testid="discard-and-sync-btn"
      >
        Discard &amp; sync to verify
      </button>
    </div>
  </section>
{:else}
  <section class="lt-review-box lt-stack" data-testid="tx-review-panel">
    <div class="lt-panel-header">
      <div>
        <h2 class="lt-panel-title" data-testid="review-title">Review {kindLabel}</h2>
        <p class="lt-panel-subtitle">
          Verify every recipient address chunk, exact 12-decimal amount, fee, and node hostname
          before relaying.
        </p>
      </div>
      <span class="lt-tx-badge lt-tx-locked" data-testid="review-priority-badge">
        Priority: {pendingTx.priority}
      </span>
    </div>

    {#if errorMessage}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="relay-review-error">
        <div class="lt-alert-body"><bdi>{errorMessage}</bdi></div>
      </div>
    {/if}

    {#if prStatus && pendingTx.pricingRecordHeight !== null}
      <div
        class={prStatus.expired
          ? "lt-callout lt-callout-danger"
          : prStatus.blocksRemaining <= 3
            ? "lt-callout lt-callout-warning"
            : "lt-callout lt-callout-info"}
        data-testid="pricing-record-countdown"
      >
        <div class="lt-sync-row">
          <span class="lt-callout-title">
            10-block pricing record validity window
          </span>
          <span class="lt-hash-short" data-testid="pricing-blocks-remaining">
            {prStatus.blocksRemaining} / {PRICING_RECORD_VALIDITY_BLOCKS} blocks remaining
          </span>
        </div>
        <progress
          class="lt-progress"
          value={prStatus.blocksRemaining}
          max={PRICING_RECORD_VALIDITY_BLOCKS}
        ></progress>
        <p class="lt-compact">
          Pricing record height:
          <strong class="lt-num" data-testid="review-pricing-height"
            >#{pendingTx.pricingRecordHeight}</strong
          >
          · Current daemon height:
          <strong class="lt-num" data-testid="review-daemon-height"
            >#{effectiveDaemonHeight}</strong
          >
          · Expires at height <strong class="lt-num">#{prStatus.expiresAtHeight}</strong>
        </p>
        {#if prStatus.expired}
          <p class="lt-field-error" data-testid="pricing-record-expired-alert">
            Pricing record has aged {prStatus.ageBlocks} blocks (limit: {PRICING_RECORD_VALIDITY_BLOCKS}).
            Discard and prepare again with the latest block pricing record.
          </p>
        {/if}
      </div>
    {/if}

    <div class="lt-stack" data-testid="review-destinations-list">
      {#each pendingTx.destinations as dest, idx (idx)}
        {@const destParts = formatAtomicParts(BigInt(dest.amount), 4)}
        <div class="lt-panel lt-stack" data-testid={`review-destination-${idx}`}>
          <div class="lt-sync-row">
            <span class="lt-label">
              {pendingTx.kind === "conversion"
                ? "Settlement address"
                : `Recipient #${idx + 1}`}
            </span>
            <span class="lt-amount" data-testid={`review-dest-amount-${idx}`}>
              <AssetBadge asset={pendingTx.sourceAsset} />
              <span>
                {destParts.whole}.{destParts.fracPrimary}<span class="lt-amount-tail"
                  >{destParts.fracTail}</span
                >
                {pendingTx.sourceAsset}
              </span>
            </span>
          </div>
          <AddressChunks
            address={dest.address}
            label={`Verify 98-char address (first & last 6 highlighted)`}
            testId={`review-dest-address-${idx}`}
          />
        </div>
      {/each}
    </div>

    <dl class="lt-kv" data-testid="review-amounts-table">
      <div>
        <dt>{pendingTx.kind === "conversion" ? "Amount burnt (input)" : "Amount sent"}</dt>
        <dd class="lt-amount">
          <AssetBadge asset={pendingTx.sourceAsset} />
          <span data-testid="review-total-amount">
            {totalAmountParts.whole}.{totalAmountParts.fracPrimary}<span class="lt-amount-tail"
              >{totalAmountParts.fracTail}</span
            >
            {pendingTx.sourceAsset}
          </span>
        </dd>
      </div>

      {#if mintedParts}
        <div>
          <dt>Exact amount minted (output)</dt>
          <dd class="lt-amount">
            <AssetBadge asset={pendingTx.destinationAsset} />
            <span data-testid="review-amount-minted">
              {mintedParts.whole}.{mintedParts.fracPrimary}<span class="lt-amount-tail"
                >{mintedParts.fracTail}</span
              >
              {pendingTx.destinationAsset}
            </span>
          </dd>
        </div>
      {/if}

      <div>
        <dt>Network fee</dt>
        <dd class="lt-amount">
          <AssetBadge asset={pendingTx.feeAsset} />
          <span data-testid="review-total-fee">
            {totalFeeParts.whole}.{totalFeeParts.fracPrimary}<span class="lt-amount-tail"
              >{totalFeeParts.fracTail}</span
            >
            {pendingTx.feeAsset}
          </span>
        </dd>
      </div>

      <div>
        <dt>Total debited</dt>
        <dd class="lt-amount">
          <AssetBadge asset={pendingTx.sourceAsset} />
          <strong data-testid="review-total-debited">
            {totalDebitedParts.whole}.{totalDebitedParts.fracPrimary}<span class="lt-amount-tail"
              >{totalDebitedParts.fracTail}</span
            >
            {pendingTx.sourceAsset}
          </strong>
        </dd>
      </div>

      <div>
        <dt>Active node hostname</dt>
        <dd class="lt-hash-short" data-testid="review-node-host">
          <bdi>{pendingTx.nodeHost}</bdi>
        </dd>
      </div>

      <div>
        <dt>Prepared transaction{pendingTx.txs.length > 1 ? `s (${pendingTx.txs.length})` : ""}</dt>
        <dd class="lt-stack">
          {#each pendingTx.txs as part (part.hash)}
            <code class="lt-hash" data-testid="review-tx-hash"><bdi>{part.hash}</bdi></code>
          {/each}
        </dd>
      </div>
    </dl>

    <div class="lt-form-actions">
      <button
        type="button"
        class="lt-btn lt-btn-primary"
        disabled={busy || isExpiredConversion}
        onclick={() => onConfirmRelay(pendingTx.token)}
        data-testid="confirm-relay-btn"
      >
        {busy ? "Relaying & saving state..." : "Confirm & Relay"}
      </button>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        disabled={busy}
        onclick={() => onDiscard(pendingTx.token, false)}
        data-testid="discard-prepared-btn"
      >
        {isExpiredConversion ? "Discard & Re-prepare" : "Cancel"}
      </button>
    </div>
  </section>
{/if}
