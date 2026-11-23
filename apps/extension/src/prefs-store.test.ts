import { describe, expect, it } from "vitest";
import { sanitizeWalletPrefs } from "./shared/prefs-store.js";

describe("ExtensionPrefsStore preference sanitization", () => {
  it("clamps autoLockMinutes to 1..1440, validates theme, and sanitizes node URLs", () => {
    expect(sanitizeWalletPrefs({ autoLockMinutes: 0 }).autoLockMinutes).toBe(1);
    expect(sanitizeWalletPrefs({ autoLockMinutes: -5 }).autoLockMinutes).toBe(1);
    expect(sanitizeWalletPrefs({ autoLockMinutes: 99_999 }).autoLockMinutes).toBe(1440);
    expect(sanitizeWalletPrefs({ autoLockMinutes: Number.NaN }).autoLockMinutes).toBe(15);
    expect(sanitizeWalletPrefs({ autoLockMinutes: 15.9 }).autoLockMinutes).toBe(15);

    expect(sanitizeWalletPrefs({ theme: "invalid" as "dark" }).theme).toBe("system");
    expect(sanitizeWalletPrefs({ theme: "dark" }).theme).toBe("dark");

    expect(sanitizeWalletPrefs({ activePublicNode: "http://evil.example.org" }).activePublicNode).toBe(
      "https://node.lateo.dev"
    );
    expect(
      sanitizeWalletPrefs({ activePublicNode: "https://custom.example.org:17767/" }).activePublicNode
    ).toBe("https://custom.example.org:17767");

    const custom = sanitizeWalletPrefs({
      customNodes: [
        "https://node.lateo.dev",
        "http://evil.example.org",
        "https://a.example.org/",
        "https://a.example.org",
        "http://127.0.0.1:17767/"
      ]
    }).customNodes;
    expect(custom).toEqual(["https://a.example.org", "http://127.0.0.1:17767"]);
  });
});
