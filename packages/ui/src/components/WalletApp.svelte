<script lang="ts">
  import { formatAtomicParts } from "@lateo-wallet/core/assets";
  import type {
    CreateWalletResultDto,
    HostDiagnosticsDto,
    PreparedTxDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import { DEFAULT_WALLET_PREFS, type WalletPrefs } from "@lateo-wallet/core/storage";
  import type { SurfaceMode } from "../types.js";
  import AddressChunks from "./AddressChunks.svelte";
  import AssetBadge from "./AssetBadge.svelte";
  import ConvertView from "./ConvertView.svelte";
  import HistoryView from "./HistoryView.svelte";
  import ReceiveView from "./ReceiveView.svelte";
  import ReserveBanner from "./ReserveBanner.svelte";
  import SeedBackupFlow from "./SeedBackupFlow.svelte";
  import SendView from "./SendView.svelte";
  import SettingsSecurity from "./SettingsSecurity.svelte";
  import SyncStatusBar from "./SyncStatusBar.svelte";
  import TxReviewPanel from "./TxReviewPanel.svelte";
  import UnlockScreen from "./UnlockScreen.svelte";
  import WelcomeOnboarding from "./WelcomeOnboarding.svelte";

  interface Props {
    client: WalletClient;
    surface: SurfaceMode;
    defaultNodeUrl?: string;
    onOpenFullTab?: () => void;
    onOpenSidePanel?: () => void;
    onThemeApplied?: (theme: WalletPrefs["theme"]) => void;
    onRequestOriginPermission?: (originPattern: string) => Promise<boolean>;
  }

  let {
    client,
    surface,
    defaultNodeUrl,
    onOpenFullTab,
    onOpenSidePanel,
    onThemeApplied,
    onRequestOriginPermission
  }: Props = $props();

  type WalletTab = "overview" | "send" | "convert" | "receive" | "history" | "security";

  let snapshot = $state<WalletSnapshot | null>(null);
  let diagnostics = $state<HostDiagnosticsDto | null>(null);
  let prefs = $state<WalletPrefs>(DEFAULT_WALLET_PREFS);
  let pendingBackup = $state<CreateWalletResultDto | null>(null);
  let activeTab = $state<WalletTab>("overview");
  let busy = $state(false);
  let reserveBusy = $state(false);
  let txFlowBusy = $state(false);
  let txFlowError = $state<string | null>(null);
  let relayReceipt = $state<{
    readonly txHashes: readonly string[];
    readonly relayedAt: number;
    readonly nodeHost: string;
    readonly notRelayed?: boolean;
  } | null>(null);
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

  async function handleSyncNow(): Promise<void> {
    errorMsg = null;
    busy = true;
    try {
      snapshot = await client.syncNow();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Sync failed";
    } finally {
      busy = false;
    }
  }

  async function handleRefreshReserve(): Promise<void> {
    errorMsg = null;
    reserveBusy = true;
    try {
      await client.refreshReserve();
      snapshot = await client.getSnapshot();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Reserve lookup failed";
    } finally {
      reserveBusy = false;
    }
  }

  async function handleGrantNodePermission(originPattern: string): Promise<void> {
    if (!onRequestOriginPermission) return;
    const granted = await onRequestOriginPermission(originPattern);
    if (granted) {
      await refreshDiagnostics();
      await handleSyncNow();
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

  function handlePrepared(prepared: PreparedTxDto): void {
    txFlowError = null;
    relayReceipt = null;
    if (snapshot) {
      snapshot = { ...snapshot, pendingTx: prepared };
    }
  }

  async function handleConfirmRelay(token: string): Promise<void> {
    errorMsg = null;
    txFlowError = null;
    txFlowBusy = true;
    try {
      const outcome = await client.relayPrepared(token);
      snapshot = await client.getSnapshot();
      if (outcome.kind === "relayed") {
        relayReceipt = {
          txHashes: outcome.txHashes,
          relayedAt: outcome.relayedAt,
          nodeHost: outcome.nodeHost,
          ...(outcome.notRelayed ? { notRelayed: true } : {})
        };
      } else if (outcome.kind === "relayed-unsaved") {
        txFlowError = outcome.message;
      } else if (outcome.kind === "rejected" || outcome.kind === "expired") {
        txFlowError = outcome.message;
      }
    } catch (err) {
      txFlowError = err instanceof Error ? err.message : "Relay failed";
      try {
        snapshot = await client.getSnapshot();
      } catch {
        // Ignore secondary snapshot error
      }
    } finally {
      txFlowBusy = false;
    }
  }

  async function handleDiscardPrepared(token: string, verify: boolean): Promise<void> {
    errorMsg = null;
    txFlowError = null;
    txFlowBusy = true;
    try {
      snapshot = await client.discardPrepared(token, verify);
    } catch (err) {
      txFlowError = err instanceof Error ? err.message : "Discard failed";
      try {
        snapshot = await client.getSnapshot();
      } catch {
        // Ignore secondary snapshot refresh error
      }
    } finally {
      txFlowBusy = false;
    }
  }

  async function handleClearUnresolvedRelay(): Promise<void> {
    if (!client.clearUnresolvedRelay) return;
    errorMsg = null;
    txFlowError = null;
    txFlowBusy = true;
    try {
      snapshot = await client.clearUnresolvedRelay();
    } catch (err) {
      txFlowError = err instanceof Error ? err.message : "Failed to clear unresolved relay barrier";
    } finally {
      txFlowBusy = false;
    }
  }

  async function handleRetryPersist(): Promise<void> {
    errorMsg = null;
    txFlowError = null;
    txFlowBusy = true;
    try {
      const failedHashes = snapshot?.persistFailure?.txHashes ?? [];
      const nodeHost = snapshot?.sync.nodeHost ?? "node.lateo.dev";
      snapshot = await client.retryPersist();
      if (!snapshot.persistFailure && failedHashes.length > 0) {
        relayReceipt = {
          txHashes: failedHashes,
          relayedAt: Date.now(),
          nodeHost
        };
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Retry save failed";
    } finally {
      txFlowBusy = false;
    }
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
          disabled={busy || snapshot.savingState || txFlowBusy}
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
      {#if snapshot.savingKind === "post-relay"}
        <div
          class="lt-saving-barrier-overlay lt-screen-only"
          role="alertdialog"
          aria-modal="true"
          aria-busy="true"
          aria-labelledby="post-relay-saving-title"
          data-testid="post-relay-saving-barrier"
        >
          <div class="lt-saving-barrier-card">
            <div class="lt-sync-row">
              <strong id="post-relay-saving-title" class="lt-panel-title">
                Saving wallet state...
              </strong>
              <span class="lt-spinner" aria-hidden="true"></span>
            </div>
            <p class="lt-compact">
              Encrypting and committing updated spend keys and transaction cache to IndexedDB. Do
              not close or lock the wallet until saving completes.
            </p>
          </div>
        </div>
      {/if}
    {/if}

    {#if snapshot?.persistFailure}
      <div
        class="lt-panel lt-confirm-box lt-stack lt-screen-only"
        role="alert"
        data-testid="persist-failure-alert"
      >
        <h2 class="lt-panel-title">Critical: Save wallet state before closing</h2>
        <p class="lt-compact">
          Your transaction was accepted by the node, but committing the updated wallet state to
          IndexedDB failed (<bdi>{snapshot.persistFailure.message}</bdi>). Retry saving now so your
          spend state and transaction keys are persisted.
        </p>
        {#if snapshot.persistFailure.txHashes.length > 0}
          <div class="lt-stack">
            {#each snapshot.persistFailure.txHashes as hash (hash)}
              <code class="lt-hash" data-testid="persist-failure-txid"><bdi>{hash}</bdi></code>
            {/each}
          </div>
        {/if}
        <div class="lt-form-actions">
          <button
            type="button"
            class="lt-btn lt-btn-primary"
            disabled={txFlowBusy || snapshot.savingState}
            onclick={handleRetryPersist}
            data-testid="retry-persist-btn"
          >
            {txFlowBusy || snapshot.savingState ? "Saving..." : "Retry saving wallet state"}
          </button>
        </div>
      </div>
    {/if}

    {#if relayReceipt && !snapshot?.savingState && !snapshot?.persistFailure}
      <section
        class={relayReceipt.notRelayed
          ? "lt-callout lt-callout-warning lt-stack lt-screen-only"
          : "lt-callout lt-callout-success lt-stack lt-screen-only"}
        role="status"
        data-testid="relay-receipt-panel"
      >
        <div class="lt-sync-row">
          <span class="lt-callout-title">
            {relayReceipt.notRelayed
              ? "Transaction accepted locally (not relayed to peers)"
              : "Transaction broadcast & wallet state saved"}
          </span>
          <span class="lt-tx-badge lt-tx-pending" data-testid="relay-receipt-status">
            {relayReceipt.notRelayed ? "Not relayed — verify via sync" : "Pending in mempool"}
          </span>
        </div>
        <p class="lt-compact">
          {relayReceipt.notRelayed ? "Submitted to" : "Relayed via"}
          <span class="lt-hash-short"><bdi>{relayReceipt.nodeHost}</bdi></span> at
          <span class="lt-num" data-testid="relay-receipt-timestamp">
            {new Date(relayReceipt.relayedAt).toISOString()}
          </span>
        </p>
        <div class="lt-stack">
          {#each relayReceipt.txHashes as hash (hash)}
            <code class="lt-hash" data-testid="relay-receipt-txid"><bdi>{hash}</bdi></code>
          {/each}
        </div>
        <div class="lt-form-actions">
          <button
            type="button"
            class="lt-btn lt-btn-secondary"
            onclick={() => (relayReceipt = null)}
            data-testid="dismiss-receipt-btn"
          >
            Dismiss
          </button>
        </div>
      </section>
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
      <WelcomeOnboarding {client} onCreated={handleCreated} onRestored={handleRestored} />
    {:else if snapshot.locked}
      <UnlockScreen {client} onUnlocked={handleUnlocked} onReset={handleVaultReset} />
    {:else if snapshot.activeWallet}
      <div class="lt-stack lt-screen-only" data-testid="wallet-unlocked">
        {#if snapshot.activeWallet.viewOnly}
          <div class="lt-wallet-mode-banner" role="status" data-testid="view-only-banner">
            View-only wallet — incoming outputs only; cannot sign or spend.
          </div>
        {/if}

        <SyncStatusBar
          sync={snapshot.sync}
          {busy}
          onSyncNow={handleSyncNow}
          onOpenNodeSettings={() => (activeTab = "security")}
          {...(onRequestOriginPermission ? { onGrantPermission: handleGrantNodePermission } : {})}
        />

        {#if snapshot.unresolvedRelay && !snapshot.pendingTx}
          <section
            class="lt-panel lt-confirm-box lt-stack"
            role="alert"
            data-testid="unresolved-relay-banner"
          >
            <h2 class="lt-panel-title">Verify previous uncertain broadcast before sending again</h2>
            <p class="lt-compact">
              A prior transaction via
              <span class="lt-hash-short"><bdi>{snapshot.unresolvedRelay.nodeHost}</bdi></span>
              had an uncertain relay outcome (<bdi>{snapshot.unresolvedRelay.reason}</bdi>).
              New transactions are paused until a wallet sync verifies whether it reached the network.
            </p>
            {#if snapshot.unresolvedRelay.txHashes.length > 0}
              <div class="lt-stack">
                {#each snapshot.unresolvedRelay.txHashes as hash (hash)}
                  <code class="lt-hash" data-testid="unresolved-relay-txid"><bdi>{hash}</bdi></code>
                {/each}
              </div>
            {/if}
            <div class="lt-form-actions">
              <button
                type="button"
                class="lt-btn lt-btn-primary"
                disabled={busy || txFlowBusy}
                onclick={handleSyncNow}
                data-testid="sync-verify-unresolved-btn"
              >
                {busy ? "Syncing..." : "Sync now to verify"}
              </button>
              {#if client.clearUnresolvedRelay}
                <button
                  type="button"
                  class="lt-btn lt-btn-secondary"
                  disabled={busy || txFlowBusy}
                  onclick={handleClearUnresolvedRelay}
                  data-testid="clear-unresolved-relay-btn"
                >
                  Dismiss after manual verification
                </button>
              {/if}
            </div>
          </section>
        {/if}

        {#if snapshot.pendingTx}
          <TxReviewPanel
            pendingTx={snapshot.pendingTx}
            daemonHeight={Math.max(
              snapshot.sync.daemonHeight,
              snapshot.sync.walletHeight,
              snapshot.reserve?.height ?? 0
            )}
            busy={txFlowBusy || snapshot.savingState}
            errorMessage={txFlowError}
            onConfirmRelay={handleConfirmRelay}
            onDiscard={handleDiscardPrepared}
          />
        {:else if txFlowError}
          <div
            class="lt-alert lt-alert-danger"
            role="alert"
            data-testid="tx-flow-error-banner"
          >
            <div class="lt-alert-body"><bdi>{txFlowError}</bdi></div>
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
              aria-selected={activeTab === "send"}
              onclick={() => (activeTab = "send")}
              data-testid="tab-send"
            >
              Send
            </button>
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "convert"}
              onclick={() => (activeTab = "convert")}
              data-testid="tab-convert"
            >
              Convert
            </button>
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "receive"}
              onclick={() => (activeTab = "receive")}
              data-testid="tab-receive"
            >
              Receive
            </button>
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "history"}
              onclick={() => (activeTab = "history")}
              data-testid="tab-history"
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              class="lt-tab"
              aria-selected={activeTab === "security"}
              onclick={() => (activeTab = "security")}
              data-testid="tab-security"
            >
              Settings
            </button>
          </div>

          {#if activeTab === "overview"}
            <div class="lt-tabpanel lt-stack" role="tabpanel">
              <ReserveBanner
                reserve={snapshot.reserve}
                busy={reserveBusy}
                onRefresh={handleRefreshReserve}
              />

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

                <div class="lt-balance-secondary-grid" data-testid="asset-balance-grid">
                  {#each snapshot.balances as bal (bal.asset)}
                    {@const unlockedP = formatAtomicParts(BigInt(bal.unlocked), 4)}
                    {@const lockedP = formatAtomicParts(BigInt(bal.locked), 4)}
                    {@const totalP = formatAtomicParts(BigInt(bal.total), 4)}
                    <div class="lt-balance-card" data-testid={`balance-card-${bal.asset}`}>
                      <div class="lt-balance-label">
                        <AssetBadge asset={bal.asset} />
                        <span>Unlocked</span>
                      </div>
                      <div class="lt-amount lt-amount-lg">
                        {unlockedP.whole}.{unlockedP.fracPrimary}<span class="lt-amount-tail"
                          >{unlockedP.fracTail}</span
                        ><span class="lt-amount-ticker">{bal.asset}</span>
                      </div>
                      <div class="lt-balance-breakdown">
                        <span>Locked: {lockedP.whole}.{lockedP.fracPrimary}</span>
                        <span>Total: {totalP.whole}.{totalP.fracPrimary}</span>
                      </div>
                    </div>
                  {/each}
                </div>

                <AddressChunks address={snapshot.activeWallet.primaryAddress} />
              </section>
            </div>
          {:else if activeTab === "send"}
            <div class="lt-tabpanel" role="tabpanel">
              <SendView
                {client}
                balances={snapshot.balances}
                nodeHost={snapshot.sync.nodeHost}
                viewOnly={snapshot.activeWallet.viewOnly}
                disabled={txFlowBusy ||
                  snapshot.savingState ||
                  snapshot.pendingTx !== null ||
                  Boolean(snapshot.unresolvedRelay)}
                onPrepared={handlePrepared}
              />
            </div>
          {:else if activeTab === "convert"}
            <div class="lt-tabpanel" role="tabpanel">
              <ConvertView
                {client}
                balances={snapshot.balances}
                reserve={snapshot.reserve}
                daemonHeight={Math.max(
                  snapshot.sync.daemonHeight,
                  snapshot.sync.walletHeight,
                  snapshot.reserve?.height ?? 0
                )}
                primaryAddress={snapshot.activeWallet.primaryAddress}
                nodeHost={snapshot.sync.nodeHost}
                viewOnly={snapshot.activeWallet.viewOnly}
                disabled={txFlowBusy ||
                  snapshot.savingState ||
                  snapshot.pendingTx !== null ||
                  Boolean(snapshot.unresolvedRelay)}
                {reserveBusy}
                onRefreshReserve={handleRefreshReserve}
                onPrepared={handlePrepared}
              />
            </div>
          {:else if activeTab === "receive"}
            <div class="lt-tabpanel" role="tabpanel">
              <ReceiveView {client} />
            </div>
          {:else if activeTab === "history"}
            <div class="lt-tabpanel" role="tabpanel">
              <HistoryView
                {client}
                walletHeight={snapshot.sync.walletHeight}
                viewOnly={snapshot.activeWallet.viewOnly}
              />
            </div>
          {:else}
            <div class="lt-tabpanel" role="tabpanel">
              <SettingsSecurity
                {client}
                {prefs}
                activeNodeUrl={snapshot.sync.nodeUrl}
                {...(defaultNodeUrl ? { defaultNodeUrl } : {})}
                walletName={snapshot.activeWallet.name}
                viewOnly={snapshot.activeWallet.viewOnly}
                onPrefsUpdated={handlePrefsUpdated}
                onNodeSwitched={(nextSnap) => (snapshot = nextSnap)}
                onVaultReset={handleVaultReset}
                {...(onRequestOriginPermission ? { onRequestOriginPermission } : {})}
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
