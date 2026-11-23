export type ExtensionTarget = "chrome" | "firefox";

export const EXTENSION_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none';";

const ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
} as const;

export function buildManifest(forTarget: ExtensionTarget): Record<string, unknown> {
  const base: Record<string, unknown> = {
    manifest_version: 3,
    name: "Lateo — Wallet for Zephyr",
    short_name: "Lateo",
    version: "0.1.0",
    description: "Non-custodial multi-asset wallet for the Zephyr Protocol.",
    icons: ICONS,
    action: {
      default_title: "Lateo Wallet",
      default_popup: "popup.html",
      default_icon: ICONS
    },
    permissions:
      forTarget === "chrome"
        ? ["storage", "unlimitedStorage", "alarms", "offscreen", "sidePanel"]
        : ["storage", "unlimitedStorage", "alarms"],
    host_permissions: ["https://node.lateo.dev/*"],
    optional_host_permissions: [
      "https://*/*",
      "http://127.0.0.1/*",
      "http://localhost/*"
    ],
    content_security_policy: {
      extension_pages: EXTENSION_CSP
    }
  };

  if (forTarget === "chrome") {
    base.background = {
      service_worker: "background.js",
      type: "module"
    };
    base.side_panel = {
      default_path: "panel.html"
    };
  } else {
    base.background = {
      scripts: ["background-firefox.js"],
      type: "module"
    };
    base.browser_specific_settings = {
      gecko: {
        id: "wallet@lateo.dev",
        strict_min_version: "128.0"
      }
    };
  }

  return base;
}
