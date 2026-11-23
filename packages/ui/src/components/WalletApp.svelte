<script lang="ts">
  import { formatAtomicParts } from "@lateo-wallet/core/assets";
  import type {
    CreateWalletResultDto,
    HostDiagnosticsDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import { DEFAULT_WALLET_PREFS, type WalletPrefs } from "@lateo-wallet/core/storage";
  import type { SurfaceMode } from "../types.js";
  import AddressChunks from "./AddressChunks.svelte";
  import AssetBadge from "./AssetBadge.svelte";
  import SeedBackupFlow from "./SeedBackupFlow.svelte";
  import SettingsSecurity from "./SettingsSecurity.svelte";
  import UnlockScreen from "./UnlockScreen.svelte";
  import WelcomeOnboarding from "./WelcomeOnboarding.svelte";

  interface Props {
    client: WalletClient;
    surface: SurfaceMode;
    onOpenFullTab?: () => void;
    onOpenSidePanel?: () => void;
    onThemeApplied?: (theme: WalletPrefs["theme"]) => void;
  }

  let { client, surface, onOpenFullTab, onOpenSidePanel, onThemeApplied }: Props = $props();

  let snapshot = $state<WalletSnapshot | null>(null);
  let diagnostics = $state<HostDiagnosticsDto | null>(null);
  let prefs = $state<WalletPrefs>(DEFAULT_WALLET_PREFS);
  let pendingBackup = $state<CreateWalletResultDto | null>(null);
  let activeTab = $state<"overview" | "security">("overview");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const surfaceClass = $derived(`lt-app-shell lt-ext-surface-${surface}`);

  async function refreshAll(): Promise<void> {
    try {
      const [snap, diag, loadedPrefs] = await Promise.all([
        client.getSnapshot(),
        client.getDiagnostics(),
        client.getPrefs()
      ]);
      snapshot = snap;
      diagnostics = diag;
      prefs = loadedPrefs;
      onThemeApplied?.(loadedPrefs.theme);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to connect to wallet engine";
    }
  }

  $effect(() => {
    void refreshAll();
    const unsub = client.subscribe((next) => {
      snapshot = next;
      if (next.locked) {
        pendingBackup = null;
      }
    });
    return () => {
      unsub();
    };
  });

  async function refreshDiagnostics(): Promise<void> {
    try {
      diagnostics = await client.getDiagnostics();
    } catch {
      // Non-fatal diagnostics refresh
    }
  }

  async function handleLock(): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      pendingBackup = null;
      activeTab = "overview";
      snapshot = await client.lockWallet();
      await refreshDiagnostics();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Lock failed";
    } finally {
      busy = false;
    }
  }

  function handleCreated(result: CreateWalletResultDto): void {
    snapshot = result.snapshot;
    pendingBackup = result;
    void refreshDiagnostics();
  }

  function handleRestored(nextSnap: WalletSnapshot): void {
    snapshot = nextSnap;
    pendingBackup = null;
    activeTab = "overview";
    void refreshDiagnostics();
  }

  async function handleBackupVerified(): Promise<void> {
    const updated = await client.markSeedBackupVerified();
    snapshot = updated;
    pendingBackup = null;
    activeTab = "overview";
    await refreshDiagnostics();
  }

  function handleUnlocked(nextSnap: WalletSnapshot): void {
    snapshot = nextSnap;
    activeTab = "overview";
    void refreshDiagnostics();
  }

  function handleVaultReset(nextSnap: WalletSnapshot): void {
    snapshot = nextSnap;
    pendingBackup = null;
    activeTab = "overview";
    void refreshDiagnostics();
  }

  function handlePrefsUpdated(nextPrefs: WalletPrefs): void {
    prefs = nextPrefs;
    onThemeApplied?.(nextPrefs.theme);
  }
</script>

