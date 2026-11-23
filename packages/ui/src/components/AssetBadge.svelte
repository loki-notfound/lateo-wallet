<script lang="ts">
  import { describeAsset } from "@lateo-wallet/core/assets";

  interface Props {
    asset: string;
  }

  let { asset }: Props = $props();
  const info = $derived(describeAsset(asset));
</script>

<span class={`lt-asset-badge ${info.cssClass}`.trim()} title={info.name}>
  <span><bdi>{info.code}</bdi></span>
</span>
