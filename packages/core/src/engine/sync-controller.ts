import type { ZephyrWalletSyncResult } from "@loki-notfound/zephyr-ts";
import { retryWithBackoff, type RetryOptions } from "../network/backoff.js";
import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "../network/node-url.js";
import type { SyncStatusDto } from "../rpc/protocol.js";

export const DEFAULT_SYNC_INTERVAL_MS = 25_000;
export const DEFAULT_CHECKPOINT_BLOCK_STEP = 50;

export interface SyncAdapter {
  setDaemonConnection(url: string): Promise<void>;
  getHeight(): Promise<number>;
  getDaemonHeight(): Promise<number>;
  sync(
    onProgress: (height: number, startHeight: number, endHeight: number, percentDone: number) => void
  ): Promise<ZephyrWalletSyncResult>;
}

export interface SyncControllerOptions {
  readonly nodeUrl?: string;
  readonly intervalMs?: number;
  readonly checkpointBlockStep?: number;
  readonly retryOptions?: RetryOptions;
  readonly checkOriginPermission?: (originPattern: string) => Promise<boolean>;
  readonly onStatusChange?: (status: SyncStatusDto) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onCheckpointRequired: (walletHeight: number) => Promise<void>;
  readonly onSyncCompleted?: (result: ZephyrWalletSyncResult) => Promise<void>;
}

export class SyncController {
  private readonly intervalMs: number;
  private readonly checkpointBlockStep: number;
  private readonly retryOptions: RetryOptions;
  private readonly checkOriginPermission:
    | ((originPattern: string) => Promise<boolean>)
    | undefined;
  private readonly onStatusChange: ((status: SyncStatusDto) => void) | undefined;
  private readonly onBusyChange: ((busy: boolean) => void) | undefined;
  private readonly onCheckpointRequired: (walletHeight: number) => Promise<void>;
  private readonly onSyncCompleted: ((result: ZephyrWalletSyncResult) => Promise<void>) | undefined;

  private adapter: SyncAdapter | null = null;
  private nodeUrl: string;
  private nodeHost: string;
  private originPattern: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight: Promise<SyncStatusDto> | null = null;
  private highestDaemonHeight = 0;
  private initialSyncPersisted = false;
  private lastCheckpointHeight = 0;
  private status: SyncStatusDto;

  constructor(options: SyncControllerOptions) {
    const validated = validateNodeUrl(options.nodeUrl ?? DEFAULT_PUBLIC_NODE_URL);
    this.nodeUrl = validated.url;
    this.nodeHost = validated.host;
    this.originPattern = validated.originPattern;
    this.intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.checkpointBlockStep = options.checkpointBlockStep ?? DEFAULT_CHECKPOINT_BLOCK_STEP;
    this.retryOptions = {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      ...options.retryOptions
    };
    this.checkOriginPermission = options.checkOriginPermission;
    this.onStatusChange = options.onStatusChange;
    this.onBusyChange = options.onBusyChange;
    this.onCheckpointRequired = options.onCheckpointRequired;
    this.onSyncCompleted = options.onSyncCompleted;

    this.status = {
      state: "idle",
      nodeUrl: this.nodeUrl,
      nodeHost: this.nodeHost,
      walletHeight: 0,
      daemonHeight: 0,
      percentDone: 0,
      lastSyncedAt: null,
      lastCheckpointAt: null,
      errorMessage: null,
      permissionOriginRequired: null
    };
  }

  getStatus(): SyncStatusDto {
    return this.status;
  }

  getNodeUrl(): string {
    return this.nodeUrl;
  }

  private updateStatus(patch: Partial<SyncStatusDto>): void {
    this.status = { ...this.status, ...patch };
    this.onStatusChange?.(this.status);
  }

  private recordDaemonHeight(observed: number): number {
    if (Number.isSafeInteger(observed) && observed > this.highestDaemonHeight) {
      this.highestDaemonHeight = observed;
    }
    return this.highestDaemonHeight;
  }

  attach(adapter: SyncAdapter, initialWalletHeight = 0, lastCheckpointAt: number | null = null): void {
    this.adapter = adapter;
    this.initialSyncPersisted = initialWalletHeight > 0 && lastCheckpointAt !== null;
    this.lastCheckpointHeight = initialWalletHeight;
    this.updateStatus({
      state: "idle",
      walletHeight: initialWalletHeight,
      daemonHeight: this.highestDaemonHeight,
      lastCheckpointAt,
      errorMessage: null,
      permissionOriginRequired: null
    });
  }

  setNodeUrl(rawUrl: string): void {
    const validated = validateNodeUrl(rawUrl);
    const changed = validated.url !== this.nodeUrl;
    this.nodeUrl = validated.url;
    this.nodeHost = validated.host;
    this.originPattern = validated.originPattern;
    if (changed) {
      this.highestDaemonHeight = 0;
    }
    this.updateStatus({
      nodeUrl: this.nodeUrl,
      nodeHost: this.nodeHost,
      daemonHeight: this.highestDaemonHeight,
      errorMessage: null,
      permissionOriginRequired: null
    });
  }

  startBackgroundLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.adapter || this.syncInFlight) return;
      void this.syncOnce().catch(() => {
        // Sync state already transitioned cleanly to reconnecting/offline
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.adapter = null;
    this.highestDaemonHeight = 0;
    this.initialSyncPersisted = false;
    this.lastCheckpointHeight = 0;
    this.updateStatus({
      state: "idle",
      walletHeight: 0,
      daemonHeight: 0,
      percentDone: 0,
      errorMessage: null,
      permissionOriginRequired: null
    });
  }

  async syncOnce(): Promise<SyncStatusDto> {
    if (this.syncInFlight) return this.syncInFlight;
    const run = this.executeSyncOnce().finally(() => {
      if (this.syncInFlight === run) {
        this.syncInFlight = null;
      }
    });
    this.syncInFlight = run;
    return run;
  }

  private async executeSyncOnce(): Promise<SyncStatusDto> {
    const adapter = this.adapter;
    if (!adapter) {
      return this.status;
    }

    if (this.checkOriginPermission) {
      const granted = await this.checkOriginPermission(this.originPattern);
      if (this.adapter !== adapter) return this.status;
      if (!granted) {
        this.updateStatus({
          state: "permission-required",
          errorMessage: `Host permission required for ${this.nodeHost}`,
          permissionOriginRequired: this.originPattern
        });
        return this.status;
      }
    }

    this.onBusyChange?.(true);
    this.updateStatus({
      state: "syncing",
      errorMessage: null,
      permissionOriginRequired: null
    });

    try {
      await adapter.setDaemonConnection(this.nodeUrl);
      if (this.adapter !== adapter) return this.status;

      const daemonHeight = await retryWithBackoff(
        async (attempt) => {
          if (this.adapter !== adapter) return this.highestDaemonHeight;
          if (attempt > 1) {
            this.updateStatus({
              state: "reconnecting",
              errorMessage: `Reconnecting to ${this.nodeHost} (attempt ${attempt})...`
            });
          }
          return adapter.getDaemonHeight();
        },
        this.retryOptions
      );
      if (this.adapter !== adapter) return this.status;
      const monotonicDaemon = this.recordDaemonHeight(daemonHeight);
      const beforeHeight = await adapter.getHeight();
      if (this.adapter !== adapter) return this.status;
      this.updateStatus({
        state: "syncing",
        walletHeight: beforeHeight,
        daemonHeight: monotonicDaemon,
        errorMessage: null
      });

      const syncResult = await retryWithBackoff(
        async (attempt) => {
          if (attempt > 1 && this.adapter === adapter) {
            this.updateStatus({
              state: "reconnecting",
              errorMessage: `Retrying sync on ${this.nodeHost} (attempt ${attempt})...`
            });
          }
          return adapter.sync((height, _start, endHeight, percentDone) => {
            if (this.adapter !== adapter) return;
            const monoEnd = this.recordDaemonHeight(endHeight);
            this.updateStatus({
              state: "syncing",
              walletHeight: height,
              daemonHeight: monoEnd,
              percentDone: Math.max(0, Math.min(100, Math.round(percentDone * 100)))
            });
          });
        },
        this.retryOptions
      );
      if (this.adapter !== adapter) return this.status;

      const finalWalletHeight = await adapter.getHeight();
      if (this.adapter !== adapter) return this.status;
      const finalDaemonHeight = this.recordDaemonHeight(
        Math.max(monotonicDaemon, finalWalletHeight)
      );

      const shouldPersist =
        !this.initialSyncPersisted ||
        syncResult.receivedMoney ||
        syncResult.numBlocksFetched > 0 &&
          finalWalletHeight - this.lastCheckpointHeight >= this.checkpointBlockStep ||
        syncResult.numBlocksFetched > 0 && this.lastCheckpointHeight === 0;

      if (shouldPersist) {
        await this.onCheckpointRequired(finalWalletHeight);
        if (this.adapter !== adapter) return this.status;
        this.initialSyncPersisted = true;
        this.lastCheckpointHeight = finalWalletHeight;
        this.updateStatus({ lastCheckpointAt: Date.now() });
      }

      await this.onSyncCompleted?.(syncResult);
      if (this.adapter !== adapter) return this.status;

      this.updateStatus({
        state: "synced",
        walletHeight: finalWalletHeight,
        daemonHeight: finalDaemonHeight,
        percentDone: 100,
        lastSyncedAt: Date.now(),
        errorMessage: null,
        permissionOriginRequired: null
      });
      return this.status;
    } catch (err) {
      if (this.adapter !== adapter) return this.status;
      const msg =
        err instanceof Error && err.message
          ? `Could not sync with ${this.nodeHost}`
          : `Node ${this.nodeHost} unreachable`;
      this.updateStatus({
        state: "offline",
        errorMessage: msg
      });
      return this.status;
    } finally {
      this.onBusyChange?.(false);
    }
  }
}
