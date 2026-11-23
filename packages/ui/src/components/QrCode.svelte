<script lang="ts">
  import { encodeQrSvgData } from "@lateo-wallet/core/qr";

  interface Props {
    value: string;
    label?: string;
  }

  let { value, label = "Address QR code" }: Props = $props();
  const qr = $derived(value ? encodeQrSvgData(value, 4) : null);
</script>

{#if qr}
  <div class="lt-qr-frame" data-testid="qr-code-container">
    <svg
      class="lt-qr-svg"
      viewBox={`0 0 ${qr.viewBoxSize} ${qr.viewBoxSize}`}
      role="img"
      aria-label={label}
      data-testid="qr-code-svg"
    >
      <rect width={qr.viewBoxSize} height={qr.viewBoxSize} fill="#ffffff" />
      <path d={qr.pathData} fill="#1c1d1f" />
    </svg>
  </div>
{/if}
