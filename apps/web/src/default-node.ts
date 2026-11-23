import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";

export interface OriginLike {
  readonly origin?: string;
}

/**
 * Resolve the default Zephyr daemon RPC URL for the Web PWA:
 * - On an HTTPS origin (e.g. `https://wallet.lateo.dev`) or localhost/127.0.0.1,
 *   default to the same-origin `/rpc` reverse proxy so daemon calls avoid CORS.
 * - Otherwise fall back to the public node (`https://node.lateo.dev`).
 */
export function resolveWebDefaultNodeUrl(locationObj?: OriginLike | null): string {
  const loc = locationObj ?? (typeof window !== "undefined" ? window.location : null);
  const origin = loc?.origin;
  if (!origin || origin === "null") {
    return DEFAULT_PUBLIC_NODE_URL;
  }
  try {
    return validateNodeUrl(`${origin}/rpc`).url;
  } catch {
    return DEFAULT_PUBLIC_NODE_URL;
  }
}
