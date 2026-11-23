#!/usr/bin/env node
/**
 * Automated Phase 3 Desktop Electron offline smoke test.
 * Launches the sandboxed Electron app under xvfb-run when no DISPLAY is set,
 * verifies app:// protocol & strict CSP, minimal preload bridge, offline
 * disposable wallet creation + 3-word quiz, lock, full app restart, and
 * offline reopen from app:// IndexedDB with matching primary address.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const DESKTOP_ROOT = path.resolve(import.meta.dirname, "..");
const MAIN_ENTRY = path.join(DESKTOP_ROOT, "dist", "main", "main.cjs");
const CACHE_DIR = path.join(os.homedir(), ".cache", "lateo-wallet-browsers", "electron-cache");
const PW = "Desktop-Smoke-Pass!9";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function resolveElectronBinary() {
  if (process.env.ELECTRON_BIN && fs.existsSync(process.env.ELECTRON_BIN)) {
    return process.env.ELECTRON_BIN;
  }

  const pkgDir = path.join(DESKTOP_ROOT, "node_modules", "electron");
  const distBin = path.join(pkgDir, "dist", process.platform === "win32" ? "electron.exe" : "electron");
  if (fs.existsSync(distBin)) {
    return distBin;
  }

  const installScript = path.join(pkgDir, "install.js");
  assert(
    fs.existsSync(installScript),
    "Electron package not installed in apps/desktop/node_modules/electron"
  );

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log("Fetching checksum-verified Electron binary via electron/install.js...");
  execFileSync(process.execPath, [installScript], {
    cwd: pkgDir,
    stdio: "inherit",
    env: {
      ...process.env,
      electron_config_cache: CACHE_DIR
    }
  });
  assert(fs.existsSync(distBin), `Electron binary missing after install at ${distBin}`);
  return distBin;
}

async function launchApp(electronBin, userDataDir) {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [
      MAIN_ENTRY,
      "--offline",
      "--headless-smoke",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${userDataDir}`
    ],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "0"
    },
    timeout: 60_000
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  return { app, win };
}

async function main() {
  assert(fs.existsSync(MAIN_ENTRY), "Build apps/desktop first (corepack pnpm build:desktop)");

  // On headless Linux without DISPLAY, re-exec ourselves under xvfb-run transparently.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.LATEO_XVFB_WRAPPED) {
    execFileSync(
      "xvfb-run",
      ["-a", "-s", "-screen 0 1280x1024x24", process.execPath, import.meta.filename],
      {
        stdio: "inherit",
        env: { ...process.env, LATEO_XVFB_WRAPPED: "1" }
      }
    );
    return;
  }

  const electronBin = resolveElectronBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-desktop-smoke-"));
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];

  const attachMonitors = async (win, label) => {
    win.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
    });
    win.on("pageerror", (err) => pageErrors.push(`[${label}] ${err.message}`));
    await win.evaluate(() => {
      if (!window.__lateoCspTrap) {
        window.__lateoCspTrap = true;
        window.__lateoCspViolations = [];
        document.addEventListener("securitypolicyviolation", (ev) => {
          window.__lateoCspViolations.push({
            violatedDirective: ev.violatedDirective,
            blockedURI: ev.blockedURI
          });
        });
      }
    });
  };

  const assertGuards = async (win, label) => {
    const info = await win.evaluate(() => ({
      url: window.location.href,
      styleTags: document.querySelectorAll("style").length,
      inlineStyles: document.querySelectorAll("[style]").length,
      cspViolations: window.__lateoCspViolations ?? []
    }));
    assert(info.url.startsWith("app://lateo/"), `[${label}] Unexpected URL: ${info.url}`);
    assert(info.styleTags === 0, `[${label}] Found ${info.styleTags} <style> tags`);
    assert(info.inlineStyles === 0, `[${label}] Found ${info.inlineStyles} [style] attrs`);
    for (const v of info.cspViolations) {
      cspViolations.push(`[${label}] ${JSON.stringify(v)}`);
    }
  };

  try {
    // Session 1: Launch -> verify preload isolation -> create disposable wallet offline -> quiz -> lock
    const s1 = await launchApp(electronBin, userDataDir);
    let createdAddr = "";
    let bridgeInfo;
    try {
      await s1.win.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 30_000 });
      await attachMonitors(s1.win, "session-1");
      await assertGuards(s1.win, "welcome");

      bridgeInfo = await s1.win.evaluate(async () => ({
        hasRequire: typeof window.require !== "undefined",
        hasProcess: typeof window.process !== "undefined",
        bridgeKeys: window.lateoDesktop ? Object.keys(window.lateoDesktop).sort() : [],
        version: window.lateoDesktop?.version ?? null,
        platform: window.lateoDesktop?.platform ?? null,
        safeStorage: window.lateoDesktop ? await window.lateoDesktop.isSafeStorageAvailable() : null
      }));
      assert(!bridgeInfo.hasRequire && !bridgeInfo.hasProcess, `Node globals leaked: ${JSON.stringify(bridgeInfo)}`);
      assert(
        JSON.stringify(bridgeInfo.bridgeKeys) ===
          JSON.stringify(["isSafeStorageAvailable", "platform", "version"]),
        `Unexpected preload bridge keys: ${JSON.stringify(bridgeInfo.bridgeKeys)}`
      );

      await s1.win.click('[data-testid="choose-create-btn"]');
      await s1.win.fill('[data-testid="create-password"]', PW);
      await s1.win.fill('[data-testid="create-confirm"]', PW);
      await s1.win.click('[data-testid="create-submit-btn"]');

      await s1.win.waitForSelector('[data-testid="seed-backup-panel"]', { timeout: 60_000 });
      const seedWords = await s1.win.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="seed-word-grid"] li code')).map((e) =>
          (e.textContent ?? "").trim()
        )
      );
      assert(seedWords.length === 25, `Desktop: expected 25 seed words, got ${seedWords.length}`);

      await s1.win.click('[data-testid="start-quiz-btn"]');
      await s1.win.waitForSelector('[data-testid="seed-quiz-form"]', { timeout: 10_000 });
      const quizPos = await s1.win.evaluate(() =>
        Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) =>
          Number(el.getAttribute("data-quiz-pos"))
        )
      );
      for (const pos of quizPos) {
        await s1.win.fill(`[data-testid="quiz-input-${pos}"]`, seedWords[pos - 1]);
      }
      await s1.win.click('[data-testid="verify-quiz-btn"]');
      await s1.win.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 30_000 });

      createdAddr = (await s1.win.textContent('[data-testid="primary-address"]'))
        ?.replace(/\s+/g, "")
        .trim();
      assert(createdAddr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Invalid address: ${createdAddr}`);
      assert(
        (await s1.win.textContent('[data-testid="diag-host-kind"]'))?.trim() === "electron-renderer",
        "Desktop: expected hostKind === electron-renderer"
      );

      for (const code of ["ZPH", "ZSD", "ZRS", "ZYS"]) {
        await s1.win.waitForSelector(`[data-testid="balance-card-${code}"]`, { timeout: 5_000 });
      }

      await s1.win.click('[data-testid="lock-btn"]');
      await s1.win.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
      await assertGuards(s1.win, "session-1-locked");
    } finally {
      await s1.app.close();
    }

    // Session 2: Cold Electron restart with same userDataDir -> unlock offline -> verify exact address
    const s2 = await launchApp(electronBin, userDataDir);
    let electronVersion = "unknown";
    try {
      electronVersion = await s2.app.evaluate(() => process.versions.electron);
      await s2.win.waitForSelector('[data-testid="unlock-screen"]', { timeout: 30_000 });
      await attachMonitors(s2.win, "session-2");
      await assertGuards(s2.win, "session-2-locked");

      await s2.win.fill('[data-testid="unlock-password-input"]', PW);
      await s2.win.click('[data-testid="unlock-submit-btn"]');
      await s2.win.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 60_000 });

      const reopenedAddr = (await s2.win.textContent('[data-testid="primary-address"]'))
        ?.replace(/\s+/g, "")
        .trim();
      assert(reopenedAddr === createdAddr, `Address mismatch after cold restart`);

      await s2.win.click('[data-testid="lock-btn"]');
      await s2.win.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
      await assertGuards(s2.win, "session-2-final");
    } finally {
      await s2.app.close();
    }

    assert(consoleErrors.length === 0, `Desktop console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Desktop page errors: ${pageErrors.join(" | ")}`);
    assert(cspViolations.length === 0, `Desktop CSP violations: ${cspViolations.join(" | ")}`);

    console.log(
      "Desktop Electron PASS:",
      JSON.stringify(
        {
          electronVersion,
          scheme: "app://lateo",
          preloadBridgeVerified: true,
          safeStorageAvailable: bridgeInfo.safeStorage,
          coldRestartOfflineReopenVerified: true,
          consoleErrors: 0,
          cspViolations: 0
        },
        null,
        2
      )
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
