import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "../network/node-url.js";
import { DEFAULT_WALLET_PREFS, type ThemePreference, type WalletPrefs } from "./types.js";

const VALID_THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const MIN_AUTO_LOCK_MINUTES = 1;
const MAX_AUTO_LOCK_MINUTES = 1440;
const MAX_CUSTOM_NODES = 20;

function normalizeDefaultNode(defaultNodeUrl?: string): string {
  if (!defaultNodeUrl) return DEFAULT_PUBLIC_NODE_URL;
  try {
    return validateNodeUrl(defaultNodeUrl).url;
  } catch {
    return DEFAULT_PUBLIC_NODE_URL;
  }
}

function sanitizeTheme(value: unknown): ThemePreference {
  if (typeof value === "string" && VALID_THEMES.has(value as ThemePreference)) {
    return value as ThemePreference;
  }
  return DEFAULT_WALLET_PREFS.theme;
}

function sanitizeAutoLockMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WALLET_PREFS.autoLockMinutes;
  }
  const rounded = Math.trunc(value);
  return Math.max(MIN_AUTO_LOCK_MINUTES, Math.min(MAX_AUTO_LOCK_MINUTES, rounded));
}

function sanitizeNodeUrl(value: unknown, fallbackNodeUrl: string): string {
  if (typeof value !== "string") return fallbackNodeUrl;
  try {
    return validateNodeUrl(value).url;
  } catch {
    return fallbackNodeUrl;
  }
}

function sanitizeCustomNodes(value: unknown, builtInNodes: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const normalized = validateNodeUrl(item).url;
      if (builtInNodes.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= MAX_CUSTOM_NODES) break;
    } catch {
      // Skip invalid custom node entries
    }
  }
  return out;
}

export function sanitizeWalletPrefs(
  raw: Partial<WalletPrefs> | undefined,
  defaultNodeUrl?: string
): WalletPrefs {
  const fallbackNode = normalizeDefaultNode(defaultNodeUrl);
  const builtInNodes = new Set<string>([DEFAULT_PUBLIC_NODE_URL, fallbackNode]);
  return {
    theme: sanitizeTheme(raw?.theme),
    autoLockMinutes: sanitizeAutoLockMinutes(raw?.autoLockMinutes),
    activePublicNode: sanitizeNodeUrl(raw?.activePublicNode, fallbackNode),
    customNodes: sanitizeCustomNodes(raw?.customNodes, builtInNodes)
  };
}
