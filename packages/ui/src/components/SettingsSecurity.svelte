<script lang="ts">
  import type {
    RevealedSecretsDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import {
    AUTO_LOCK_PRESET_MINUTES,
    type ThemePreference,
    type WalletPrefs
  } from "@lateo-wallet/core/storage";
  import { evaluatePasswordStrength, splitMnemonicWords } from "@lateo-wallet/core/vault";
  import NodeSwitcher from "./NodeSwitcher.svelte";
  import PasswordFields from "./PasswordFields.svelte";

  const REVEAL_AUTO_MASK_SECONDS = 60;

  interface Props {
    client: WalletClient;
    prefs: WalletPrefs;
    activeNodeUrl?: string;
    defaultNodeUrl?: string;
    walletName: string;
    viewOnly: boolean;
    onPrefsUpdated: (next: WalletPrefs) => void;
    onNodeSwitched: (snapshot: WalletSnapshot) => void;
    onVaultReset: (snapshot: WalletSnapshot) => void;
    onRequestOriginPermission?: (originPattern: string) => Promise<boolean>;
  }

  let {
    client,
    prefs,
    activeNodeUrl,
    defaultNodeUrl,
    walletName,
    viewOnly,
    onPrefsUpdated,
    onNodeSwitched,
    onVaultReset,
    onRequestOriginPermission
  }: Props = $props();

  let currentPw = $state("");
  let newPw = $state("");
  let confirmNewPw = $state("");
  let pwBusy = $state(false);
  let pwError = $state<string | null>(null);
  let pwSuccess = $state<string | null>(null);

  const newPwStrength = $derived(evaluatePasswordStrength(newPw));
  const canChangePw = $derived(
    currentPw.length > 0 && newPwStrength.valid && newPw === confirmNewPw && currentPw !== newPw
  );

  let revealPw = $state("");
  let revealBusy = $state(false);
  let revealError = $state<string | null>(null);
  let revealed = $state<RevealedSecretsDto | null>(null);
  let secondsLeft = $state(0);

  const revealedWords = $derived(revealed?.seed ? splitMnemonicWords(revealed.seed) : []);

  let showDeleteConfirm = $state(false);
  let deleteBackupChecked = $state(false);
  let deleteConfirmText = $state("");
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  const canDelete = $derived(deleteBackupChecked && deleteConfirmText.trim() === "DELETE");

  function maskSecrets(): void {
    revealed = null;
    secondsLeft = 0;
  }

  $effect(() => {
    if (!revealed) return;

    const timer = setInterval(() => {
      if (secondsLeft <= 1) {
        maskSecrets();
      } else {
        secondsLeft -= 1;
      }
    }, 1000);

    const onBlur = (): void => {
      maskSecrets();
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") {
        maskSecrets();
      }
    };

    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  async function handleAutoLockChange(event: Event): Promise<void> {
    const value = Number((event.currentTarget as HTMLSelectElement).value);
    if (!Number.isFinite(value) || value < 1) return;
    const next = await client.updatePrefs({ autoLockMinutes: value });
    onPrefsUpdated(next);
  }

  async function handleThemeChange(theme: ThemePreference): Promise<void> {
    const next = await client.updatePrefs({ theme });
    onPrefsUpdated(next);
  }

  async function handleChangePassword(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    pwError = null;
    pwSuccess = null;
    if (!canChangePw) return;
    pwBusy = true;
    try {
      await client.changeVaultPassword({
        currentPassword: currentPw,
        newPassword: newPw
      });
      currentPw = "";
      newPw = "";
      confirmNewPw = "";
      pwSuccess = "Vault password updated. Your previous password is no longer valid.";
    } catch (err) {
      pwError = err instanceof Error ? err.message : "Password change failed";
    } finally {
      pwBusy = false;
    }
  }

  async function handleRevealSecrets(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    revealError = null;
    revealBusy = true;
    try {
      const secrets = await client.revealSecrets(revealPw);
      revealPw = "";
      revealed = secrets;
      secondsLeft = REVEAL_AUTO_MASK_SECONDS;
    } catch (err) {
      revealError = err instanceof Error ? err.message : "Could not verify password";
    } finally {
      revealBusy = false;
    }
  }

  async function handleDeleteVault(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canDelete) return;
    deleteError = null;
    deleteBusy = true;
    try {
      maskSecrets();
      const snap = await client.resetVault();
      onVaultReset(snap);
    } catch (err) {
      deleteError = err instanceof Error ? err.message : "Failed to delete vault";
    } finally {
      deleteBusy = false;
    }
  }
</script>

<div class="lt-stack" data-testid="settings-security-panel">
  <!-- Node Switcher -->
  <NodeSwitcher
    {client}
    {prefs}
    {...(activeNodeUrl ? { activeNodeUrl } : {})}
    {...(defaultNodeUrl ? { defaultNodeUrl } : {})}
    {onPrefsUpdated}
    onSwitched={onNodeSwitched}
    {...(onRequestOriginPermission ? { onRequestOriginPermission } : {})}
  />

  <!-- Session & Appearance Preferences -->
  <section class="lt-panel lt-stack">
    <div class="lt-panel-header">
      <h2 class="lt-panel-title">Session &amp; appearance</h2>
    </div>

    <div class="lt-settings-list">
      <div class="lt-settings-row">
        <div class="lt-settings-meta">
          <p class="lt-settings-title">Idle auto-lock</p>
          <p class="lt-settings-desc">
            Automatically lock the vault and wipe unlocked memory after inactivity.
          </p>
        </div>
        <div class="lt-settings-control">
          <label class="lt-sr-only" for="autolock-select">Auto-lock timeout</label>
          <select
            id="autolock-select"
            class="lt-select"
            value={String(prefs.autoLockMinutes)}
            onchange={handleAutoLockChange}
            data-testid="autolock-select"
          >
            {#each AUTO_LOCK_PRESET_MINUTES as mins (mins)}
              <option value={String(mins)}>{mins} minutes</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="lt-settings-row">
        <div class="lt-settings-meta">
          <p class="lt-settings-title">Theme</p>
          <p class="lt-settings-desc">Choose system, light, or dark appearance.</p>
        </div>
        <div class="lt-settings-control">
          <div class="lt-theme-switch" role="group" aria-label="Theme">
            {#each ["system", "light", "dark"] as mode (mode)}
              <button
                type="button"
                class="lt-theme-btn"
                aria-pressed={prefs.theme === mode}
                onclick={() => handleThemeChange(mode as ThemePreference)}
                data-testid={`theme-btn-${mode}`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Change Vault Password -->
  <section class="lt-panel lt-stack" data-testid="change-password-section">
    <div class="lt-panel-header">
      <div>
        <h2 class="lt-panel-title">Change vault password</h2>
        <p class="lt-panel-subtitle">
          Re-wraps your encrypted vault header with a fresh salt and 600,000 PBKDF2 iterations.
        </p>
      </div>
    </div>

    {#if pwError}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="change-pw-error">
        <div class="lt-alert-body">{pwError}</div>
      </div>
    {/if}
    {#if pwSuccess}
      <div class="lt-alert lt-alert-success" role="status" data-testid="change-pw-success">
        <div class="lt-alert-body">{pwSuccess}</div>
      </div>
    {/if}

    <form onsubmit={handleChangePassword} class="lt-stack">
      <div class="lt-field">
        <label class="lt-label" for="current-vault-pw">
          Current vault password<span class="lt-required">*</span>
        </label>
        <input
          id="current-vault-pw"
          class="lt-input"
          type="password"
          bind:value={currentPw}
          autocomplete="current-password"
          required
          disabled={pwBusy}
          data-testid="current-pw-input"
        />
      </div>

      <PasswordFields
        bind:password={newPw}
        bind:confirmPassword={confirmNewPw}
        idPrefix="change-pw"
        label="New vault password"
        confirmLabel="Confirm new vault password"
        disabled={pwBusy}
      />

      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-primary"
          disabled={pwBusy || !canChangePw}
          data-testid="change-pw-submit"
        >
          {pwBusy ? "Updating password..." : "Update vault password"}
        </button>
      </div>
    </form>
  </section>

  <!-- Danger Zone -->
  <section class="lt-danger-zone" data-testid="danger-zone">
    <h2 class="lt-panel-title">Danger zone</h2>

    <div class="lt-danger-item lt-stack">
      <div>
        <p class="lt-settings-title">
          {viewOnly ? "Reveal private view key" : "Reveal 25-word seed & private keys"}
        </p>
        <p class="lt-settings-desc">
          Requires password re-entry. Automatically hides after 60 seconds or when the window loses
          focus.
        </p>
      </div>

      {#if revealError}
        <div class="lt-alert lt-alert-danger" role="alert" data-testid="reveal-error">
          <div class="lt-alert-body">{revealError}</div>
        </div>
      {/if}

      {#if !revealed}
        <form onsubmit={handleRevealSecrets} class="lt-input-group">
          <label class="lt-sr-only" for="reveal-pw-input">Confirm vault password to reveal</label>
          <input
            id="reveal-pw-input"
            class="lt-input"
            type="password"
            bind:value={revealPw}
            placeholder="Re-enter vault password"
            autocomplete="current-password"
            required
            disabled={revealBusy}
            data-testid="reveal-pw-input"
          />
          <button
            type="submit"
            class="lt-btn lt-btn-danger"
            disabled={revealBusy || revealPw.length === 0}
            data-testid="reveal-submit-btn"
          >
            {revealBusy ? "Verifying..." : "Reveal secrets"}
          </button>
        </form>
      {:else}
        <div class="lt-secret-box" data-testid="revealed-secrets-box">
          <div class="lt-address-bar">
            <span class="lt-tx-badge lt-tx-failed" data-testid="reveal-countdown">
              Auto-hides in {secondsLeft}s
            </span>
            <button
              type="button"
              class="lt-btn lt-btn-secondary"
              onclick={maskSecrets}
              data-testid="hide-secrets-btn"
            >
              Hide now
            </button>
          </div>

          {#if revealedWords.length > 0}
            <div>
              <span class="lt-label">25-word recovery seed</span>
              <ol class="lt-seed-grid" data-testid="revealed-seed-grid">
                {#each revealedWords as word, idx (idx)}
                  <li class="lt-seed-item">
                    <span class="lt-seed-num">{String(idx + 1).padStart(2, "0")}</span>
                    <code class="lt-seed-word"><bdi>{word}</bdi></code>
                  </li>
                {/each}
              </ol>
            </div>
          {/if}

          <div>
            <span class="lt-label">Private view key</span>
            <div class="lt-secret-key" data-testid="revealed-view-key">
              <bdi>{revealed.privateViewKey}</bdi>
            </div>
          </div>

          {#if revealed.privateSpendKey}
            <div>
              <span class="lt-label">Private spend key</span>
              <div class="lt-secret-key" data-testid="revealed-spend-key">
                <bdi>{revealed.privateSpendKey}</bdi>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="lt-danger-item lt-stack">
      <div class="lt-address-bar">
        <div>
          <p class="lt-settings-title">Delete local wallet &amp; reset vault</p>
          <p class="lt-settings-desc">
            Removes <bdi>{walletName}</bdi> and all encrypted IndexedDB data from this device.
          </p>
        </div>
        <button
          type="button"
          class="lt-btn lt-btn-danger"
          onclick={() => {
            showDeleteConfirm = !showDeleteConfirm;
            deleteConfirmText = "";
            deleteBackupChecked = false;
          }}
          data-testid="delete-wallet-toggle"
        >
          Delete wallet
        </button>
      </div>

      {#if showDeleteConfirm}
        {#if deleteError}
          <div class="lt-alert lt-alert-danger" role="alert">
            <div class="lt-alert-body">{deleteError}</div>
          </div>
        {/if}

        <form onsubmit={handleDeleteVault} class="lt-confirm-box lt-stack" data-testid="delete-wallet-confirm">
          <h3>Confirm permanent deletion of <bdi>{walletName}</bdi></h3>
          <label class="lt-check">
            <input
              type="checkbox"
              bind:checked={deleteBackupChecked}
              disabled={deleteBusy}
              data-testid="delete-backup-checkbox"
            />
            <span>I have verified my 25-word recovery seed backup offline.</span>
          </label>
          <div class="lt-field">
            <label class="lt-label" for="delete-wallet-text">Type DELETE to confirm</label>
            <input
              id="delete-wallet-text"
              class="lt-input"
              type="text"
              bind:value={deleteConfirmText}
              autocomplete="off"
              disabled={deleteBusy}
              data-testid="delete-confirm-input"
            />
          </div>
          <div class="lt-form-actions">
            <button
              type="submit"
              class="lt-btn lt-btn-danger"
              disabled={deleteBusy || !canDelete}
              data-testid="delete-wallet-submit"
            >
              {deleteBusy ? "Deleting..." : "Permanently delete local vault"}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </section>
</div>
