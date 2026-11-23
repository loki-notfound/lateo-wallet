<script lang="ts">
  import type { SubaddressDto, WalletClient } from "@lateo-wallet/core/rpc";
  import AddressChunks from "./AddressChunks.svelte";
  import QrCode from "./QrCode.svelte";

  interface Props {
    client: WalletClient;
  }

  let { client }: Props = $props();

  let subaddresses = $state<readonly SubaddressDto[]>([]);
  let selectedIndex = $state(0);
  let newLabel = $state("");
  let editingIndex = $state<number | null>(null);
  let editLabelText = $state("");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const selectedSub = $derived(
    subaddresses.find((s) => s.index === selectedIndex) ?? subaddresses[0] ?? null
  );

  async function loadSubaddresses(): Promise<void> {
    errorMsg = null;
    try {
      const list = await client.listSubaddresses();
      subaddresses = list;
      if (!list.some((s) => s.index === selectedIndex)) {
        selectedIndex = list.length > 1 ? list[list.length - 1]!.index : 0;
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to load subaddresses";
    }
  }

  $effect(() => {
    void loadSubaddresses();
  });

  async function handleCreateSubaddress(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    busy = true;
    try {
      const created = await client.createSubaddress(newLabel.trim());
      newLabel = "";
      subaddresses = await client.listSubaddresses();
      selectedIndex = created.index;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to create subaddress";
    } finally {
      busy = false;
    }
  }

  function startEditLabel(sub: SubaddressDto): void {
    editingIndex = sub.index;
    editLabelText = sub.label;
  }

  async function saveEditLabel(event: SubmitEvent, index: number): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    busy = true;
    try {
      subaddresses = await client.setSubaddressLabel(index, editLabelText.trim());
      editingIndex = null;
      editLabelText = "";
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to update subaddress label";
    } finally {
      busy = false;
    }
  }
</script>

<div class="lt-stack" data-testid="receive-view">
  {#if errorMsg}
    <div class="lt-alert lt-alert-danger" role="alert" data-testid="receive-error">
      <div class="lt-alert-body">{errorMsg}</div>
    </div>
  {/if}

  {#if selectedSub}
    <section class="lt-panel lt-stack" data-testid="receive-active-card">
      <div class="lt-panel-header">
        <div>
          <h2 class="lt-panel-title">
            {selectedSub.index === 0 ? "Primary address (#0)" : `Subaddress #${selectedSub.index}`}
          </h2>
          <p class="lt-panel-subtitle">
            Subaddresses unlink incoming payments from your primary address on-chain.
          </p>
        </div>
        {#if selectedSub.label}
          <span class="lt-tx-badge" data-testid="selected-subaddress-label">
            <bdi>{selectedSub.label}</bdi>
          </span>
        {/if}
      </div>

      <div class="lt-receive-grid">
        <QrCode
          value={selectedSub.address}
          label={`QR code for subaddress #${selectedSub.index}`}
        />
        <AddressChunks
          address={selectedSub.address}
          label={selectedSub.index === 0 ? "Primary address (#0)" : `Subaddress #${selectedSub.index}`}
          testId="receive-selected-address"
        />
      </div>
    </section>
  {/if}

  <section class="lt-panel lt-stack">
    <div class="lt-panel-header">
      <h2 class="lt-panel-title">Subaddresses</h2>
    </div>

    <form onsubmit={handleCreateSubaddress} class="lt-input-group">
      <label class="lt-sr-only" for="new-subaddress-label">New subaddress label</label>
      <input
        id="new-subaddress-label"
        class="lt-input"
        type="text"
        bind:value={newLabel}
        placeholder="Optional label (e.g. Donations, Exchange)"
        maxlength="120"
        autocomplete="off"
        disabled={busy}
        data-testid="new-subaddress-label"
      />
      <button
        type="submit"
        class="lt-btn lt-btn-primary"
        disabled={busy}
        data-testid="create-subaddress-btn"
      >
        {busy ? "Saving..." : "New subaddress"}
      </button>
    </form>

    <div class="lt-subaddress-list" data-testid="subaddress-list">
      {#each subaddresses as sub (sub.index)}
        <div
          class={sub.index === selectedSub?.index
            ? "lt-subaddress-row lt-subaddress-row-active"
            : "lt-subaddress-row"}
          data-subaddress-index={sub.index}
        >
          <div class="lt-stack">
            <div class="lt-meta-pills">
              <strong class="lt-num">#{sub.index}</strong>
              <span data-testid={`subaddress-label-${sub.index}`}>
                <bdi>{sub.label || (sub.index === 0 ? "Primary account" : "Unlabeled")}</bdi>
              </span>
              {#if sub.isUsed}
                <span class="lt-tx-badge">Used</span>
              {/if}
            </div>
            <span class="lt-addr-short">
              <bdi>{sub.address.slice(0, 12)}…{sub.address.slice(-8)}</bdi>
            </span>

            {#if editingIndex === sub.index}
              <form onsubmit={(e) => saveEditLabel(e, sub.index)} class="lt-input-group">
                <input
                  class="lt-input"
                  type="text"
                  bind:value={editLabelText}
                  maxlength="120"
                  autocomplete="off"
                  disabled={busy}
                  data-testid={`edit-label-input-${sub.index}`}
                />
                <button
                  type="submit"
                  class="lt-btn lt-btn-primary"
                  disabled={busy}
                  data-testid={`save-label-btn-${sub.index}`}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="lt-btn lt-btn-secondary"
                  onclick={() => (editingIndex = null)}
                >
                  Cancel
                </button>
              </form>
            {/if}
          </div>

          <div class="lt-meta-pills">
            <button
              type="button"
              class="lt-btn lt-btn-secondary"
              onclick={() => (selectedIndex = sub.index)}
              data-testid={`select-subaddress-${sub.index}`}
            >
              Show
            </button>
            <button
              type="button"
              class="lt-btn lt-btn-quiet"
              onclick={() => startEditLabel(sub)}
              data-testid={`edit-subaddress-${sub.index}`}
            >
              Rename
            </button>
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>
