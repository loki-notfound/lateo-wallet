<script lang="ts">
  import type { WalletClient, WalletSnapshot } from "@lateo-wallet/core/rpc";

  interface Props {
    client: WalletClient;
    onUnlocked: (snapshot: WalletSnapshot) => void;
    onReset: (snapshot: WalletSnapshot) => void;
  }

  let { client, onUnlocked, onReset }: Props = $props();

  let password = $state("");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let showResetConfirm = $state(false);
  let resetConfirmText = $state("");

  const canConfirmReset = $derived(resetConfirmText.trim() === "DELETE");

  async function handleUnlock(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    busy = true;
    try {
      const snap = await client.unlockWallet(password);
      password = "";
      onUnlocked(snap);
    } catch (err) {
      errorMsg =
        err instanceof Error && err.message === "Incorrect vault password"
          ? "Incorrect vault password. Please try again."
          : "Could not unlock vault. Check your password and try again.";
    } finally {
      busy = false;
    }
  }

  async function handleReset(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canConfirmReset) return;
    errorMsg = null;
    busy = true;
    try {
      const snap = await client.resetVault();
      resetConfirmText = "";
      showResetConfirm = false;
      onReset(snap);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Vault reset failed";
    } finally {
      busy = false;
    }
  }
</script>

<section class="lt-panel lt-stack" data-testid="unlock-screen">
  <div class="lt-panel-header">
    <div>
      <h1 class="lt-panel-title">Vault locked</h1>
      <p class="lt-panel-subtitle">Enter your vault password to unlock locally.</p>
    </div>
  </div>

  {#if errorMsg}
    <div class="lt-alert lt-alert-danger" role="alert" data-testid="unlock-error">
      <div class="lt-alert-body">{errorMsg}</div>
    </div>
  {/if}

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
        disabled={busy}
        data-testid="unlock-password-input"
      />
    </div>

    <div class="lt-form-actions">
      <button
        type="submit"
        class="lt-btn lt-btn-primary"
        disabled={busy || password.length === 0}
        data-testid="unlock-submit-btn"
      >
        {busy ? "Unlocking..." : "Unlock vault"}
      </button>
      <button
        type="button"
        class="lt-btn lt-btn-quiet"
        disabled={busy}
        onclick={() => {
          showResetConfirm = !showResetConfirm;
          resetConfirmText = "";
        }}
        data-testid="toggle-reset-btn"
      >
        Forgot password / Reset vault
      </button>
    </div>
  </form>

  {#if showResetConfirm}
    <form onsubmit={handleReset} class="lt-confirm-box lt-stack" data-testid="unlock-reset-confirm">
      <h3>Delete local encrypted vault</h3>
      <p>
        This permanently removes the local encrypted vault and cache from this device. Make sure
        you have your 25-word recovery seed backed up before continuing.
      </p>
      <div class="lt-field">
        <label class="lt-label" for="unlock-reset-text">Type DELETE to confirm</label>
        <input
          id="unlock-reset-text"
          class="lt-input"
          type="text"
          bind:value={resetConfirmText}
          autocomplete="off"
          disabled={busy}
          data-testid="unlock-reset-input"
        />
      </div>
      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-danger"
          disabled={busy || !canConfirmReset}
          data-testid="unlock-reset-submit"
        >
          Permanently reset vault
        </button>
      </div>
    </form>
  {/if}
</section>
