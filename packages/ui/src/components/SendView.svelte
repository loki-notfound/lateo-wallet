<script lang="ts">
  import { V2_ASSET_CODES, formatAtomicParts } from "@lateo-wallet/core/assets";
  import type {
    BalanceEntryDto,
    PreparedTxDto,
    TxPriorityDto,
    WalletClient
  } from "@lateo-wallet/core/rpc";
  import {
    MAX_TRANSFER_DESTINATIONS,
    TX_PRIORITIES,
    looksLikeZephyrAddress,
    validateTransferAmount
  } from "@lateo-wallet/core/tx";
  import AssetBadge from "./AssetBadge.svelte";

  interface Props {
    client: WalletClient;
    balances: readonly BalanceEntryDto[];
    nodeHost: string;
    viewOnly: boolean;
    disabled?: boolean;
    onPrepared: (prepared: PreparedTxDto) => void;
  }

  let {
    client,
    balances,
    nodeHost,
    viewOnly,
    disabled = false,
    onPrepared
  }: Props = $props();

  interface RecipientRow {
    id: number;
    address: string;
    amount: string;
  }

  let nextRowId = 2;
  let asset = $state<string>("ZPH");
  let sweepMode = $state(false);
  let sweepAddress = $state("");
  let priority = $state<TxPriorityDto>("default");
  let recipients = $state<RecipientRow[]>([{ id: 1, address: "", amount: "" }]);
  let preparing = $state(false);
  let formError = $state<string | null>(null);

  const selectedBalance = $derived.by(() => {
    const entry = balances.find((b) => b.asset === asset);
    return {
      unlocked: BigInt(entry?.unlocked ?? "0"),
      locked: BigInt(entry?.locked ?? "0"),
      total: BigInt(entry?.total ?? "0")
    };
  });

  const unlockedParts = $derived(formatAtomicParts(selectedBalance.unlocked, 4));

  function addRecipient(): void {
    if (recipients.length >= MAX_TRANSFER_DESTINATIONS) return;
    recipients = [...recipients, { id: nextRowId++, address: "", amount: "" }];
  }

  function removeRecipient(id: number): void {
    if (recipients.length <= 1) return;
    recipients = recipients.filter((r) => r.id !== id);
  }

  function selectTransferMode(): void {
    sweepMode = false;
    formError = null;
  }

  function selectSweepMode(): void {
    sweepMode = true;
    formError = null;
    if (!sweepAddress && recipients[0]?.address) {
      sweepAddress = recipients[0].address;
    }
  }

  async function handleSubmit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    formError = null;

    if (viewOnly) {
      formError = "View-only wallets cannot sign or send transactions";
      return;
    }

    preparing = true;
    try {
      if (sweepMode) {
        const prepared = await client.prepareSweep({
          asset,
          address: sweepAddress.trim(),
          priority
        });
        onPrepared(prepared);
      } else {
        const prepared = await client.prepareTransfer({
          asset,
          destinations: recipients.map((r) => ({
            address: r.address.trim(),
            amount: r.amount.trim()
          })),
          priority
        });
        onPrepared(prepared);
      }
    } catch (err) {
      formError = err instanceof Error ? err.message : "Failed to prepare transaction";
    } finally {
      preparing = false;
    }
  }
</script>

