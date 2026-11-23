import {
  DEFAULT_WALLET_PREFS,
  type PrefsStore,
  type WalletPrefs
} from "@lateo-wallet/core/storage";

const STORAGE_KEY = "lateo_prefs_v1";

export class ExtensionPrefsStore implements PrefsStore {
  async readPrefs(): Promise<WalletPrefs> {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const stored = raw[STORAGE_KEY] as Partial<WalletPrefs> | undefined;
    return {
      theme: stored?.theme ?? DEFAULT_WALLET_PREFS.theme,
      autoLockMinutes: stored?.autoLockMinutes ?? DEFAULT_WALLET_PREFS.autoLockMinutes,
      activePublicNode: stored?.activePublicNode ?? DEFAULT_WALLET_PREFS.activePublicNode
    };
  }

  async writePrefs(patch: Partial<WalletPrefs>): Promise<WalletPrefs> {
    const next = { ...(await this.readPrefs()), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }
}
