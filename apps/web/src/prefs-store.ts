import { sanitizeWalletPrefs } from "@lateo-wallet/core/prefs";
import type { PrefsStore, WalletPrefs } from "@lateo-wallet/core/storage";
import { resolveWebDefaultNodeUrl } from "./default-node.js";

export const WEB_PREFS_STORAGE_KEY = "lateo_wallet_prefs_v1";

export interface KeyValueStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WebPrefsStoreOptions {
  readonly storage?: KeyValueStorageLike | null;
  readonly defaultNodeUrl?: string;
}

function defaultStorage(): KeyValueStorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Non-sensitive UI preferences store backed by `localStorage`.
 * Strictly stores theme, idle auto-lock minutes, and node URLs only — never
 * stores keys, seeds, passwords, balances, or encrypted wallet blobs.
 */
export class WebPrefsStore implements PrefsStore {
  private readonly storage: KeyValueStorageLike | null;
  private readonly defaultNodeUrl: string;
  private memoryFallback: WalletPrefs;

  constructor(options: WebPrefsStoreOptions = {}) {
    this.storage = options.storage !== undefined ? options.storage : defaultStorage();
    this.defaultNodeUrl = options.defaultNodeUrl ?? resolveWebDefaultNodeUrl();
    this.memoryFallback = sanitizeWalletPrefs(undefined, this.defaultNodeUrl);
  }

  readPrefsSync(): WalletPrefs {
    if (!this.storage) {
      return this.memoryFallback;
    }
    try {
      const raw = this.storage.getItem(WEB_PREFS_STORAGE_KEY);
      if (!raw) {
        return sanitizeWalletPrefs(undefined, this.defaultNodeUrl);
      }
      const parsed = JSON.parse(raw) as Partial<WalletPrefs> | null;
      const sanitized = sanitizeWalletPrefs(
        parsed && typeof parsed === "object" ? parsed : undefined,
        this.defaultNodeUrl
      );
      this.memoryFallback = sanitized;
      return sanitized;
    } catch {
      return sanitizeWalletPrefs(undefined, this.defaultNodeUrl);
    }
  }

  async readPrefs(): Promise<WalletPrefs> {
    return this.readPrefsSync();
  }

  async writePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    const current = this.readPrefsSync();
    const next = sanitizeWalletPrefs(
      {
        theme: patch.theme !== undefined ? patch.theme : current.theme,
        autoLockMinutes:
          patch.autoLockMinutes !== undefined ? patch.autoLockMinutes : current.autoLockMinutes,
        activePublicNode:
          patch.activePublicNode !== undefined ? patch.activePublicNode : current.activePublicNode,
        customNodes: patch.customNodes !== undefined ? patch.customNodes : current.customNodes
      },
      this.defaultNodeUrl
    );
    this.memoryFallback = next;
    if (this.storage) {
      try {
        this.storage.setItem(WEB_PREFS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep in-memory copy if localStorage is unavailable or quota-limited
      }
    }
    return next;
  }
}
