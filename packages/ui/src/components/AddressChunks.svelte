<script lang="ts">
  interface Props {
    address: string;
    label?: string;
    testId?: string;
  }

  let { address, label = "Primary address", testId = "primary-address" }: Props = $props();
  let copied = $state(false);

  const chunks = $derived.by(() => {
    const out: string[] = [];
    for (let i = 0; i < address.length; i += 6) {
      out.push(address.slice(i, i + 6));
    }
    return out;
  });

  async function copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      copied = false;
    }
  }
</script>

<div class="lt-address-box">
  <div class="lt-address-bar">
    <span class="lt-label">{label}</span>
    <div class="lt-copy-wrap">
      {#if copied}
        <span class="lt-copy-status" role="status">Copied</span>
      {/if}
      <button type="button" class="lt-copy-btn" onclick={copyAddress}>Copy</button>
    </div>
  </div>
  <div class="lt-addr-chunks" data-testid={testId}>
    {#each chunks as chunk, idx (idx)}
      <span
        class={idx === 0 || idx === chunks.length - 1 ? "lt-addr-head" : "lt-addr-body"}
      >
        <bdi>{chunk}</bdi>
      </span>
    {/each}
  </div>
</div>