<section class="lt-panel lt-stack" data-testid="send-view">
  <div class="lt-panel-header">
    <div>
      <h2 class="lt-panel-title">Send or Sweep</h2>
      <p class="lt-panel-subtitle">
        Two-step build &amp; review via <span class="lt-hash-short"><bdi>{nodeHost}</bdi></span>.
        Nothing is broadcast until you confirm on the review screen.
      </p>
    </div>
    <div class="lt-meta-pills">
      <button
        type="button"
        class={!sweepMode ? "lt-btn lt-btn-primary" : "lt-btn lt-btn-secondary"}
        disabled={disabled || preparing}
        onclick={selectTransferMode}
        data-testid="send-mode-transfer"
      >
        Standard Send
      </button>
      <button
        type="button"
        class={sweepMode ? "lt-btn lt-btn-primary" : "lt-btn lt-btn-secondary"}
        disabled={disabled || preparing}
        onclick={selectSweepMode}
        data-testid="send-mode-sweep"
      >
        Max / Sweep Unlocked
      </button>
    </div>
  </div>

  {#if viewOnly}
    <div class="lt-alert lt-alert-warning" role="status" data-testid="send-view-only-notice">
      <div class="lt-alert-body">
        This is a view-only wallet. Outgoing transfers and sweeps require a full spend-key wallet.
      </div>
    </div>
  {/if}

  {#if formError}
    <div class="lt-alert lt-alert-danger" role="alert" data-testid="send-error-banner">
      <div class="lt-alert-body"><bdi>{formError}</bdi></div>
    </div>
  {/if}

  <form class="lt-stack" onsubmit={handleSubmit} data-testid="send-form">
    <div class="lt-grid lt-grid-2">
      <div class="lt-field">
        <label class="lt-label" for="send-asset-select">Asset (V2)</label>
        <select
          id="send-asset-select"
          class="lt-select"
          bind:value={asset}
          disabled={disabled || preparing || viewOnly}
          data-testid="send-asset-select"
        >
          {#each V2_ASSET_CODES as code (code)}
            <option value={code}>{code}</option>
          {/each}
        </select>
        <div class="lt-help" data-testid="send-unlocked-balance">
          Spendable unlocked:
          <strong class="lt-num">
            {unlockedParts.whole}.{unlockedParts.fracPrimary}<span class="lt-amount-tail"
              >{unlockedParts.fracTail}</span
            >
            {asset}
          </strong>
        </div>
      </div>

      <div class="lt-field">
        <label class="lt-label" for="send-priority-select">Fee priority</label>
        <select
          id="send-priority-select"
          class="lt-select"
          bind:value={priority}
          disabled={disabled || preparing || viewOnly}
          data-testid="send-priority-select"
        >
          {#each TX_PRIORITIES as p (p.value)}
            <option value={p.value}>{p.label} ({p.value})</option>
          {/each}
        </select>
      </div>
    </div>

    {#if sweepMode}
      <div class="lt-callout lt-callout-info" data-testid="sweep-mode-explainer">
        <div class="lt-sync-row">
          <span class="lt-callout-title">Sweeping all unlocked {asset}</span>
          <AssetBadge {asset} />
        </div>
        <p class="lt-compact">
          Builds and signs one or more transactions spending every unlocked {asset} output in this
          account (minus the exact network fee) to a single destination address.
        </p>
      </div>

      <div class="lt-field">
        <label class="lt-label" for="sweep-address-input">Destination address</label>
        <input
          id="sweep-address-input"
          type="text"
          class="lt-input"
          placeholder="ZEPHYR... or ZEPHs..."
          bind:value={sweepAddress}
          disabled={disabled || preparing || viewOnly}
          autocomplete="off"
          spellcheck="false"
          data-testid="sweep-address-input"
        />
        {#if sweepAddress.trim().length > 0 && !looksLikeZephyrAddress(sweepAddress)}
          <p class="lt-field-error" data-testid="sweep-address-hint">
            Enter a full 95–108 character Base58 Zephyr address starting with ZEPH.
          </p>
        {/if}
      </div>
    {:else}
      <div class="lt-stack" data-testid="send-recipients-list">
        {#each recipients as row, idx (row.id)}
          {@const amountCheck =
            row.amount.trim().length > 0 ? validateTransferAmount(row.amount) : null}
          <fieldset class="lt-fieldset lt-stack" data-testid={`recipient-row-${idx}`}>
            <div class="lt-sync-row">
              <span class="lt-label">
                Recipient #{idx + 1}
              </span>
              {#if recipients.length > 1}
                <button
                  type="button"
                  class="lt-btn lt-btn-secondary"
                  disabled={disabled || preparing || viewOnly}
                  onclick={() => removeRecipient(row.id)}
                  data-testid={`remove-recipient-${idx}`}
                >
                  Remove
                </button>
              {/if}
            </div>

            <div class="lt-field">
              <label class="lt-label" for={`send-address-${row.id}`}>
                Recipient Zephyr address
              </label>
              <input
                id={`send-address-${row.id}`}
                type="text"
                class="lt-input"
                placeholder="ZEPHYR... or ZEPHs..."
                bind:value={row.address}
                disabled={disabled || preparing || viewOnly}
                autocomplete="off"
                spellcheck="false"
                data-testid={`send-address-input-${idx}`}
              />
              {#if row.address.trim().length > 0 && !looksLikeZephyrAddress(row.address)}
                <p class="lt-field-error" data-testid={`send-address-hint-${idx}`}>
                  Enter a full Base58 Zephyr address starting with ZEPH.
                </p>
              {/if}
            </div>

            <div class="lt-field">
              <label class="lt-label" for={`send-amount-${row.id}`}>
                Amount ({asset}, up to 12 decimals)
              </label>
              <input
                id={`send-amount-${row.id}`}
                type="text"
                inputmode="decimal"
                class="lt-input"
                placeholder="0.000000000000"
                bind:value={row.amount}
                disabled={disabled || preparing || viewOnly}
                autocomplete="off"
                data-testid={`send-amount-input-${idx}`}
              />
              {#if amountCheck && !amountCheck.ok}
                <p class="lt-field-error" data-testid={`send-amount-error-${idx}`}>
                  {amountCheck.error}
                </p>
              {/if}
            </div>
          </fieldset>
        {/each}
      </div>

      {#if recipients.length < MAX_TRANSFER_DESTINATIONS}
        <div>
          <button
            type="button"
            class="lt-btn lt-btn-secondary"
            disabled={disabled || preparing || viewOnly}
            onclick={addRecipient}
            data-testid="add-recipient-btn"
          >
            + Add recipient ({recipients.length}/{MAX_TRANSFER_DESTINATIONS})
          </button>
        </div>
      {/if}
    {/if}

    <div class="lt-form-actions">
      <button
        type="submit"
        class="lt-btn lt-btn-primary"
        disabled={disabled || preparing || viewOnly}
        data-testid="prepare-send-btn"
      >
        {#if preparing}
          Preparing transaction...
        {:else if sweepMode}
          Prepare &amp; Review Sweep
        {:else}
          Prepare &amp; Review Transfer
        {/if}
      </button>
    </div>
  </form>
</section>
