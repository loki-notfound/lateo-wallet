<script lang="ts">
  import type { ReserveStatusDto } from "@lateo-wallet/core/rpc";

  interface Props {
    reserve: ReserveStatusDto | null;
    busy?: boolean;
    onRefresh: () => void;
  }

  let { reserve, busy = false, onRefresh }: Props = $props();

  const bannerClass = $derived.by(() => {
    if (!reserve) return "lt-reserve-banner";
    if (reserve.health === "healthy") return "lt-reserve-banner lt-reserve-healthy";
    if (reserve.health === "warning") return "lt-reserve-banner lt-reserve-warning";
    return "lt-reserve-banner lt-reserve-critical";
  });

  function formatRatioPercent(ratioText: string): string {
    const n = Number(ratioText);
    if (!Number.isFinite(n)) return "—";
    return `${(n * 100).toFixed(1)}% (${n.toFixed(2)}x)`;
  }
</script>

<section class={bannerClass} data-testid="reserve-banner">
  {#if !reserve}
    <div class="lt-sync-row">
      <span class="lt-compact">Reserve ratio &amp; oracle pricing load on sync.</span>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        disabled={busy}
        onclick={onRefresh}
        data-testid="reserve-refresh-btn"
      >
        Load reserve
      </button>
    </div>
  {:else}
    <div class="lt-stack">
      <div class="lt-sync-row">
        <div>
          <span class="lt-label">Reserve ratio (spot / MA)</span>
          <div class="lt-reserve-value" data-testid="reserve-ratio-value">
            {formatRatioPercent(reserve.reserveRatio)} · MA {formatRatioPercent(
              reserve.reserveRatioMa
            )}
          </div>
        </div>
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          disabled={busy}
          onclick={onRefresh}
          data-testid="reserve-refresh-btn"
        >
          Update
        </button>
      </div>

      <p class="lt-compact" data-testid="reserve-summary">{reserve.statusSummary}</p>

      {#if reserve.prices}
        <div class="lt-reserve-prices" data-testid="oracle-prices-grid">
          <div class="lt-price-cell">
            <span class="lt-price-label">ZPH / USD (spot / MA)</span>
            <span class="lt-price-val">
              ${reserve.prices.zphUsdSpot} / ${reserve.prices.zphUsdMa}
            </span>
          </div>
          <div class="lt-price-cell">
            <span class="lt-price-label">ZSD rate (spot)</span>
            <span class="lt-price-val">{reserve.prices.zsdSpot} ZPH</span>
          </div>
          <div class="lt-price-cell">
            <span class="lt-price-label">ZRS rate (spot)</span>
            <span class="lt-price-val">{reserve.prices.zrsSpot} ZPH</span>
          </div>
          <div class="lt-price-cell">
            <span class="lt-price-label">ZYS price</span>
            <span class="lt-price-val">{reserve.prices.zysPrice} ZSD</span>
          </div>
        </div>
      {/if}

      <div class="lt-meta-pills" data-testid="conversion-flags">
        <span class={reserve.conversions.mintZsd ? "lt-tx-badge lt-tx-confirmed" : "lt-tx-badge lt-tx-failed"}>
          Mint ZSD: {reserve.conversions.mintZsd ? "Open" : "Paused"}
        </span>
        <span class={reserve.conversions.redeemZsd ? "lt-tx-badge lt-tx-confirmed" : "lt-tx-badge lt-tx-failed"}>
          Redeem ZSD: {reserve.conversions.redeemZsd ? "Open" : "Paused"}
        </span>
        <span class={reserve.conversions.mintZrs ? "lt-tx-badge lt-tx-confirmed" : "lt-tx-badge lt-tx-failed"}>
          Mint ZRS: {reserve.conversions.mintZrs ? "Open" : "Paused"}
        </span>
        <span class={reserve.conversions.redeemZrs ? "lt-tx-badge lt-tx-confirmed" : "lt-tx-badge lt-tx-failed"}>
          Redeem ZRS: {reserve.conversions.redeemZrs ? "Open" : "Paused"}
        </span>
        <span class="lt-tx-badge lt-tx-confirmed">ZYS: Open</span>
      </div>
    </div>
  {/if}
</section>
