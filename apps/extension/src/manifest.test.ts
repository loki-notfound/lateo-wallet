import { describe, expect, it } from "vitest";
import { buildManifest, EXTENSION_CSP } from "../scripts/manifest-builder.js";

describe("deterministic MV3 manifest builder", () => {
  it("builds strict Chrome MV3 manifest with offscreen + sidePanel and zero content scripts", () => {
    const chrome = buildManifest("chrome");
    expect(chrome.manifest_version).toBe(3);
    expect(chrome.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "alarms",
      "offscreen",
      "sidePanel"
    ]);
    expect(chrome.host_permissions).toEqual(["https://node.lateo.dev/*"]);
    expect(chrome.content_scripts).toBeUndefined();
    expect(chrome.side_panel).toEqual({ default_path: "panel.html" });
    expect(chrome.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(chrome.minimum_chrome_version).toBe("116");
    expect(chrome.content_security_policy).toEqual({ extension_pages: EXTENSION_CSP });
  });

  it("builds strict Firefox MV3 manifest with Event Page scripts and gecko id", () => {
    const firefox = buildManifest("firefox");
    expect(firefox.manifest_version).toBe(3);
    expect(firefox.permissions).toEqual(["storage", "unlimitedStorage", "alarms"]);
    expect(firefox.host_permissions).toEqual(["https://node.lateo.dev/*"]);
    expect(firefox.content_scripts).toBeUndefined();
    expect(firefox.side_panel).toBeUndefined();
    expect(firefox.background).toEqual({ scripts: ["background-firefox.js"], type: "module" });
    expect(firefox.browser_specific_settings).toEqual({
      gecko: {
        id: "wallet@lateo.dev",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] }
      }
    });
    expect(firefox.content_security_policy).toEqual({ extension_pages: EXTENSION_CSP });
  });
});
