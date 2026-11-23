export const DEFAULT_PUBLIC_NODE_URL = "https://node.lateo.dev";

export interface ValidatedNodeUrl {
  /** Normalized final daemon URL without query string, fragment, credentials, or trailing slash */
  readonly url: string;
  /** MV3 host_permissions / optional_host_permissions origin pattern (e.g. "https://node.lateo.dev/*") */
  readonly originPattern: string;
  /** Display host (hostname + optional non-default port) */
  readonly host: string;
  readonly isLocal: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Strictly validate a Zephyr daemon RPC URL:
 * - Remote hosts MUST use https://
 * - Plain http:// is allowed ONLY for localhost / 127.0.0.1 / [::1]
 * - Rejects embedded credentials, query strings (zephyrd returns 404), and fragments
 */
export function validateNodeUrl(raw: string): ValidatedNodeUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Node URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid node URL format");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Node URL must not contain embedded credentials");
  }
  if (parsed.search) {
    throw new Error("Node URL must not contain query parameters");
  }
  if (parsed.hash) {
    throw new Error("Node URL must not contain a URL fragment");
  }

  const hostLower = parsed.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(hostLower);

  if (parsed.protocol === "https:") {
    // Allowed for both remote and local hosts
  } else if (parsed.protocol === "http:") {
    if (!isLocal) {
      throw new Error("Remote nodes must use HTTPS (HTTP is allowed for localhost only)");
    }
  } else {
    throw new Error("Node URL must use https:// (or http:// for localhost)");
  }

  if (!parsed.hostname) {
    throw new Error("Node URL must specify a hostname");
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const normalizedUrl = `${parsed.origin}${cleanPath}`;
  // Extension match patterns omit ports so Firefox and Chrome permissions.request/contains accept them.
  const originPattern = `${parsed.protocol}//${parsed.hostname}/*`;

  return {
    url: normalizedUrl,
    originPattern,
    host: parsed.host,
    isLocal
  };
}