<div class={surfaceClass} data-surface={surface}>
  <header class="lt-app-topbar lt-screen-only">
    <span class="lt-app-brand">Lateo Wallet</span>
    <div class="lt-app-topbar-actions">
      {#if surface === "popup" && onOpenSidePanel}
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          onclick={onOpenSidePanel}
          data-testid="open-panel-btn"
        >
          Side panel
        </button>
      {/if}
      {#if surface !== "tab" && onOpenFullTab}
        <button
          type="button"
          class="lt-btn lt-btn-secondary"
          onclick={onOpenFullTab}
          data-testid="open-tab-btn"
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
      <div class="lt-alert lt-alert-danger lt-screen-only" role="alert" data-testid="error-banner">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    {#if snapshot?.savingState}
      <div class="lt-alert lt-alert-info lt-screen-only" role="status" data-testid="saving-banner">
        <div class="lt-alert-body">Saving wallet state...</div>
      </div>
    {/if}

    {#if !snapshot}
      <section class="lt-panel lt-screen-only">
        <p class="lt-muted">Connecting to wallet engine...</p>
      </section>
    {:else if pendingBackup}
      <SeedBackupFlow
        seed={pendingBackup.seed}
        restoreHeight={pendingBackup.restoreHeight}
        restoreHeightSource={pendingBackup.restoreHeightSource}
        createdAt={pendingBackup.createdAt}
        {busy}
        onVerified={handleBackupVerified}
      />
    {:else if !snapshot.hasVault}
      <WelcomeOnboarding
        {client}
        onCreated={handleCreated}
        onRestored={handleRestored}
      />
    {:else if snapshot.locked}
      <UnlockScreen
        {client}
        onUnlocked={handleUnlocked}
        onReset={handleVaultReset}
      />
    {:else if snapshot.activeWallet}
      <div class="lt-stack lt-screen-only" data-testid="wallet-unlocked">
        {#if snapshot.activeWallet.viewOnly}
          <div class="lt-wallet-mode-banner" role="status" data-testid="view-only-banner">
            View-only wallet — incoming outputs only; cannot sign or spend.
          </div>
        {/if}

        <div class="lt-tabs">
          <div class="lt-tablist" role="tablist" aria-label="Wallet sections">
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "overview"}
              onclick={() => (activeTab = "overview")}
              data-testid="tab-overview"
            >
              Overview
            </button>
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "security"}
              onclick={() => (activeTab = "security")}
              data-testid="tab-security"
            >
              Security &amp; settings
            </button>
          </div>

          {#if activeTab === "overview"}
            <div class="lt-tabpanel lt-stack" role="tabpanel">
              <section class="lt-panel lt-stack">
                <div class="lt-panel-header">
                  <div>
                    <h1 class="lt-panel-title" data-testid="wallet-name">
                      <bdi>{snapshot.activeWallet.name}</bdi>
                    </h1>
                    <p class="lt-panel-subtitle">
                      Network: {snapshot.activeWallet.network} · Restore height:
                      <span class="lt-num" data-testid="wallet-restore-height"
                        >{snapshot.activeWallet.restoreHeight}</span
                      >
                    </p>
                  </div>
                  <div class="lt-meta-pills">
                    {#if snapshot.activeWallet.viewOnly}
                      <span class="lt-wallet-mode" data-testid="view-only-badge">View-only</span>
                    {:else if snapshot.activeWallet.seedBackupVerified}
                      <span class="lt-tx-badge lt-tx-confirmed" data-testid="backup-verified-badge">
                        Seed verified
                      </span>
                    {:else}
                      <span class="lt-tx-badge lt-tx-locked" data-testid="backup-unverified-badge">
                        Backup unverified
                      </span>
                    {/if}
                  </div>
                </div>

                <AddressChunks address={snapshot.activeWallet.primaryAddress} />

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
            </div>
          {:else}
            <div class="lt-tabpanel" role="tabpanel">
              <SettingsSecurity
                {client}
                {prefs}
                walletName={snapshot.activeWallet.name}
                viewOnly={snapshot.activeWallet.viewOnly}
                onPrefsUpdated={handlePrefsUpdated}
                onVaultReset={handleVaultReset}
              />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if diagnostics}
      <details class="lt-disclosure lt-screen-only" data-testid="diagnostics-panel">
        <summary class="lt-disclosure-summary">Runtime diagnostics</summary>
        <div class="lt-disclosure-body">
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
        </div>
      </details>
    {/if}
  </main>
</div>
