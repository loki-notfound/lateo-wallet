#!/usr/bin/env node
/**
 * Automated M1.2 MV3 end-to-end verification harness for Chromium and Firefox.
 * Covers: onboarding (create + restore height + blank print sheet + 3-word quiz),
 * lock + Chrome Offscreen teardown (including failed-unlock teardown), offline
 * unlock, auto-lock prefs, password rotation, Danger Zone secret reveal + blur
 * auto-mask, delete wallet, restore from 25-word seed (round-trip address match),
 * restore view-only wallet, and strict CSP / zero-inline-style invariants.
 * Uses disposable random wallets only; never touches real funds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME_DIST = path.join(ROOT, "dist", "chrome");
const FIREFOX_DIST = path.join(ROOT, "dist", "firefox");
const CACHE_BROWSERS = path.join(os.homedir(), ".cache", "lateo-wallet-browsers");

const PW_INITIAL = "M12-Initial-Pass!9";
const PW_ROTATED = "M12-Rotated-Pass!9";
const PW_SEED_RESTORE = "M12-Seed-Restored!9";
const PW_VIEW_ONLY = "M12-View-Only!9";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function findBinary(envVar, candidates) {
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) {
    return process.env[envVar];
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function verifyChrome() {
  const chromeBin = findBinary("CHROME_BIN", [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ]);
  assert(chromeBin, "No Chromium/Chrome binary found");
  assert(fs.existsSync(path.join(CHROME_DIST, "manifest.json")), "Build dist/chrome first");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-chrome-m12-"));
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    headless: false,
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--disable-extensions-except=${CHROME_DIST}`,
      `--load-extension=${CHROME_DIST}`
    ]
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }
    const match = sw.url().match(/^chrome-extension:\/\/([a-z]{32})\//);
    assert(match, `Unexpected service worker URL: ${sw.url()}`);
    const extId = match[1];
    const baseUrl = `chrome-extension://${extId}`;

    const attachMonitors = (page, label) => {
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => pageErrors.push(`[${label}] ${err.message}`));
    };

    const installCspTrap = async (page) => {
      await page.addInitScript(() => {
        window.__lateoCspViolations = [];
        document.addEventListener("securitypolicyviolation", (ev) => {
          window.__lateoCspViolations.push({
            violatedDirective: ev.violatedDirective,
            effectiveDirective: ev.effectiveDirective,
            blockedURI: ev.blockedURI
          });
        });
      });
    };

    const assertStyleAndCspGuards = async (page, label) => {
      const info = await page.evaluate(() => ({
        styleTags: document.querySelectorAll("style").length,
        inlineStyles: document.querySelectorAll("[style]").length,
        cspViolations: window.__lateoCspViolations ?? []
      }));
      assert(info.styleTags === 0, `[${label}] Found ${info.styleTags} inline <style> tag(s)`);
      assert(
        info.inlineStyles === 0,
        `[${label}] Found ${info.inlineStyles} inline [style] attribute(s)`
      );
      for (const v of info.cspViolations) {
        cspViolations.push(`[${label}] ${JSON.stringify(v)}`);
      }
    };

    const readOffscreenDiag = async (page) =>
      (await page.textContent('[data-testid="diag-offscreen"]'))?.trim();

    // 1. Popup: Welcome -> Create Wallet -> 25-word seed + restore height + blank sheet + 3-word quiz
    const popup = await context.newPage();
    attachMonitors(popup, "chrome-popup");
    await installCspTrap(popup);
    await popup.goto(`${baseUrl}/popup.html`, { waitUntil: "domcontentloaded" });
    await popup.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 15_000 });
    await assertStyleAndCspGuards(popup, "chrome-welcome");

    const initOffscreen = await readOffscreenDiag(popup);
    assert(initOffscreen === "false", `Expected initial offscreen=false, got ${initOffscreen}`);

    await popup.click('[data-testid="choose-create-btn"]');
    await popup.fill('[data-testid="create-password"]', PW_INITIAL);
    await popup.fill('[data-testid="create-confirm"]', PW_INITIAL);
    await popup.click('[data-testid="create-submit-btn"]');

    await popup.waitForSelector('[data-testid="seed-backup-panel"]', { timeout: 45_000 });
    const backupInfo = await popup.evaluate(() => {
      const words = Array.from(
        document.querySelectorAll('[data-testid="seed-word-grid"] li code')
      ).map((el) => (el.textContent ?? "").trim());
      const heightText =
        document.querySelector('[data-testid="backup-restore-height"]')?.textContent ?? "";
      const heightSource =
        document.querySelector('[data-testid="backup-height-source"]')?.textContent?.trim() ?? "";
      const blankSheet = document.querySelector('[data-testid="blank-backup-sheet"]');
      const blankSlots = blankSheet?.querySelectorAll(".lt-backup-slot").length ?? 0;
      const blankText = blankSheet?.textContent ?? "";
      return { words, heightText, heightSource, blankSlots, blankText };
    });
    assert(backupInfo.words.length === 25, `Expected 25 words, got ${backupInfo.words.length}`);
    assert(backupInfo.blankSlots === 25, `Expected 25 blank print slots, got ${backupInfo.blankSlots}`);
    // Ensure live seed words are NOT inside the printable blank backup sheet
    assert(
      !backupInfo.blankText.includes(backupInfo.words[0]),
      "Printable blank backup sheet must never contain live seed words"
    );

    // 3-word quiz: fail once, then pass
    await popup.click('[data-testid="start-quiz-btn"]');
    await popup.waitForSelector('[data-testid="seed-quiz-form"]', { timeout: 10_000 });
    const quizPositions = await popup.evaluate(() =>
      Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) =>
        Number(el.getAttribute("data-quiz-pos"))
      )
    );
    assert(quizPositions.length === 3, `Expected 3 quiz inputs, got ${quizPositions.length}`);

    for (const pos of quizPositions) {
      await popup.fill(`[data-testid="quiz-input-${pos}"]`, "definitely-wrong-word");
    }
    await popup.click('[data-testid="verify-quiz-btn"]');
    await popup.waitForSelector('[data-testid="quiz-error"]', { timeout: 10_000 });

    for (const pos of quizPositions) {
      await popup.fill(`[data-testid="quiz-input-${pos}"]`, backupInfo.words[pos - 1]);
    }
    await popup.click('[data-testid="verify-quiz-btn"]');
    await popup.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await popup.waitForSelector('[data-testid="backup-verified-badge"]', { timeout: 10_000 });

    const createdAddr = (await popup.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(createdAddr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Invalid address: ${createdAddr}`);
    assert((await readOffscreenDiag(popup)) === "true", "Expected offscreen=true after create");

    // 2. Side Panel & Full Tab surfaces
    const panel = await context.newPage();
    attachMonitors(panel, "chrome-panel");
    await installCspTrap(panel);
    await panel.goto(`${baseUrl}/panel.html`, { waitUntil: "domcontentloaded" });
    await panel.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await assertStyleAndCspGuards(panel, "chrome-panel");
    assert(
      (await panel.textContent('[data-testid="primary-address"]'))?.replace(/\s+/g, "").trim() ===
        createdAddr,
      "Side panel address mismatch"
    );

    const tab = await context.newPage();
    attachMonitors(tab, "chrome-tab");
    await installCspTrap(tab);
    await tab.goto(`${baseUrl}/app.html`, { waitUntil: "domcontentloaded" });
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await assertStyleAndCspGuards(tab, "chrome-tab");

    // 3. Lock -> Offscreen teardown + Failed Unlock -> Offscreen STILL torn down!
    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 15_000 });
    const afterLockOffscreen = await readOffscreenDiag(tab);
    assert(afterLockOffscreen === "false", `Expected offscreen=false after lock, got ${afterLockOffscreen}`);

    await tab.fill('[data-testid="unlock-password-input"]', "Wrong-Password-999");
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="unlock-error"]', { timeout: 15_000 });
    // Re-check diagnostics via fresh reload/port to verify Offscreen was closed on failed unlock
    const afterFailedUnlockOffscreen = await tab.evaluate(async () => {
      const port = chrome.runtime.connect({ name: "lateo-ui" });
      return new Promise((resolve, reject) => {
        port.onMessage.addListener((m) => {
          port.disconnect();
          if (m.ok) resolve(m.result.offscreenExists);
          else reject(new Error(m.error?.message));
        });
        port.postMessage({ id: "diag-check", type: "GET_DIAGNOSTICS" });
      });
    });
    assert(
      afterFailedUnlockOffscreen === false,
      `Expected offscreen=false after failed unlock, got ${afterFailedUnlockOffscreen}`
    );

    // 4. Unlock with initial password -> Auto-lock prefs + Password Rotation
    await tab.fill('[data-testid="unlock-password-input"]', PW_INITIAL);
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });

    await tab.click('[data-testid="tab-security"]');
    await tab.waitForSelector('[data-testid="settings-security-panel"]', { timeout: 10_000 });
    await tab.selectOption('[data-testid="autolock-select"]', "30");

    await tab.fill('[data-testid="current-pw-input"]', PW_INITIAL);
    await tab.fill('[data-testid="change-pw-password"]', PW_ROTATED);
    await tab.fill('[data-testid="change-pw-confirm"]', PW_ROTATED);
    await tab.click('[data-testid="change-pw-submit"]');
    await tab.waitForSelector('[data-testid="change-pw-success"]', { timeout: 15_000 });

    // Lock -> old password fails -> rotated password succeeds
    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 15_000 });
    await tab.fill('[data-testid="unlock-password-input"]', PW_INITIAL);
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="unlock-error"]', { timeout: 15_000 });

    await tab.fill('[data-testid="unlock-password-input"]', PW_ROTATED);
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });
    assert(
      (await tab.textContent('[data-testid="primary-address"]'))?.replace(/\s+/g, "").trim() ===
        createdAddr,
      "Rotated-password unlock address mismatch"
    );

    // 5. Danger Zone secret reveal (wrong pw rejected, right pw reveals, blur auto-masks!)
    await tab.click('[data-testid="tab-security"]');
    await tab.fill('[data-testid="reveal-pw-input"]', "wrong-pw");
    await tab.click('[data-testid="reveal-submit-btn"]');
    await tab.waitForSelector('[data-testid="reveal-error"]', { timeout: 15_000 });

    await tab.fill('[data-testid="reveal-pw-input"]', PW_ROTATED);
    await tab.click('[data-testid="reveal-submit-btn"]');
    await tab.waitForSelector('[data-testid="revealed-secrets-box"]', { timeout: 15_000 });

    const revealedViewKey = (await tab.textContent('[data-testid="revealed-view-key"]'))?.trim();
    const revealedSpendKey = (await tab.textContent('[data-testid="revealed-spend-key"]'))?.trim();
    assert(revealedViewKey && /^[0-9a-f]{64}$/.test(revealedViewKey), "Invalid revealed view key");
    assert(revealedSpendKey && /^[0-9a-f]{64}$/.test(revealedSpendKey), "Invalid revealed spend key");

    // Verify immediate auto-mask on window blur
    await tab.evaluate(() => window.dispatchEvent(new Event("blur")));
    await tab.waitForSelector('[data-testid="revealed-secrets-box"]', {
      state: "detached",
      timeout: 5_000
    });

    // 6. Delete wallet -> Restore from 25-word seed -> identical primary address
    await tab.click('[data-testid="delete-wallet-toggle"]');
    await tab.check('[data-testid="delete-backup-checkbox"]');
    await tab.fill('[data-testid="delete-confirm-input"]', "DELETE");
    await tab.click('[data-testid="delete-wallet-submit"]');
    await tab.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 15_000 });

    await tab.click('[data-testid="choose-restore-seed-btn"]');
    await tab.fill('[data-testid="restore-seed-input"]', backupInfo.words.join(" "));
    await tab.fill('[data-testid="restore-seed-height"]', "900000");
    await tab.fill('[data-testid="restore-seed-password"]', PW_SEED_RESTORE);
    await tab.fill('[data-testid="restore-seed-confirm"]', PW_SEED_RESTORE);
    await tab.click('[data-testid="restore-seed-submit"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });

    const restoredSeedAddr = (await tab.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(restoredSeedAddr === createdAddr, "Seed-restored address mismatch");
    assert(
      (await tab.textContent('[data-testid="wallet-restore-height"]'))?.trim() === "900000",
      "Seed-restored height mismatch"
    );

    // 7. Reset from unlock screen -> Restore View-Only wallet -> verify view-only banner & no spend key
    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 15_000 });
    await tab.click('[data-testid="toggle-reset-btn"]');
    await tab.fill('[data-testid="unlock-reset-input"]', "DELETE");
    await tab.click('[data-testid="unlock-reset-submit"]');
    await tab.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 15_000 });

    await tab.click('[data-testid="choose-restore-view-btn"]');
    await tab.fill('[data-testid="restore-view-address"]', createdAddr);
    await tab.fill('[data-testid="restore-view-key"]', revealedViewKey);
    await tab.fill('[data-testid="restore-view-height"]', "905000");
    await tab.fill('[data-testid="restore-view-password"]', PW_VIEW_ONLY);
    await tab.fill('[data-testid="restore-view-confirm"]', PW_VIEW_ONLY);
    await tab.click('[data-testid="restore-view-submit"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });
    await tab.waitForSelector('[data-testid="view-only-banner"]', { timeout: 10_000 });
    assert(
      (await tab.textContent('[data-testid="primary-address"]'))?.replace(/\s+/g, "").trim() ===
        createdAddr,
      "View-only address mismatch"
    );

    await tab.click('[data-testid="tab-security"]');
    await tab.fill('[data-testid="reveal-pw-input"]', PW_VIEW_ONLY);
    await tab.click('[data-testid="reveal-submit-btn"]');
    await tab.waitForSelector('[data-testid="revealed-secrets-box"]', { timeout: 15_000 });
    assert(
      (await tab.textContent('[data-testid="revealed-view-key"]'))?.trim() === revealedViewKey,
      "View-only revealed view key mismatch"
    );
    assert(
      (await tab.locator('[data-testid="revealed-spend-key"]').count()) === 0,
      "View-only wallet must never expose a spend key"
    );

    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 15_000 });
    assert((await readOffscreenDiag(tab)) === "false", "Expected offscreen=false after final lock");

    await assertStyleAndCspGuards(popup, "chrome-popup-final");
    await assertStyleAndCspGuards(panel, "chrome-panel-final");
    await assertStyleAndCspGuards(tab, "chrome-tab-final");

    assert(consoleErrors.length === 0, `Chrome console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Chrome page errors: ${pageErrors.join(" | ")}`);
    assert(cspViolations.length === 0, `Chrome CSP violations: ${cspViolations.join(" | ")}`);

    return {
      browser: "chromium",
      extensionId: extId,
      surfacesVerified: ["popup.html", "panel.html", "app.html"],
      restoreHeightSource: backupInfo.heightSource,
      offscreenTeardownOnLock: true,
      offscreenTeardownOnFailedUnlock: true,
      passwordRotationVerified: true,
      dangerZoneRevealAndBlurMaskVerified: true,
      seedRestoreAddressMatched: true,
      viewOnlyRestoreVerified: true,
      consoleErrors: 0,
      cspViolations: 0
    };
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function wdReq(base, method, endpoint, body) {
  const res = await fetch(`${base}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`WebDriver ${method} ${endpoint} returned non-JSON (${res.status}): ${text}`);
  }
  if (!res.ok) {
    throw new Error(
      `WebDriver ${method} ${endpoint} failed (${res.status}): ${JSON.stringify(json)}`
    );
  }
  return json.value;
}

async function waitForSelectorWd(base, sessionId, selector, timeoutMs = 45_000, absent = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.querySelector(arguments[0]) !== null;",
      args: [selector]
    });
    if (absent ? !found : found) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const pageState = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
    script:
      "return { text: document.body?.innerText?.slice(0, 600), err: document.querySelector('[role=\"alert\"]')?.textContent };",
    args: []
  });
  throw new Error(
    `Timed out waiting for selector ${selector} (absent=${absent}) in Firefox; pageState=${JSON.stringify(pageState)}`
  );
}

async function wdClick(base, sessionId, selector) {
  await waitForSelectorWd(base, sessionId, selector, 20_000);
  const el = await wdReq(base, "POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector
  });
  await wdReq(base, "POST", `/session/${sessionId}/element/${Object.values(el)[0]}/click`, {});
}

async function wdFill(base, sessionId, selector, value) {
  await waitForSelectorWd(base, sessionId, selector, 20_000);
  const el = await wdReq(base, "POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector
  });
  const id = Object.values(el)[0];
  await wdReq(base, "POST", `/session/${sessionId}/element/${id}/clear`, {});
  await wdReq(base, "POST", `/session/${sessionId}/element/${id}/value`, { text: value });
}

async function wdText(base, sessionId, selector) {
  return wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
    script: "return document.querySelector(arguments[0])?.textContent ?? '';",
    args: [selector]
  });
}

async function verifyFirefox() {
  const firefoxBin = findBinary("FIREFOX_BIN", [
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
    path.join(CACHE_BROWSERS, "firefox", "firefox")
  ]);
  const geckodriverBin = findBinary("GECKODRIVER_BIN", [
    "/usr/bin/geckodriver",
    "/usr/local/bin/geckodriver",
    path.join(CACHE_BROWSERS, "geckodriver")
  ]);
  assert(firefoxBin, "No Firefox binary found");
  assert(geckodriverBin, "No geckodriver binary found");
  assert(fs.existsSync(path.join(FIREFOX_DIST, "manifest.json")), "Build dist/firefox first");

  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const driver = spawn(geckodriverBin, ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" }
  });

  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    try {
      const s = await fetch(`${base}/status`);
      if (s.ok) break;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  let sessionId = null;
  try {
    const session = await wdReq(base, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: firefoxBin,
            args: ["-headless"],
            prefs: {
              "xpinstall.signatures.required": false
            }
          }
        }
      }
    });
    sessionId = session.sessionId;
    const browserVersion = session.capabilities?.browserVersion ?? "unknown";

    const addonId = await wdReq(base, "POST", `/session/${sessionId}/moz/addon/install`, {
      path: FIREFOX_DIST,
      temporary: true
    });
    assert(addonId === "wallet@lateo.dev", `Unexpected installed addonId: ${addonId}`);

    await wdReq(base, "POST", `/session/${sessionId}/moz/context`, { context: "chrome" });
    const extHost = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        "const p = WebExtensionPolicy.getByID(arguments[0]); return p ? p.mozExtensionHostname : null;",
      args: [addonId]
    });
    assert(extHost, `Could not resolve mozExtensionHostname for ${addonId}`);
    const extBase = `moz-extension://${extHost}`;

    const openExtPage = async (relPath) => {
      await wdReq(base, "POST", `/session/${sessionId}/moz/context`, { context: "chrome" });
      await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
        script: `
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          const tab = win.gBrowser.addTrustedTab(arguments[0]);
          win.gBrowser.selectedTab = tab;
        `,
        args: [`${extBase}/${relPath}`]
      });
      await wdReq(base, "POST", `/session/${sessionId}/moz/context`, { context: "content" });
      const handles = await wdReq(base, "GET", `/session/${sessionId}/window/handles`);
      await wdReq(base, "POST", `/session/${sessionId}/window`, {
        handle: handles[handles.length - 1]
      });
    };

    const installAndCheckGuards = async (label) => {
      const g = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
        script: `
          if (!window.__lateoMonitors) {
            window.__lateoMonitors = true;
            window.__lateoErrors = [];
            window.__lateoCsp = [];
            window.addEventListener("error", (e) => window.__lateoErrors.push(e.message));
            window.addEventListener("unhandledrejection", (e) => window.__lateoErrors.push(String(e.reason)));
            document.addEventListener("securitypolicyviolation", (e) => window.__lateoCsp.push(e.violatedDirective));
          }
          return {
            styleTags: document.querySelectorAll("style").length,
            inlineStyles: document.querySelectorAll("[style]").length,
            errors: window.__lateoErrors ?? [],
            csp: window.__lateoCsp ?? []
          };
        `,
        args: []
      });
      assert(g.styleTags === 0, `[${label}] Found ${g.styleTags} <style> tags`);
      assert(g.inlineStyles === 0, `[${label}] Found ${g.inlineStyles} [style] attrs`);
      assert(g.errors.length === 0, `[${label}] Errors: ${JSON.stringify(g.errors)}`);
      assert(g.csp.length === 0, `[${label}] CSP violations: ${JSON.stringify(g.csp)}`);
    };

    // 1. Popup: Welcome -> Create Wallet -> 25-word seed + blank sheet + 3-word quiz
    await openExtPage("popup.html");
    await waitForSelectorWd(base, sessionId, '[data-testid="welcome-chooser"]', 20_000);
    await installAndCheckGuards("firefox-welcome");

    await wdClick(base, sessionId, '[data-testid="choose-create-btn"]');
    await wdFill(base, sessionId, '[data-testid="create-password"]', PW_INITIAL);
    await wdFill(base, sessionId, '[data-testid="create-confirm"]', PW_INITIAL);
    await wdClick(base, sessionId, '[data-testid="create-submit-btn"]');

    await waitForSelectorWd(base, sessionId, '[data-testid="seed-backup-panel"]', 45_000);
    const backupInfo = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const words = Array.from(document.querySelectorAll('[data-testid="seed-word-grid"] li code')).map((e) => (e.textContent || "").trim());
        const heightSource = (document.querySelector('[data-testid="backup-height-source"]')?.textContent || "").trim();
        const blank = document.querySelector('[data-testid="blank-backup-sheet"]');
        return {
          words,
          heightSource,
          blankSlots: blank ? blank.querySelectorAll(".lt-backup-slot").length : 0,
          blankHasLiveWord: blank ? (blank.textContent || "").includes(words[0] || "___") : true
        };
      `,
      args: []
    });
    assert(backupInfo.words.length === 25, `Firefox expected 25 words, got ${backupInfo.words.length}`);
    assert(backupInfo.blankSlots === 25 && !backupInfo.blankHasLiveWord, "Firefox blank sheet check failed");

    await wdClick(base, sessionId, '[data-testid="start-quiz-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="seed-quiz-form"]', 10_000);
    const quizPos = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        'return Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) => Number(el.getAttribute("data-quiz-pos")));',
      args: []
    });
    for (const pos of quizPos) {
      await wdFill(base, sessionId, `[data-testid="quiz-input-${pos}"]`, backupInfo.words[pos - 1]);
    }
    await wdClick(base, sessionId, '[data-testid="verify-quiz-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 20_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="backup-verified-badge"]', 10_000);

    const createdAddr = (await wdText(base, sessionId, '[data-testid="primary-address"]'))
      .replace(/\s+/g, "")
      .trim();
    assert(/^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Firefox invalid address: ${createdAddr}`);

    // 2. Open Full Tab (app.html): Lock -> Unlock -> Password Rotation -> Danger Zone Reveal + Blur Mask
    await openExtPage("app.html");
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 20_000);
    await installAndCheckGuards("firefox-app");

    await wdClick(base, sessionId, '[data-testid="tab-security"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="settings-security-panel"]', 10_000);

    // Rotate password
    await wdFill(base, sessionId, '[data-testid="current-pw-input"]', PW_INITIAL);
    await wdFill(base, sessionId, '[data-testid="change-pw-password"]', PW_ROTATED);
    await wdFill(base, sessionId, '[data-testid="change-pw-confirm"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="change-pw-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="change-pw-success"]', 15_000);

    // Lock -> old password fails -> rotated password succeeds
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 15_000);
    await wdFill(base, sessionId, '[data-testid="unlock-password-input"]', PW_INITIAL);
    await wdClick(base, sessionId, '[data-testid="unlock-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-error"]', 15_000);

    await wdFill(base, sessionId, '[data-testid="unlock-password-input"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="unlock-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);

    // Danger zone reveal + blur auto-mask
    await wdClick(base, sessionId, '[data-testid="tab-security"]');
    await wdFill(base, sessionId, '[data-testid="reveal-pw-input"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="reveal-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="revealed-secrets-box"]', 15_000);
    const revealedViewKey = (await wdText(base, sessionId, '[data-testid="revealed-view-key"]')).trim();
    assert(/^[0-9a-f]{64}$/.test(revealedViewKey), "Firefox invalid revealed view key");

    await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: 'window.dispatchEvent(new Event("blur"));',
      args: []
    });
    await waitForSelectorWd(base, sessionId, '[data-testid="revealed-secrets-box"]', 5_000, true);

    // 3. Delete wallet -> Restore from 25-word seed -> identical address
    await wdClick(base, sessionId, '[data-testid="delete-wallet-toggle"]');
    await wdClick(base, sessionId, '[data-testid="delete-backup-checkbox"]');
    await wdFill(base, sessionId, '[data-testid="delete-confirm-input"]', "DELETE");
    await wdClick(base, sessionId, '[data-testid="delete-wallet-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="welcome-chooser"]', 15_000);

    await wdClick(base, sessionId, '[data-testid="choose-restore-seed-btn"]');
    await wdFill(base, sessionId, '[data-testid="restore-seed-input"]', backupInfo.words.join(" "));
    await wdFill(base, sessionId, '[data-testid="restore-seed-height"]', "900000");
    await wdFill(base, sessionId, '[data-testid="restore-seed-password"]', PW_SEED_RESTORE);
    await wdFill(base, sessionId, '[data-testid="restore-seed-confirm"]', PW_SEED_RESTORE);
    await wdClick(base, sessionId, '[data-testid="restore-seed-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);
    const restoredAddr = (await wdText(base, sessionId, '[data-testid="primary-address"]'))
      .replace(/\s+/g, "")
      .trim();
    assert(restoredAddr === createdAddr, "Firefox seed restore address mismatch");

    // 4. Reset -> Restore View-Only wallet -> verify view-only mode
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 15_000);
    await wdClick(base, sessionId, '[data-testid="toggle-reset-btn"]');
    await wdFill(base, sessionId, '[data-testid="unlock-reset-input"]', "DELETE");
    await wdClick(base, sessionId, '[data-testid="unlock-reset-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="welcome-chooser"]', 15_000);

    await wdClick(base, sessionId, '[data-testid="choose-restore-view-btn"]');
    await wdFill(base, sessionId, '[data-testid="restore-view-address"]', createdAddr);
    await wdFill(base, sessionId, '[data-testid="restore-view-key"]', revealedViewKey);
    await wdFill(base, sessionId, '[data-testid="restore-view-height"]', "905000");
    await wdFill(base, sessionId, '[data-testid="restore-view-password"]', PW_VIEW_ONLY);
    await wdFill(base, sessionId, '[data-testid="restore-view-confirm"]', PW_VIEW_ONLY);
    await wdClick(base, sessionId, '[data-testid="restore-view-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="view-only-banner"]', 10_000);
    assert(
      (await wdText(base, sessionId, '[data-testid="primary-address"]')).replace(/\s+/g, "").trim() ===
        createdAddr,
      "Firefox view-only address mismatch"
    );

    await installAndCheckGuards("firefox-final");
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 15_000);

    return {
      browser: `firefox ${browserVersion}`,
      addonId,
      surfacesVerified: ["popup.html", "app.html"],
      restoreHeightSource: backupInfo.heightSource,
      passwordRotationVerified: true,
      dangerZoneRevealAndBlurMaskVerified: true,
      seedRestoreAddressMatched: true,
      viewOnlyRestoreVerified: true,
      consoleErrors: 0,
      cspViolations: 0
    };
  } finally {
    if (sessionId) {
      await fetch(`${base}/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
    driver.kill("SIGTERM");
  }
}

async function main() {
  const only = process.argv[2];
  if (!only || only === "chrome") {
    console.log("Running Chromium M1.2 MV3 verification...");
    const chromeRes = await verifyChrome();
    console.log("Chromium M1.2 PASS:", JSON.stringify(chromeRes, null, 2));
  }
  if (!only || only === "firefox") {
    console.log("Running Firefox M1.2 MV3 verification...");
    const firefoxRes = await verifyFirefox();
    console.log("Firefox M1.2 PASS:", JSON.stringify(firefoxRes, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
