<script lang="ts">
  import { formatAtomicParts } from "@lateo-wallet/core/assets";
  import type {
    HostDiagnosticsDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import AssetBadge from "./AssetBadge.svelte";
  import type { SurfaceMode } from "../types.js";

  interface Props {
    client: WalletClient;
    surface: SurfaceMode;
    onOpenFullTab?: () => void;
    onOpenSidePanel?: () => void;
  }

  let { client, surface, onOpenFullTab, onOpenSidePanel }: Props = $props();

  let snapshot = $state<WalletSnapshot | null>(null);
  let diagnostics = $state<HostDiagnosticsDto | null>(null);
  let password = $state("");
  let walletName = $state("Disposable Spike Wallet");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const surfaceClass = $derived(`lt-app-shell lt-ext-surface-${surface}`);
  const addressChunks = $derived.by(() => {
    const addr = snapshot?.activeWallet?.primaryAddress ?? "";
    const chunks: string[] = [];
    for (let i = 0; i < addr.length; i += 6) {
      chunks.push(addr.slice(i, i + 6));
    }
    return chunks;
  });

  async function refresh(): Promise<void> {
    try {
      const [snap, diag] = await Promise.all([
        client.getSnapshot(),
        client.getDiagnostics()
      ]);
      snapshot = snap;
      diagnostics = diag;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to load wallet state";
    }
  }

  $effect(() => {
    void refresh();
    const unsub = client.subscribe((next) => {
      snapshot = next;
    });
    return () => {
      unsub();
    };
  });

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    busy = true;
    try {
      snapshot = await client.createDisposableWallet({
        password,
        name: walletName,
        network: "mainnet"
      });
      password = "";
      diagnostics = await client.getDiagnostics();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Wallet creation failed";
    } finally {
      busy = false;
    }
  }

  async function handleUnlock(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    busy = true;
    try {
      snapshot = await client.unlockWallet(password);
      password = "";
      diagnostics = await client.getDiagnostics();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Unlock failed";
    } finally {
      busy = false;
    }
  }

  async function handleLock(): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      snapshot = await client.lockWallet();
      diagnostics = await client.getDiagnostics();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Lock failed";
    } finally {
      busy = false;
    }
  }

  async function handleReset(): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      snapshot = await client.resetVault();
      diagnostics = await client.getDiagnostics();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Vault reset failed";
    } finally {
      busy = false;
    }
  }
</script>

