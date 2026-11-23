<script lang="ts">
  import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";
  import type {
    NodeProbeResultDto,
    WalletClient,
    WalletSnapshot
  } from "@lateo-wallet/core/rpc";
  import type { WalletPrefs } from "@lateo-wallet/core/storage";

  interface Props {
    client: WalletClient;
    prefs: WalletPrefs;
    activeNodeUrl?: string;
    defaultNodeUrl?: string;
    onPrefsUpdated: (next: WalletPrefs) => void;
    onSwitched: (snapshot: WalletSnapshot) => void;
    onRequestOriginPermission?: (originPattern: string) => Promise<boolean>;
  }

  let {
    client,
    prefs,
    activeNodeUrl,
    defaultNodeUrl,
    onPrefsUpdated,
    onSwitched,
    onRequestOriginPermission
  }: Props = $props();

  let customUrlInput = $state("");
  let probeResult = $state<NodeProbeResultDto | null>(null);
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let successMsg = $state<string | null>(null);

  const primaryDefaultNode = $derived(defaultNodeUrl ?? DEFAULT_PUBLIC_NODE_URL);
  const effectiveActiveNode = $derived(activeNodeUrl ?? prefs.activePublicNode);

  const savedNodes = $derived.by(() => {
    const list: string[] = [primaryDefaultNode];
    if (DEFAULT_PUBLIC_NODE_URL !== primaryDefaultNode) {
      list.push(DEFAULT_PUBLIC_NODE_URL);
    }
    for (const u of prefs.customNodes) {
      if (!list.includes(u)) {
        list.push(u);
      }
    }
    if (effectiveActiveNode && !list.includes(effectiveActiveNode)) {
      list.push(effectiveActiveNode);
    }
    return list;
  });

  async function handleProbe(targetUrl: string): Promise<void> {
    errorMsg = null;
    successMsg = null;
    probeResult = null;
    let validated;
    try {
      validated = validateNodeUrl(targetUrl);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Invalid node URL";
      return;
    }

    busy = true;
    try {
      probeResult = await client.probeNode(validated.url);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Node probe failed";
    } finally {
      busy = false;
    }
  }

  async function handleGrantAndProbe(originPattern: string, targetUrl: string): Promise<void> {
    if (!onRequestOriginPermission) return;
    errorMsg = null;
    const granted = await onRequestOriginPermission(originPattern);
    if (!granted) {
      errorMsg = `Host permission for ${originPattern} was not granted.`;
      return;
    }
    await handleProbe(targetUrl);
  }

  async function handleSwitch(targetUrl: string, saveAsCustom: boolean): Promise<void> {
    errorMsg = null;
    successMsg = null;
    let validated;
    try {
      validated = validateNodeUrl(targetUrl);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Invalid node URL";
      return;
    }

    busy = true;
    try {
      const probe = await client.probeNode(validated.url);
      probeResult = probe;
      if (probe.permissionRequired) {
        errorMsg = `Grant host permission for ${probe.originPattern} before switching.`;
        return;
      }
      if (!probe.reachable) {
        errorMsg = probe.errorMessage ?? `Could not reach ${validated.host}`;
        return;
      }
      const snap = await client.switchNode(validated.url, saveAsCustom);
      onSwitched(snap);
      const updatedPrefs = await client.getPrefs();
      onPrefsUpdated(updatedPrefs);
      if (saveAsCustom) customUrlInput = "";
      successMsg = `Switched active node to ${validated.host}.`;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : "Failed to switch node";
    } finally {
      busy = false;
    }
  }
</script>

