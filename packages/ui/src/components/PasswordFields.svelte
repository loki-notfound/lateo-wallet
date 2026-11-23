<script lang="ts">
  import { evaluatePasswordStrength } from "@lateo-wallet/core/vault";

  interface Props {
    password: string;
    confirmPassword: string;
    idPrefix: string;
    label?: string;
    confirmLabel?: string;
    disabled?: boolean;
  }

  let {
    password = $bindable(""),
    confirmPassword = $bindable(""),
    idPrefix,
    label = "Vault password",
    confirmLabel = "Confirm vault password",
    disabled = false
  }: Props = $props();

  const strength = $derived(evaluatePasswordStrength(password));
  const mismatch = $derived(confirmPassword.length > 0 && password !== confirmPassword);

  const badgeClass = $derived.by(() => {
    if (strength.level === "strong") return "lt-tx-badge lt-tx-confirmed";
    if (strength.level === "fair") return "lt-tx-badge lt-tx-pending";
    if (strength.level === "weak") return "lt-tx-badge lt-tx-locked";
    return "lt-tx-badge lt-tx-failed";
  });
</script>

<div class="lt-field">
  <label class="lt-label" for={`${idPrefix}-pw`}>
    {label}<span class="lt-required">*</span>
  </label>
  <input
    id={`${idPrefix}-pw`}
    class="lt-input"
    type="password"
    bind:value={password}
    autocomplete="new-password"
    minlength="8"
    required
    {disabled}
    data-testid={`${idPrefix}-password`}
  />
  {#if password.length > 0}
    <div class="lt-meta-pills">
      <span class={badgeClass} data-testid={`${idPrefix}-strength`}>{strength.label}</span>
    </div>
  {:else}
    <p class="lt-help">At least 8 characters (12+ characters recommended).</p>
  {/if}
</div>

<div class="lt-field">
  <label class="lt-label" for={`${idPrefix}-confirm`}>
    {confirmLabel}<span class="lt-required">*</span>
  </label>
  <input
    id={`${idPrefix}-confirm`}
    class="lt-input"
    type="password"
    bind:value={confirmPassword}
    autocomplete="new-password"
    minlength="8"
    required
    {disabled}
    aria-invalid={mismatch ? "true" : undefined}
    data-testid={`${idPrefix}-confirm`}
  />
  {#if mismatch}
    <p class="lt-field-error" role="alert">Passwords do not match.</p>
  {/if}
</div>
