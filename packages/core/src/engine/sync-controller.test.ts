import { describe, expect, it } from "vitest";
import { ZephyrWalletError } from "@loki-notfound/zephyr-ts";
import { SyncController, type SyncAdapter } from "./sync-controller.js";

describe("SyncController HA resilience", () => {
  it("enforces monotonic daemon height, retries transient errors, and triggers checkpoints", async () => {
    let daemonHeights = [910_010, 910_008]; // second replica lags by 2 blocks
    let walletHeight = 910_000;
    let getDaemonCalls = 0;
    let checkpoints = 0;
    const states: string[] = [];

    const adapter: SyncAdapter = {
      setDaemonConnection: async () => {},
      getHeight: async () => walletHeight,
      getDaemonHeight: async () => {
        getDaemonCalls++;
        if (getDaemonCalls === 1) {
          throw new ZephyrWalletError("DAEMON_ERROR", "DAEMON_UNREACHABLE");
        }
        return daemonHeights.shift() ?? 910_008;
      },
      sync: async (onProgress) => {
        walletHeight = 910_010;
        onProgress(910_010, 910_000, 910_010, 1);
        return { numBlocksFetched: 10, receivedMoney: false };
      }
    };

    const controller = new SyncController({
      nodeUrl: "https://node.lateo.dev",
      retryOptions: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {} },
      onStatusChange: (s) => states.push(s.state),
      onCheckpointRequired: async () => {
        checkpoints++;
      }
    });

    controller.attach(adapter, 910_000, null);
    const first = await controller.syncOnce();
    expect(first.state).toBe("synced");
    expect(first.daemonHeight).toBe(910_010);
    expect(first.walletHeight).toBe(910_010);
    expect(checkpoints).toBe(1);
    expect(states).toContain("reconnecting");

    // Second sync hits a lagging replica (910_008): daemonHeight MUST NOT regress
    const second = await controller.syncOnce();
    expect(second.state).toBe("synced");
    expect(second.daemonHeight).toBe(910_010);
  });

  it("reports permission-required when host permission is missing", async () => {
    const controller = new SyncController({
      nodeUrl: "https://node.lateo.dev",
      checkOriginPermission: async () => false,
      onCheckpointRequired: async () => {}
    });
    controller.attach(
      {
        setDaemonConnection: async () => {},
        getHeight: async () => 0,
        getDaemonHeight: async () => 0,
        sync: async () => ({ numBlocksFetched: 0, receivedMoney: false })
      },
      0,
      null
    );

    const status = await controller.syncOnce();
    expect(status.state).toBe("permission-required");
    expect(status.permissionOriginRequired).toBe("https://node.lateo.dev/*");
  });

  it("never emits a stale synced status if stop() is called while sync is in flight", async () => {
    const states: string[] = [];
    let controller!: SyncController;

    const adapter: SyncAdapter = {
      setDaemonConnection: async () => {},
      getHeight: async () => 910_000,
      getDaemonHeight: async () => 910_010,
      sync: async () => {
        // Simulate wallet lock/stop happening while WASM sync is in-flight
        controller.stop();
        return { numBlocksFetched: 10, receivedMoney: false };
      }
    };

    controller = new SyncController({
      nodeUrl: "https://node.lateo.dev",
      onStatusChange: (s) => states.push(s.state),
      onCheckpointRequired: async () => {
        throw new Error("Should not checkpoint after stop()");
      }
    });

    controller.attach(adapter, 910_000, null);
    const finalStatus = await controller.syncOnce();
    expect(finalStatus.state).toBe("idle");
    expect(states[states.length - 1]).toBe("idle");
    expect(states).not.toContain("synced");
  });
});