<section class="lt-panel lt-stack" data-testid="node-switcher">
  <div class="lt-panel-header">
    <div>
      <h2 class="lt-panel-title">Zephyr daemon node</h2>
      <p class="lt-panel-subtitle">
        Default: <code><bdi>{primaryDefaultNode}</bdi></code> (restricted RPC). Remote custom nodes
        must use HTTPS; plain HTTP is allowed for localhost only.
      </p>
    </div>
  </div>

  {#if errorMsg}
    <div class="lt-alert lt-alert-danger" role="alert" data-testid="node-error">
      <div class="lt-alert-body">{errorMsg}</div>
    </div>
  {/if}
  {#if successMsg}
    <div class="lt-alert lt-alert-success" role="status" data-testid="node-success">
      <div class="lt-alert-body">{successMsg}</div>
    </div>
  {/if}

  <div class="lt-subaddress-list">
    {#each savedNodes as nodeUrl (nodeUrl)}
      <div
        class={effectiveActiveNode === nodeUrl
          ? "lt-subaddress-row lt-subaddress-row-active"
          : "lt-subaddress-row"}
      >
        <div class="lt-meta-pills">
          <code><bdi>{nodeUrl}</bdi></code>
          {#if effectiveActiveNode === nodeUrl}
            <span class="lt-tx-badge lt-tx-confirmed">Active</span>
          {/if}
        </div>
        <div class="lt-meta-pills">
          <button
            type="button"
            class="lt-btn lt-btn-secondary"
            disabled={busy}
            onclick={() => handleProbe(nodeUrl)}
            data-testid={`probe-saved-${nodeUrl === primaryDefaultNode ? "default" : "custom"}`}
          >
            Test
          </button>
          {#if effectiveActiveNode !== nodeUrl}
            <button
              type="button"
              class="lt-btn lt-btn-primary"
              disabled={busy}
              onclick={() => handleSwitch(nodeUrl, false)}
            >
              Use
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <form
    onsubmit={(e) => {
      e.preventDefault();
      void handleProbe(customUrlInput);
    }}
    class="lt-stack"
  >
    <div class="lt-field">
      <label class="lt-label" for="custom-node-url">Add custom node URL</label>
      <div class="lt-input-group">
        <input
          id="custom-node-url"
          class="lt-input"
          type="url"
          bind:value={customUrlInput}
          placeholder="https://my-node.example.org or http://127.0.0.1:17767"
          autocomplete="off"
          spellcheck="false"
          disabled={busy}
          data-testid="custom-node-input"
        />
        <button
          type="submit"
          class="lt-btn lt-btn-secondary"
          disabled={busy || customUrlInput.trim().length === 0}
          data-testid="probe-custom-node-btn"
        >
          Probe
        </button>
        <button
          type="button"
          class="lt-btn lt-btn-primary"
          disabled={busy || customUrlInput.trim().length === 0}
          onclick={() => handleSwitch(customUrlInput, true)}
          data-testid="switch-custom-node-btn"
        >
          Save &amp; switch
        </button>
      </div>
    </div>
  </form>

  {#if probeResult}
    <div
      class={probeResult.reachable ? "lt-alert lt-alert-success" : "lt-alert lt-alert-warning"}
      role="status"
      data-testid="node-probe-result"
    >
      <div class="lt-alert-body">
        {#if probeResult.permissionRequired}
          Host permission is required for <code><bdi>{probeResult.originPattern}</bdi></code>.
        {:else if probeResult.reachable}
          Connected to <code><bdi>{probeResult.host}</bdi></code> · Height
          <strong>{probeResult.height?.toLocaleString("en-US") ?? "?"}</strong>
          {#if probeResult.network}
            · {probeResult.network}
          {/if}
          {#if probeResult.isSynchronized === false}
            · Daemon syncing
          {/if}
        {:else}
          {probeResult.errorMessage ?? "Node unreachable"}
        {/if}
      </div>
      {#if probeResult.permissionRequired && onRequestOriginPermission}
        <button
          type="button"
          class="lt-btn lt-btn-primary"
          onclick={() => handleGrantAndProbe(probeResult!.originPattern, probeResult!.url)}
          data-testid="grant-custom-node-perm-btn"
        >
          Grant permission
        </button>
      {/if}
    </div>
  {/if}
</section>
