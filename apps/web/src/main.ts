import "@lateo-wallet/ui/styles";
import type { ThemePreference } from "@lateo-wallet/core/storage";
import { mount } from "svelte";
import { WalletApp } from "@lateo-wallet/ui";
import { WebWalletClient } from "./web-wallet-client.js";

function applyTheme(theme: ThemePreference): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

const target = document.getElementById("app");
if (!target) {
  throw new Error("Missing #app mount root");
}

const client = new WebWalletClient();

mount(WalletApp, {
  target,
  props: {
    client,
    surface: "tab",
    defaultNodeUrl: client.defaultNodeUrl,
    onThemeApplied: applyTheme
  }
});
