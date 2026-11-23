<script lang="ts">
  import { V2_ASSET_CODES, formatAtomicParts } from "@lateo-wallet/core/assets";
  import type { ProofKind, WalletClient, WalletTxDto } from "@lateo-wallet/core/rpc";
  import AssetBadge from "./AssetBadge.svelte";

  const PAGE_SIZE = 20;

  interface Props {
    client: WalletClient;
    walletHeight: number;
    viewOnly: boolean;
  }

  let { client, walletHeight, viewOnly }: Props = $props();

  let txs = $state<readonly WalletTxDto[]>([]);
  let assetFilter = $state<string>("ALL");
  let directionFilter = $state<"ALL" | "incoming" | "outgoing" | "conversion">("ALL");
  let page = $state(1);
  let loading = $state(false);
  let poolBusy = $state(false);
  let poolNote = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let selectedTx = $state<WalletTxDto | null>(null);

  // Proof export state
  let proofKind = $state<ProofKind>("tx_key");
  let proofAddress = $state("");
  let proofMessage = $state("");
  let proofOutput = $state<string | null>(null);
  let proofError = $state<string | null>(null);
  let proofBusy = $state(false);

  const filteredTxs = $derived.by(() => {
    return txs.filter((tx) => {
      if (assetFilter !== "ALL") {
        const hasAsset =
          tx.incomingTransfers.some((t) => t.asset === assetFilter) ||
          tx.outgoingTransfer?.asset === assetFilter ||
          tx.conversion?.sourceAsset === assetFilter ||
          tx.conversion?.destinationAsset === assetFilter;
        if (!hasAsset) return false;
      }
      if (directionFilter === "conversion") {
        return tx.conversion !== null;
      }
      if (directionFilter === "incoming") {
        return tx.conversion === null && tx.incomingTransfers.length > 0 && tx.outgoingTransfer === null;
      }
      if (directionFilter === "outgoing") {
        return tx.conversion === null && tx.outgoingTransfer !== null;
      }
      return true;
    });
  });

  const totalPages = $derived(Math.max(1, Math.ceil(filteredTxs.length / PAGE_SIZE)));
  const pagedTxs = $derived(filteredTxs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));

  async function loadHistory(): Promise<void> {
    loading = true;
    errorMsg = null;
    try {
      txs = await client.getHistory();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to load transaction history";
    } finally {
      loading = false;
    }
  }

  // Load history on mount and whenever walletHeight advances (never tight-polled)
  $effect(() => {
    void walletHeight;
    void loadHistory();
  });

  async function handleRefreshPool(): Promise<void> {
    poolBusy = true;
    errorMsg = null;
    poolNote = null;
    try {
      const res = await client.refreshPool();
      txs = res.txs;
      poolNote =
        res.poolCount === 0
          ? "Mempool checked — no incoming unconfirmed transactions."
          : `Mempool checked — ${res.poolCount} incoming pending transaction(s) found.`;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Mempool refresh failed";
    } finally {
      poolBusy = false;
    }
  }

  function openTxDetail(tx: WalletTxDto): void {
    selectedTx = tx;
    proofOutput = null;
    proofError = null;
    proofMessage = "";
    proofAddress = tx.outgoingTransfer?.destinations?.[0]?.address ?? "";
    proofKind = tx.outgoingTransfer && !viewOnly ? "tx_key" : "tx_proof";
  }

  async function handleExportProof(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!selectedTx) return;
    proofBusy = true;
    proofError = null;
    proofOutput = null;
    try {
      proofOutput = await client.exportTxProof({
        kind: proofKind,
        txHash: selectedTx.hash,
        ...(proofKind === "tx_proof" ? { address: proofAddress.trim() } : {}),
        ...(proofKind !== "tx_key" && proofMessage.trim()
          ? { message: proofMessage.trim() }
          : {})
      });
    } catch (err) {
      proofError = err instanceof Error ? err.message : "Could not generate proof";
    } finally {
      proofBusy = false;
    }
  }

  function formatUtc(ts: number | null): string {
    if (!ts) return "Pending";
    return `${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }

  function txPrimaryAsset(tx: WalletTxDto): string {
    return (
      tx.conversion?.sourceAsset ??
      tx.outgoingTransfer?.asset ??
      tx.incomingTransfers[0]?.asset ??
      "ZPH"
    );
  }

  function txPrimaryAmount(tx: WalletTxDto): { readonly sign: "+" | "-" | "↔"; readonly atomic: bigint } {
    if (tx.conversion) {
      return { sign: "↔", atomic: BigInt(tx.conversion.sourceAmount) };
    }
    if (tx.outgoingTransfer) {
      return { sign: "-", atomic: BigInt(tx.outgoingTransfer.amount) };
    }
    const incomingSum = tx.incomingTransfers.reduce((acc, t) => acc + BigInt(t.amount), 0n);
    return { sign: "+", atomic: incomingSum };
  }
</script>

<div class="lt-stack" data-testid="history-view">
  <section class="lt-panel lt-stack">
    <div class="lt-panel-header">
      <div>
        <h2 class="lt-panel-title">Transaction history</h2>
        <p class="lt-panel-subtitle">Read from encrypted local sync cache.</p>
      </div>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        disabled={loading}
        onclick={loadHistory}
        data-testid="history-reload-btn"
      >
        {loading ? "Loading..." : "Reload"}
      </button>
    </div>

    <div class="lt-callout lt-callout-info">
      <div class="lt-sync-row">
        <p class="lt-compact">
          <strong>Mempool privacy note:</strong> Checking pending mempool transactions queries the
          active remote node for unconfirmed pool hashes not yet recorded locally.
        </p>
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          disabled={poolBusy}
          onclick={handleRefreshPool}
          data-testid="refresh-pool-btn"
        >
          {poolBusy ? "Checking mempool..." : "Check pending mempool"}
        </button>
      </div>
    </div>

    {#if poolNote}
      <div class="lt-alert lt-alert-info" role="status" data-testid="pool-status-note">
        <div class="lt-alert-body">{poolNote}</div>
      </div>
    {/if}

    {#if errorMsg}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="history-error">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    <div class="lt-filter-bar">
      <label class="lt-sr-only" for="history-asset-filter">Filter by asset</label>
      <select
        id="history-asset-filter"
        class="lt-select"
        bind:value={assetFilter}
        onchange={() => (page = 1)}
        data-testid="history-asset-filter"
      >
        <option value="ALL">All assets</option>
        {#each V2_ASSET_CODES as code (code)}
          <option value={code}>{code}</option>
        {/each}
      </select>

      <label class="lt-sr-only" for="history-dir-filter">Filter by direction</label>
      <select
        id="history-dir-filter"
        class="lt-select"
        bind:value={directionFilter}
        onchange={() => (page = 1)}
        data-testid="history-dir-filter"
      >
        <option value="ALL">All types</option>
        <option value="incoming">Incoming</option>
        <option value="outgoing">Outgoing</option>
        <option value="conversion">Conversions</option>
      </select>
    </div>

    {#if pagedTxs.length === 0}
      <p class="lt-muted" data-testid="history-empty">
        No transactions match the current filter.
      </p>
    {:else}
      <div class="lt-tx-list" data-testid="history-tx-list">
        {#each pagedTxs as tx (tx.hash)}
          {@const asset = txPrimaryAsset(tx)}
          {@const amt = txPrimaryAmount(tx)}
          {@const parts = formatAtomicParts(amt.atomic, 4)}
          <button
            type="button"
            class="lt-tx-row"
            onclick={() => openTxDetail(tx)}
            data-testid={`tx-row-${tx.hash.slice(0, 12)}`}
          >
            <div class="lt-stack">
              <div class="lt-meta-pills">
                <AssetBadge {asset} />
                {#if tx.isFailed}
                  <span class="lt-tx-badge lt-tx-failed">Failed</span>
                {:else if tx.inPool}
                  <span class="lt-tx-badge lt-tx-pending">Pending (mempool)</span>
                {:else if tx.isLocked}
                  <span class="lt-tx-badge lt-tx-locked">Locked ({tx.confirmations}/10)</span>
                {:else if tx.conversion}
                  <span class="lt-tx-badge lt-tx-pending">
                    Convert ({tx.conversion.sourceAsset} → {tx.conversion.destinationAsset})
                  </span>
                {:else}
                  <span class="lt-tx-badge lt-tx-confirmed">
                    {tx.outgoingTransfer ? "Sent" : "Received"} · {tx.confirmations} conf
                  </span>
                {/if}
              </div>
              <span class="lt-addr-short">
                <bdi>{tx.hash.slice(0, 14)}…{tx.hash.slice(-10)}</bdi> · {formatUtc(tx.timestamp)}
              </span>
            </div>

            <div class={amt.sign === "+" ? "lt-amount lt-amount-pos" : "lt-amount lt-amount-neg"}>
              <span class="lt-amount-sign">{amt.sign}</span>{parts.whole}.{parts.fracPrimary}<span
                class="lt-amount-tail">{parts.fracTail}</span
              ><span class="lt-amount-ticker">{asset}</span>
            </div>
          </button>
        {/each}
      </div>

      {#if totalPages > 1}
        <div class="lt-sync-row">
          <button
            type="button"
            class="lt-btn lt-btn-secondary"
            disabled={page <= 1}
            onclick={() => (page -= 1)}
          >
            Previous
          </button>
          <span class="lt-compact lt-num">Page {page} of {totalPages}</span>
          <button
            type="button"
            class="lt-btn lt-btn-secondary"
            disabled={page >= totalPages}
            onclick={() => (page += 1)}
          >
            Next
          </button>
        </div>
      {/if}
    {/if}
  </section>

  {#if selectedTx}
    <section class="lt-panel lt-stack" data-testid="tx-detail-panel">
      <div class="lt-panel-header">
        <h3 class="lt-panel-title">Transaction details</h3>
        <button
          type="button"
          class="lt-btn lt-btn-quiet"
          onclick={() => (selectedTx = null)}
        >
          Close
        </button>
      </div>

      <dl class="lt-diag-list">
        <div class="lt-diag-item">
          <dt>Transaction ID</dt>
          <dd><bdi>{selectedTx.hash}</bdi></dd>
        </div>
        <div class="lt-diag-item">
          <dt>Height / Confirmations</dt>
          <dd>{selectedTx.height ?? "Mempool"} ({selectedTx.confirmations} conf)</dd>
        </div>
        <div class="lt-diag-item">
          <dt>Timestamp</dt>
          <dd>{formatUtc(selectedTx.timestamp)}</dd>
        </div>
        {#if selectedTx.fee}
          {@const feeParts = formatAtomicParts(BigInt(selectedTx.fee), 12)}
          <div class="lt-diag-item">
            <dt>Network fee</dt>
            <dd>
              {feeParts.full} {selectedTx.feeAsset ?? ""}
            </dd>
          </div>
        {/if}
      </dl>

      {#if selectedTx.conversion}
        {@const srcP = formatAtomicParts(BigInt(selectedTx.conversion.sourceAmount), 12)}
        {@const dstP = formatAtomicParts(BigInt(selectedTx.conversion.destinationAmount), 12)}
        <div class="lt-review-box">
          <strong>Protocol conversion</strong>
          <p class="lt-amount">
            -{srcP.full} {selectedTx.conversion.sourceAsset} → +{dstP.full}
            {selectedTx.conversion.destinationAsset}
          </p>
        </div>
      {/if}

      <!-- Payment Proof / Tx Key Export -->
      <form onsubmit={handleExportProof} class="lt-stack">
        <h4 class="lt-panel-title">Export payment proof or transaction key</h4>
        <div class="lt-field">
          <label class="lt-label" for="proof-kind-select">Proof type</label>
          <select id="proof-kind-select" class="lt-select" bind:value={proofKind}>
            <option value="tx_key">Transaction secret key (sender cache)</option>
            <option value="tx_proof">Payment proof (OutProofV2 / InProofV2)</option>
            {#if !viewOnly}
              <option value="spend_proof">Spend proof (SpendProofV1)</option>
            {/if}
          </select>
        </div>

        {#if proofKind === "tx_proof"}
          <div class="lt-field">
            <label class="lt-label" for="proof-address-input">Address</label>
            <input
              id="proof-address-input"
              class="lt-input"
              type="text"
              bind:value={proofAddress}
              autocomplete="off"
              spellcheck="false"
              required
            />
          </div>
        {/if}

        {#if proofKind !== "tx_key"}
          <div class="lt-field">
            <label class="lt-label" for="proof-msg-input">Optional message</label>
            <input
              id="proof-msg-input"
              class="lt-input"
              type="text"
              bind:value={proofMessage}
              autocomplete="off"
            />
          </div>
        {/if}

        <div class="lt-form-actions">
          <button type="submit" class="lt-btn lt-btn-secondary" disabled={proofBusy}>
            {proofBusy ? "Generating..." : "Export"}
          </button>
        </div>

        {#if proofError}
          <div class="lt-alert lt-alert-danger" role="alert">
            <div class="lt-alert-body">{proofError}</div>
          </div>
        {/if}
        {#if proofOutput}
          <div class="lt-secret-box">
            <span class="lt-label">Generated proof / key</span>
            <div class="lt-secret-key"><bdi>{proofOutput}</bdi></div>
          </div>
        {/if}
      </form>
    </section>
  {/if}
</div>
