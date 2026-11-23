import "@lateo-wallet/ui/styles";
import type { ThemePreference } from "@lateo-wallet/core/storage";
import { mount } from "svelte";
import { WalletApp, type SurfaceMode } from "@lateo-wallet/ui";
import { PortWalletClient } from "../shared/port-client.js";

function applyTheme(theme: ThemePreference): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

export function mountExtensionSurface(surface: SurfaceMode): void {
  const target = document.getElementById("app");
  if (!target) {
    throw new Error("Missing #app mount root");
  }

  const client = new PortWalletClient();

  const onOpenFullTab = (): void => {
    const url = chrome.runtime.getURL("app.html");
    window.open(url, "_blank", "noopener");
  };

  const canOpenSidePanel =
    surface === "popup" &&
    typeof chrome.sidePanel !== "undefined" &&
    typeof chrome.sidePanel.open === "function";

  const onOpenSidePanel = canOpenSidePanel
    ? (): void => {
        void chrome.windows.getCurrent().then((win) => {
          if (win.id !== undefined) {
            return chrome.sidePanel.open({ windowId: win.id });
          }
          return undefined;
        });
      }
    : undefined;

  const onRequestOriginPermission = async (originPattern: string): Promise<boolean> => {
    try {
      return await chrome.permissions.request({ origins: [originPattern] });
    } catch {
      return false;
    }
  };

  mount(WalletApp, {
    target,
    props: {
      client,
      surface,
      onOpenFullTab,
      onThemeApplied: applyTheme,
      onRequestOriginPermission,
      ...(onOpenSidePanel ? { onOpenSidePanel } : {})
    }
  });
}
