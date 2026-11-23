import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";

export const APP_SCHEME = "app";
export const APP_HOST = "lateo";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const DESKTOP_PAGE_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";

export const DESKTOP_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*";

const ALLOWED_RPC_RESOURCE_TYPES = new Set(["xhr"]);
const ALLOWED_RPC_METHODS = new Set(["GET", "POST", "OPTIONS"]);

export interface DaemonRequestInfo {
  readonly url: string;
  readonly resourceType: string;
  readonly method?: string;
  readonly initiatorOrigin?: string;
}

export function isAllowedAppNavigation(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.hostname === APP_HOST &&
      parsed.host === APP_HOST &&
      parsed.port === "" &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function isWorkerAssetPath(pathname: string): boolean {
  return /^\/assets\/zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(pathname);
}

/**
 * Resolve a normalized daemon origin (scheme + hostname + port) via validateNodeUrl.
 */
export function resolveDaemonOrigin(rawUrl: string): string | null {
  try {
    const validated = validateNodeUrl(rawUrl);
    return new URL(validated.url).origin;
  } catch {
    return null;
  }
}

export const DEFAULT_DAEMON_ORIGIN = new URL(DEFAULT_PUBLIC_NODE_URL).origin;

/**
 * Determine whether an outbound request from the sandboxed renderer/worker is
 * allowed to reach an explicitly authorized Zephyr daemon RPC origin directly
 * (blocking non-RPC loads, unconfigured loopback/internet hosts, wrong methods,
 * wrong initiators, and all network traffic in --offline mode).
 */
export function isAllowedDaemonRequest(
  request: DaemonRequestInfo,
  allowedOrigins: ReadonlySet<string>,
  offline: boolean
): boolean {
  if (request.url.startsWith(`${APP_ORIGIN}/`)) {
    return true;
  }
  if (offline) {
    return false;
  }
  if (!ALLOWED_RPC_RESOURCE_TYPES.has(request.resourceType)) {
    return false;
  }
  if (request.method !== undefined && !ALLOWED_RPC_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  if (request.initiatorOrigin !== undefined && request.initiatorOrigin !== APP_ORIGIN) {
    return false;
  }
  const origin = resolveDaemonOrigin(request.url);
  if (!origin) {
    return false;
  }
  return allowedOrigins.has(origin);
}

/**
 * Cancel HTTP 3xx redirects on outbound daemon requests so a malicious or
 * misconfigured remote node cannot redirect a POST into an unauthorized origin.
 */
export function shouldCancelDaemonRedirect(url: string, statusCode: number): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) {
    return false;
  }
  return statusCode >= 300 && statusCode < 400;
}

/**
 * Build an immutable static-file map rooted strictly inside `rootDir`, ignoring
 * symbolic links and any realpath escaping `rootDir`.
 */
export function buildStaticFileMap(rootDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(rootDir)) {
    return map;
  }
  const realRoot = fs.realpathSync(rootDir);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const realDir = fs.realpathSync(full);
        if (realDir.startsWith(rootPrefix)) {
          walk(full);
        }
      } else if (entry.isFile()) {
        const realFile = fs.realpathSync(full);
        if (!realFile.startsWith(rootPrefix)) {
          continue;
        }
        const rel = "/" + path.relative(realRoot, realFile).split(path.sep).join("/");
        map.set(rel, realFile);
      }
    }
  };
  walk(realRoot);
  return map;
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
