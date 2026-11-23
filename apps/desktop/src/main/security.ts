import { validateNodeUrl } from "@lateo-wallet/core/node-url";

export const APP_SCHEME = "app";
export const APP_HOST = "lateo";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const DESKTOP_PAGE_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";

export const DESKTOP_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*";

const ALLOWED_RPC_RESOURCE_TYPES = new Set(["xhr", "fetch", "other"]);

export function isAllowedAppNavigation(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST;
  } catch {
    return false;
  }
}

export function isWorkerAssetPath(pathname: string): boolean {
  return /^\/assets\/zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(pathname);
}

/**
 * Determine whether an outbound request from the sandboxed renderer/worker is
 * allowed to reach a Zephyr daemon RPC endpoint directly (without browser CORS
 * limits, while strictly enforcing validateNodeUrl and blocking non-RPC loads).
 */
export function isAllowedDaemonRequest(
  rawUrl: string,
  resourceType: string,
  offline: boolean
): boolean {
  if (rawUrl.startsWith(`${APP_ORIGIN}/`)) {
    return true;
  }
  if (offline) {
    return false;
  }
  if (!ALLOWED_RPC_RESOURCE_TYPES.has(resourceType)) {
    return false;
  }
  try {
    validateNodeUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export function withDaemonCorsHeaders(
  existing: Record<string, string[] | string> | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (existing) {
    for (const [key, val] of Object.entries(existing)) {
      const lower = key.toLowerCase();
      if (
        lower === "access-control-allow-origin" ||
        lower === "access-control-allow-methods" ||
        lower === "access-control-allow-headers"
      ) {
        continue;
      }
      out[key] = Array.isArray(val) ? [...val] : [val];
    }
  }
  out["Access-Control-Allow-Origin"] = [APP_ORIGIN];
  out["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
  out["Access-Control-Allow-Headers"] = ["Content-Type"];
  return out;
}
