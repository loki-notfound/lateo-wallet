import { ZephyrWalletError } from "@loki-notfound/zephyr-ts";

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly shouldRetry?: (err: unknown) => boolean;
}

const TRANSIENT_DIAGNOSTICS = new Set([
  "DAEMON_UNREACHABLE",
  "DAEMON_NOT_CONNECTED",
  "DAEMON_BUSY",
  "DAEMON_RESPONSE",
  "PRICING_RECORD_UNAVAILABLE"
]);

export function isTransientDaemonError(err: unknown): boolean {
  if (err instanceof ZephyrWalletError) {
    if (err.code === "DAEMON_ERROR") {
      return err.diagnostic === undefined || TRANSIENT_DIAGNOSTICS.has(err.diagnostic);
    }
    return false;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("429") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("fetch")
    ) {
      return true;
    }
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded exponential-backoff retry with jitter for idempotent daemon reads.
 * Smooths over transient HA replica lag and 502/503/504 failover windows on node.lateo.dev.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 400);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 4_000);
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.25));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? isTransientDaemonError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitterFactor = 1 + (random() * 2 - 1) * jitterRatio;
      const delay = Math.max(1, Math.round(exp * jitterFactor));
      await sleep(delay);
    }
  }
  throw lastError;
}
