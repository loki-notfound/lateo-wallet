import { DEFAULT_PUBLIC_NODE_URL, validateNodeUrl } from "@lateo-wallet/core/node-url";
import {
  DEFAULT_WALLET_PREFS,
  type PrefsStore,
  type ThemePreference,
  type WalletPrefs
} from "@lateo-wallet/core/storage";

const STORAGE_KEY = "lateo_prefs_v1";
const VALID_THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const MIN_AUTO_LOCK_MINUTES = 1;
const MAX_AUTO_LOCK_MINUTES = 1440;
const MAX_CUSTOM_NODES = 20;

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

function sanitizeNodeUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PUBLIC_NODE_URL;
  try {
    return validateNodeUrl(value).url;
  } catch {
    return DEFAULT_PUBLIC_NODE_URL;
  }
}

function sanitizeCustomNodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const normalized = validateNodeUrl(item).url;
      if (normalized === DEFAULT_PUBLIC_NODE_URL || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= MAX_CUSTOM_NODES) break;
    } catch {
      // Skip invalid custom node entries
    }
  }
  return out;
}

export function sanitizeWalletPrefs(raw: Partial<WalletPrefs> | undefined): WalletPrefs {
  return {
    theme: sanitizeTheme(raw?.theme),
    autoLockMinutes: sanitizeAutoLockMinutes(raw?.autoLockMinutes),
    activePublicNode: sanitizeNodeUrl(raw?.activePublicNode),
    customNodes: sanitizeCustomNodes(raw?.customNodes)
  };
}

export class ExtensionPrefsStore implements PrefsStore {
  async readPrefs(): Promise<WalletPrefs> {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const stored = raw[STORAGE_KEY] as Partial<WalletPrefs> | undefined;
    return sanitizeWalletPrefs(stored);
  }

  async writePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    const current = await this.readPrefs();
    const next = sanitizeWalletPrefs({
      theme: patch.theme !== undefined ? patch.theme : current.theme,
      autoLockMinutes:
        patch.autoLockMinutes !== undefined ? patch.autoLockMinutes : current.autoLockMinutes,
      activePublicNode:
        patch.activePublicNode !== undefined ? patch.activePublicNode : current.activePublicNode,
      customNodes: patch.customNodes !== undefined ? patch.customNodes : current.customNodes
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }
}