<div class={surfaceClass} data-surface={surface}>
  <header class="lt-app-topbar">
    <span class="lt-app-brand">Lateo Wallet</span>
    <div class="lt-app-topbar-actions">
      {#if surface === "popup" && onOpenSidePanel}
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          onclick={onOpenSidePanel}
        >
          Side panel
        </button>
      {/if}
      {#if surface !== "tab" && onOpenFullTab}
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          onclick={onOpenFullTab}
        >
          Full tab
        </button>
      {/if}
      {#if snapshot && !snapshot.locked}
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          disabled={busy}
          onclick={handleLock}
          data-testid="lock-btn"
        >
          Lock
        </button>
      {/if}
    </div>
  </header>

  <main class="lt-app-main">
    {#if errorMsg}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="error-banner">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    {#if snapshot?.savingState}
      <div class="lt-alert lt-alert-info" role="status" data-testid="saving-banner">
        <div class="lt-alert-body">Saving wallet state...</div>
      </div>
    {/if}

    {#if !snapshot}
      <section class="lt-panel">
        <p class="lt-muted">Connecting to wallet engine...</p>
      </section>
    {:else if !snapshot.hasVault}
      <section class="lt-panel">
        <div class="lt-panel-header">
          <h1 class="lt-panel-title">Create disposable wallet (M1.1 spike)</h1>
        </div>
        <form onsubmit={handleCreate} class="lt-stack">
          <div class="lt-field">
            <label class="lt-label" for="wallet-name">Wallet name</label>
            <input
              id="wallet-name"
              class="lt-input"
              type="text"
              bind:value={walletName}
              autocomplete="off"
              required
            />
          </div>
          <div class="lt-field">
            <label class="lt-label" for="vault-password">Vault password (min. 8 chars)</label>
            <input
              id="vault-password"
              class="lt-input"
              type="password"
              bind:value={password}
              autocomplete="new-password"
              minlength="8"
              required
              data-testid="password-input"
            />
          </div>
          <div class="lt-form-actions">
            <button
              type="submit"
              class="lt-btn lt-btn-primary"
              disabled={busy}
              data-testid="create-btn"
            >
              {busy ? "Creating..." : "Create random wallet"}
            </button>
          </div>
        </form>
      </section>
    {:else if snapshot.locked}
      <section class="lt-panel">
        <div class="lt-panel-header">
          <h1 class="lt-panel-title">Vault locked</h1>
        </div>
        <form onsubmit={handleUnlock} class="lt-stack">
          <div class="lt-field">
            <label class="lt-label" for="unlock-password">Vault password</label>
            <input
              id="unlock-password"
              class="lt-input"
              type="password"
              bind:value={password}
              autocomplete="current-password"
              required
              data-testid="password-input"
            />
          </div>
          <div class="lt-form-actions">
            <button
              type="submit"
              class="lt-btn lt-btn-primary"
              disabled={busy}
              data-testid="unlock-btn"
            >
              {busy ? "Unlocking..." : "Unlock offline"}
            </button>
            <button
              type="button"
              class="lt-btn lt-btn-danger"
              disabled={busy}
              onclick={handleReset}
              data-testid="reset-btn"
            >
              Reset vault
            </button>
          </div>
        </form>
      </section>
    {:else if snapshot.activeWallet}
      <section class="lt-panel lt-stack" data-testid="wallet-unlocked">
        <div class="lt-panel-header">
          <div>
            <h1 class="lt-panel-title"><bdi>{snapshot.activeWallet.name}</bdi></h1>
            <p class="lt-panel-subtitle">
              Network: {snapshot.activeWallet.network} · Restore height:
              <span class="lt-num">{snapshot.activeWallet.restoreHeight}</span>
            </p>
          </div>
        </div>

        <div class="lt-address-box">
          <span class="lt-label">Primary address</span>
          <div class="lt-addr-chunks" data-testid="primary-address">
            {#each addressChunks as chunk, idx (idx)}
              <span
                class={idx === 0 || idx === addressChunks.length - 1
                  ? "lt-addr-head"
                  : "lt-addr-body"}
              >
                <bdi>{chunk}</bdi>
              </span>
            {/each}
          </div>
        </div>

        <div class="lt-balance-secondary-grid">
          {#each snapshot.balances as bal (bal.asset)}
            {@const parts = formatAtomicParts(BigInt(bal.unlocked), 4)}
            <div class="lt-balance-card">
              <div class="lt-balance-label">
                <AssetBadge asset={bal.asset} />
                <span>Unlocked</span>
              </div>
              <div class="lt-amount lt-amount-lg">
                {parts.whole}.{parts.fracPrimary}<span class="lt-amount-tail"
                  >{parts.fracTail}</span
                ><span class="lt-amount-ticker">{bal.asset}</span>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if diagnostics}
      <section class="lt-panel" data-testid="diagnostics-panel">
        <div class="lt-panel-header">
          <h2 class="lt-panel-title">MV3 runtime diagnostics</h2>
        </div>
        <dl class="lt-diag-list">
          <div class="lt-diag-item">
            <dt>Host kind</dt>
            <dd data-testid="diag-host-kind">{diagnostics.hostKind}</dd>
          </div>
          <div class="lt-diag-item">
            <dt>Offscreen exists</dt>
            <dd data-testid="diag-offscreen">{String(diagnostics.offscreenExists)}</dd>
          </div>
          <div class="lt-diag-item">
            <dt>Keep-alive active</dt>
            <dd data-testid="diag-keepalive">{String(diagnostics.keepAliveActive)}</dd>
          </div>
          <div class="lt-diag-item">
            <dt>Default node permission</dt>
            <dd data-testid="diag-node-perm">
              {String(diagnostics.defaultNodeHostPermissionGranted)}
            </dd>
          </div>
        </dl>
      </section>
    {/if}
  </main>
</div>
