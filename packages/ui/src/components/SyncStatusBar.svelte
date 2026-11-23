<script lang="ts">
  import type { SyncStatusDto } from "@lateo-wallet/core/rpc";

  interface Props {
    sync: SyncStatusDto;
    busy?: boolean;
    onSyncNow: () => void;
    onOpenNodeSettings: () => void;
    onGrantPermission?: (originPattern: string) => void;
  }

  let { sync, busy = false, onSyncNow, onOpenNodeSettings, onGrantPermission }: Props = $props();

  const badgeClass = $derived.by(() => {
    if (sync.state === "synced") return "lt-sync-bar lt-conn-online";
    if (sync.state === "syncing" || sync.state === "reconnecting") {
      return "lt-sync-bar lt-conn-syncing";
    }
    if (sync.state === "offline" || sync.state === "permission-required") {
      return "lt-sync-bar lt-conn-offline";
    }
    return "lt-sync-bar";
  });

  const stateLabel = $derived.by(() => {
    switch (sync.state) {
      case "synced":
        return "Synced";
      case "syncing":
        return `Syncing (${sync.percentDone}%)`;
      case "reconnecting":
        return "Reconnecting";
      case "offline":
        return "Offline";
      case "permission-required":
        return "Permission required";
      default:
        return "Not synced";
    }
  });

  const checkpointText = $derived.by(() => {
    if (!sync.lastCheckpointAt) return null;
    const d = new Date(sync.lastCheckpointAt);
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  });
</script>

<section class="lt-sync-panel" data-testid="sync-status-bar">
  <div class="lt-sync-row">
    <div class="lt-meta-pills">
      <span class={badgeClass} data-testid="sync-state-badge">{stateLabel}</span>
      <span class="lt-compact lt-num" data-testid="sync-heights">
        {#if sync.daemonHeight > 0}
          Height {sync.walletHeight.toLocaleString("en-US")} /
          {sync.daemonHeight.toLocaleString("en-US")}
        {:else if sync.walletHeight > 0}
          Height {sync.walletHeight.toLocaleString("en-US")}
        {:else}
          Awaiting sync
        {/if}
      </span>
    </div>

    <div class="lt-meta-pills">
      <button
        type="button"
        class="lt-node-link"
        onclick={onOpenNodeSettings}
        data-testid="sync-node-host"
      >
        <bdi>{sync.nodeHost}</bdi>
      </button>
      <button
        type="button"
        class="lt-btn lt-btn-secondary"
        disabled={busy || sync.state === "syncing"}
        onclick={onSyncNow}
        data-testid="sync-now-btn"
      >
        {sync.state === "syncing" ? "Syncing..." : "Refresh"}
      </button>
    </div>
  </div>

  {#if sync.state === "syncing"}
    <progress class="lt-progress" value={sync.percentDone} max={100}></progress>
  {/if}

  {#if sync.state === "permission-required" && sync.permissionOriginRequired}
    <div class="lt-alert lt-alert-warning" role="alert" data-testid="sync-permission-alert">
      <div class="lt-alert-body">
        Host permission for <code><bdi>{sync.permissionOriginRequired}</bdi></code> is not granted.
      </div>
      {#if onGrantPermission}
        <button
          type="button"
          class="lt-btn lt-btn-primary"
          onclick={() => onGrantPermission(sync.permissionOriginRequired!)}
          data-testid="grant-node-perm-btn"
        >
          Grant access
        </button>
      {/if}
    </div>
  {:else if sync.errorMessage}
    <p class="lt-field-error" role="status" data-testid="sync-error">{sync.errorMessage}</p>
  {/if}

  {#if checkpointText}
    <p class="lt-help" data-testid="sync-checkpoint-time">Last encrypted save: {checkpointText}</p>
  {/if}
</section>
