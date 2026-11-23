<script lang="ts">
  import type {
    CreateWalletResultDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import { evaluatePasswordStrength, validateMnemonicWordCount } from "@lateo-wallet/core/vault";
  import PasswordFields from "./PasswordFields.svelte";

  interface Props {
    client: WalletClient;
    onCreated: (result: CreateWalletResultDto) => void;
    onRestored: (snapshot: WalletSnapshot) => void;
  }

  let { client, onCreated, onRestored }: Props = $props();

  type OnboardingMode = "choose" | "create" | "restore-seed" | "restore-view";

  let mode = $state<OnboardingMode>("choose");
  let walletName = $state("Primary Wallet");
  let password = $state("");
  let confirmPassword = $state("");
  let seedInput = $state("");
  let restoreHeightText = $state("0");
  let primaryAddress = $state("");
  let privateViewKey = $state("");
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  const pwStrength = $derived(evaluatePasswordStrength(password));
  const passwordReady = $derived(pwStrength.valid && password === confirmPassword);

  function selectMode(next: OnboardingMode): void {
    mode = next;
    errorMsg = null;
    password = "";
    confirmPassword = "";
    if (next === "create") walletName = "Primary Wallet";
    if (next === "restore-seed") walletName = "Restored Wallet";
    if (next === "restore-view") walletName = "View-Only Wallet";
  }

  function parseHeight(): number | null {
    const trimmed = restoreHeightText.trim();
    if (trimmed === "") return 0;
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  async function handleCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    if (!passwordReady) {
      errorMsg = "Please enter a valid password and matching confirmation.";
      return;
    }
    busy = true;
    try {
      const result = await client.createWallet({
        password,
        name: walletName.trim() || "Primary Wallet",
        network: "mainnet"
      });
      password = "";
      confirmPassword = "";
      onCreated(result);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Wallet creation failed";
    } finally {
      busy = false;
    }
  }

  async function handleRestoreSeed(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    if (!passwordReady) {
      errorMsg = "Please enter a valid password and matching confirmation.";
      return;
    }
    const wordCheck = validateMnemonicWordCount(seedInput);
    if (!wordCheck.valid) {
      errorMsg = `Recovery seed must contain 25 words (currently ${wordCheck.count}).`;
      return;
    }
    const height = parseHeight();
    if (height === null) {
      errorMsg = "Restore height must be a non-negative whole number.";
      return;
    }
    busy = true;
    try {
      const snap = await client.restoreFromSeed({
        password,
        name: walletName.trim() || "Restored Wallet",
        seed: seedInput,
        restoreHeight: height,
        network: "mainnet"
      });
      password = "";
      confirmPassword = "";
      seedInput = "";
      onRestored(snap);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Seed restore failed";
    } finally {
      busy = false;
    }
  }

  async function handleRestoreViewOnly(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMsg = null;
    if (!passwordReady) {
      errorMsg = "Please enter a valid password and matching confirmation.";
      return;
    }
    const height = parseHeight();
    if (height === null) {
      errorMsg = "Restore height must be a non-negative whole number.";
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(privateViewKey.trim())) {
      errorMsg = "Private view key must be 64 hexadecimal characters.";
      return;
    }
    busy = true;
    try {
      const snap = await client.restoreViewOnly({
        password,
        name: walletName.trim() || "View-Only Wallet",
        primaryAddress: primaryAddress.trim(),
        privateViewKey: privateViewKey.trim().toLowerCase(),
        restoreHeight: height,
        network: "mainnet"
      });
      password = "";
      confirmPassword = "";
      privateViewKey = "";
      onRestored(snap);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "View-only restore failed";
    } finally {
      busy = false;
    }
  }
</script>

{#if mode === "choose"}
  <section class="lt-panel lt-stack" data-testid="welcome-chooser">
    <div class="lt-panel-header">
      <div>
        <h1 class="lt-panel-title">Welcome to Lateo Wallet</h1>
        <p class="lt-panel-subtitle">
          Non-custodial Zephyr wallet for ZPH (also known as ZEPH), ZSD, ZRS, and ZYS.
        </p>
      </div>
    </div>

    <div class="lt-choice-grid">
      <button
        type="button"
        class="lt-choice-card"
        onclick={() => selectMode("create")}
        data-testid="choose-create-btn"
      >
        <span class="lt-choice-title">Create new wallet</span>
        <span class="lt-choice-desc">
          Generate a fresh 25-word Zephyr recovery seed encrypted in your local vault.
        </span>
      </button>

      <button
        type="button"
        class="lt-choice-card"
        onclick={() => selectMode("restore-seed")}
        data-testid="choose-restore-seed-btn"
      >
        <span class="lt-choice-title">Restore from 25-word seed</span>
        <span class="lt-choice-desc">
          Recover an existing wallet with your 25-word mnemonic phrase and restore height.
        </span>
      </button>

      <button
        type="button"
        class="lt-choice-card"
        onclick={() => selectMode("restore-view")}
        data-testid="choose-restore-view-btn"
      >
        <span class="lt-choice-title">Restore view-only wallet</span>
        <span class="lt-choice-desc">
          Watch incoming outputs using only your primary address and private view key.
        </span>
      </button>
    </div>
  </section>
{:else if mode === "create"}
  <section class="lt-panel lt-stack" data-testid="create-wallet-form">
    <div class="lt-panel-header">
      <h1 class="lt-panel-title">Create new wallet</h1>
      <button type="button" class="lt-btn lt-btn-quiet" onclick={() => selectMode("choose")}>
        Back
      </button>
    </div>

    {#if errorMsg}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="onboarding-error">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    <form onsubmit={handleCreate} class="lt-stack">
      <div class="lt-field">
        <label class="lt-label" for="create-wallet-name">Wallet name</label>
        <input
          id="create-wallet-name"
          class="lt-input"
          type="text"
          bind:value={walletName}
          autocomplete="off"
          required
          disabled={busy}
          data-testid="create-name-input"
        />
      </div>

      <PasswordFields
        bind:password
        bind:confirmPassword
        idPrefix="create"
        disabled={busy}
      />

      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-primary"
          disabled={busy || !passwordReady}
          data-testid="create-submit-btn"
        >
          {busy ? "Generating wallet..." : "Create wallet & show seed"}
        </button>
      </div>
    </form>
  </section>
{:else if mode === "restore-seed"}
  <section class="lt-panel lt-stack" data-testid="restore-seed-form">
    <div class="lt-panel-header">
      <h1 class="lt-panel-title">Restore from 25-word seed</h1>
      <button type="button" class="lt-btn lt-btn-quiet" onclick={() => selectMode("choose")}>
        Back
      </button>
    </div>

    <div class="lt-callout lt-callout-danger">
      <p>
        Only enter your 25-word recovery seed inside your local Lateo Wallet app.
      </p>
    </div>

    {#if errorMsg}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="onboarding-error">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    <form onsubmit={handleRestoreSeed} class="lt-stack">
      <div class="lt-field">
        <label class="lt-label" for="seed-wallet-name">Wallet name</label>
        <input
          id="seed-wallet-name"
          class="lt-input"
          type="text"
          bind:value={walletName}
          autocomplete="off"
          required
          disabled={busy}
          data-testid="restore-seed-name"
        />
      </div>

      <div class="lt-field">
        <label class="lt-label" for="seed-phrase">
          25-word recovery seed<span class="lt-required">*</span>
        </label>
        <textarea
          id="seed-phrase"
          class="lt-textarea"
          bind:value={seedInput}
          autocomplete="off"
          spellcheck="false"
          required
          disabled={busy}
          placeholder="word01 word02 ... word25"
          data-testid="restore-seed-input"
        ></textarea>
      </div>

      <div class="lt-field">
        <label class="lt-label" for="seed-restore-height">Restore height</label>
        <input
          id="seed-restore-height"
          class="lt-input"
          type="text"
          inputmode="numeric"
          bind:value={restoreHeightText}
          autocomplete="off"
          disabled={busy}
          data-testid="restore-seed-height"
        />
        <p class="lt-help">
          Setting the block height from when this wallet was created avoids scanning earlier
          blocks and greatly speeds up initial sync. Leave at 0 if unknown.
        </p>
      </div>

      <PasswordFields
        bind:password
        bind:confirmPassword
        idPrefix="restore-seed"
        disabled={busy}
      />

      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-primary"
          disabled={busy || !passwordReady}
          data-testid="restore-seed-submit"
        >
          {busy ? "Restoring wallet..." : "Restore wallet"}
        </button>
      </div>
    </form>
  </section>
{:else}
  <section class="lt-panel lt-stack" data-testid="restore-view-form">
    <div class="lt-panel-header">
      <h1 class="lt-panel-title">Restore view-only wallet</h1>
      <button type="button" class="lt-btn lt-btn-quiet" onclick={() => selectMode("choose")}>
        Back
      </button>
    </div>

    {#if errorMsg}
      <div class="lt-alert lt-alert-danger" role="alert" data-testid="onboarding-error">
        <div class="lt-alert-body">{errorMsg}</div>
      </div>
    {/if}

    <form onsubmit={handleRestoreViewOnly} class="lt-stack">
      <div class="lt-field">
        <label class="lt-label" for="view-wallet-name">Wallet name</label>
        <input
          id="view-wallet-name"
          class="lt-input"
          type="text"
          bind:value={walletName}
          autocomplete="off"
          required
          disabled={busy}
          data-testid="restore-view-name"
        />
      </div>

      <div class="lt-field">
        <label class="lt-label" for="view-address">
          Primary address<span class="lt-required">*</span>
        </label>
        <input
          id="view-address"
          class="lt-input"
          type="text"
          bind:value={primaryAddress}
          autocomplete="off"
          spellcheck="false"
          required
          disabled={busy}
          data-testid="restore-view-address"
        />
      </div>

      <div class="lt-field">
        <label class="lt-label" for="view-private-key">
          Private view key (64 hex chars)<span class="lt-required">*</span>
        </label>
        <input
          id="view-private-key"
          class="lt-input"
          type="password"
          bind:value={privateViewKey}
          autocomplete="off"
          spellcheck="false"
          required
          disabled={busy}
          data-testid="restore-view-key"
        />
      </div>

      <div class="lt-field">
        <label class="lt-label" for="view-restore-height">Restore height</label>
        <input
          id="view-restore-height"
          class="lt-input"
          type="text"
          inputmode="numeric"
          bind:value={restoreHeightText}
          autocomplete="off"
          disabled={busy}
          data-testid="restore-view-height"
        />
        <p class="lt-help">
          Setting the wallet creation block height speeds up initial sync. Leave at 0 if unknown.
        </p>
      </div>

      <PasswordFields
        bind:password
        bind:confirmPassword
        idPrefix="restore-view"
        disabled={busy}
      />

      <div class="lt-form-actions">
        <button
          type="submit"
          class="lt-btn lt-btn-primary"
          disabled={busy || !passwordReady}
          data-testid="restore-view-submit"
        >
          {busy ? "Restoring view-only wallet..." : "Restore view-only wallet"}
        </button>
      </div>
    </form>
  </section>
{/if}
