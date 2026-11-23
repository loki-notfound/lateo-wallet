import "@lateo-wallet/ui/styles";
import { mount } from "svelte";
import { SpikeApp, type SurfaceMode } from "@lateo-wallet/ui";
import { PortWalletClient } from "../shared/port-client.js";

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

  mount(SpikeApp, {
    target,
    props: {
      client,
      surface,
      onOpenFullTab,
      ...(onOpenSidePanel ? { onOpenSidePanel } : {})
    }
  });
}
