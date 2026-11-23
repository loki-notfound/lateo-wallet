import { sanitizeWalletPrefs } from "@lateo-wallet/core/prefs";
import type { PrefsStore, WalletPrefs } from "@lateo-wallet/core/storage";

const STORAGE_KEY = "lateo_prefs_v1";

export { sanitizeWalletPrefs };

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
