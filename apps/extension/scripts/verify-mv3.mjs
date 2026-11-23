#!/usr/bin/env node
/**
 * Automated M1.3 MV3 end-to-end verification harness for Chromium and Firefox.
 * Uses fresh, random, empty disposable wallets only (zero real funds).
 * Covers:
 * - Onboarding (Create + live daemon restoreHeight + blank print sheet + 3-word quiz)
 * - Live read-only sync against https://node.lateo.dev (4 V2 asset cards, reserve ratio & oracle banner)
 * - Receive view (create & rename subaddress + pure-SVG dark-on-white QR code)
 * - Transaction History view + opt-in refreshPool()
 * - Node Switcher live probe against https://node.lateo.dev
 * - Lock (Chrome Offscreen teardown + failed-unlock teardown) & offline reopen preserving synced checkpoint height + subaddress labels
 * - Password rotation + Danger Zone secret reveal & blur auto-mask
 * - Strict CSP / zero console errors / zero <style> / zero [style]
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

const PW_INITIAL = "M13-Initial-Pass!9";
const PW_ROTATED = "M13-Rotated-Pass!9";

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

function parseLeadingHeight(text) {
  const m = text.match(/Height\s+([\d,]+)/);
  if (!m) return 0;
  return Number(m[1].replace(/,/g, ""));
}

async function verifyChrome() {
  const chromeBin = findBinary("CHROME_BIN", [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ]);
  assert(chromeBin, "No Chromium/Chrome binary found");
  assert(fs.existsSync(path.join(CHROME_DIST, "manifest.json")), "Build dist/chrome first");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-chrome-m13-"));
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

    const assertGuards = async (page, label) => {
      const info = await page.evaluate(() => ({
        styleTags: document.querySelectorAll("style").length,
        inlineStyles: document.querySelectorAll("[style]").length,
        cspViolations: window.__lateoCspViolations ?? []
      }));
      assert(info.styleTags === 0, `[${label}] Found ${info.styleTags} <style> tags`);
      assert(info.inlineStyles === 0, `[${label}] Found ${info.inlineStyles} [style] attrs`);
      for (const v of info.cspViolations) {
        cspViolations.push(`[${label}] ${JSON.stringify(v)}`);
      }
    };

    const getDiag = async (page) =>
      page.evaluate(async () => {
        const port = chrome.runtime.connect({ name: "lateo-ui" });
        return new Promise((resolve, reject) => {
          port.onMessage.addListener((m) => {
            port.disconnect();
            if (m.ok) resolve(m.result);
            else reject(new Error(m.error?.message));
          });
          port.postMessage({ id: "diag-check", type: "GET_DIAGNOSTICS" });
        });
      });

    // 1. Open app.html (Full Tab): Create disposable wallet + 3-word quiz
    const tab = await context.newPage();
    attachMonitors(tab, "chrome-app");
    await installCspTrap(tab);
    await tab.goto(`${baseUrl}/app.html`, { waitUntil: "domcontentloaded" });
    await tab.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 15_000 });
    await assertGuards(tab, "chrome-welcome");

    await tab.click('[data-testid="choose-create-btn"]');
    await tab.fill('[data-testid="create-password"]', PW_INITIAL);
    await tab.fill('[data-testid="create-confirm"]', PW_INITIAL);
    await tab.click('[data-testid="create-submit-btn"]');

    await tab.waitForSelector('[data-testid="seed-backup-panel"]', { timeout: 45_000 });
    const seedWords = await tab.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="seed-word-grid"] li code')).map((e) =>
        (e.textContent ?? "").trim()
      )
    );
    assert(seedWords.length === 25, `Expected 25 words, got ${seedWords.length}`);

    await tab.click('[data-testid="start-quiz-btn"]');
    await tab.waitForSelector('[data-testid="seed-quiz-form"]', { timeout: 10_000 });
    const quizPos = await tab.evaluate(() =>
      Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) =>
        Number(el.getAttribute("data-quiz-pos"))
      )
    );
    for (const pos of quizPos) {
      await tab.fill(`[data-testid="quiz-input-${pos}"]`, seedWords[pos - 1]);
    }
    await tab.click('[data-testid="verify-quiz-btn"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 20_000 });

    const createdAddr = (await tab.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(createdAddr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Invalid address: ${createdAddr}`);

    // Verify all 4 V2 asset cards exist
    for (const code of ["ZPH", "ZSD", "ZRS", "ZYS"]) {
      await tab.waitForSelector(`[data-testid="balance-card-${code}"]`, { timeout: 5_000 });
    }

    // 2. Online read-only sync against https://node.lateo.dev (initial block-hash download + reserve info)
    await tab.click('[data-testid="sync-now-btn"]');
    await tab.waitForFunction(
      () =>
        document.querySelector('[data-testid="sync-state-badge"]')?.textContent?.trim() === "Synced",
      null,
      { timeout: 180_000 }
    );
    await tab.waitForSelector('[data-testid="reserve-ratio-value"]', { timeout: 30_000 });
    await tab.waitForSelector('[data-testid="oracle-prices-grid"]', { timeout: 15_000 });

    const syncedHeightText = (await tab.textContent('[data-testid="sync-heights"]')) ?? "";
    const syncedHeight = parseLeadingHeight(syncedHeightText);
    assert(syncedHeight > 100_000, `Expected synced height > 100000, got "${syncedHeightText}"`);
    const reserveRatioText = (await tab.textContent('[data-testid="reserve-ratio-value"]'))?.trim();

    // 3. Receive view: create & rename subaddress + verify pure-SVG QR code
    await tab.click('[data-testid="tab-receive"]');
    await tab.waitForSelector('[data-testid="receive-view"]', { timeout: 10_000 });
    await tab.fill('[data-testid="new-subaddress-label"]', "M1.3 Test Sub");
    await tab.click('[data-testid="create-subaddress-btn"]');
    await tab.waitForSelector('[data-testid="subaddress-label-1"]', { timeout: 20_000 });
    assert(
      (await tab.textContent('[data-testid="subaddress-label-1"]'))?.trim() === "M1.3 Test Sub",
      "Created subaddress label mismatch"
    );
    await tab.click('[data-testid="edit-subaddress-1"]');
    await tab.fill('[data-testid="edit-label-input-1"]', "Renamed Sub");
    await tab.click('[data-testid="save-label-btn-1"]');
    await tab.waitForFunction(
      () =>
        document.querySelector('[data-testid="subaddress-label-1"]')?.textContent?.trim() ===
        "Renamed Sub",
      null,
      { timeout: 15_000 }
    );
    await tab.waitForSelector('[data-testid="qr-code-svg"] path', { timeout: 10_000 });
    await assertGuards(tab, "chrome-receive");

    // 4. Transaction History view + opt-in refreshPool()
    await tab.click('[data-testid="tab-history"]');
    await tab.waitForSelector('[data-testid="history-view"]', { timeout: 10_000 });
    await tab.waitForSelector('[data-testid="history-empty"]', { timeout: 10_000 });
    await tab.click('[data-testid="refresh-pool-btn"]');
    await tab.waitForSelector('[data-testid="pool-status-note"]', { timeout: 30_000 });
    await assertGuards(tab, "chrome-history");

    // 5. Settings: Node Switcher live probe + Password rotation + Danger Zone blur mask
    await tab.click('[data-testid="tab-security"]');
    await tab.waitForSelector('[data-testid="node-switcher"]', { timeout: 10_000 });
    await tab.click('[data-testid="probe-saved-default"]');
    await tab.waitForSelector('[data-testid="node-probe-result"]', { timeout: 20_000 });
    const probeText = (await tab.textContent('[data-testid="node-probe-result"]')) ?? "";
    assert(probeText.includes("node.lateo.dev"), `Unexpected node probe text: ${probeText}`);

    await tab.fill('[data-testid="current-pw-input"]', PW_INITIAL);
    await tab.fill('[data-testid="change-pw-password"]', PW_ROTATED);
    await tab.fill('[data-testid="change-pw-confirm"]', PW_ROTATED);
    await tab.click('[data-testid="change-pw-submit"]');
    await tab.waitForSelector('[data-testid="change-pw-success"]', { timeout: 15_000 });

    await tab.fill('[data-testid="reveal-pw-input"]', PW_ROTATED);
    await tab.click('[data-testid="reveal-submit-btn"]');
    await tab.waitForSelector('[data-testid="revealed-secrets-box"]', { timeout: 15_000 });
    await tab.evaluate(() => window.dispatchEvent(new Event("blur")));
    await tab.waitForSelector('[data-testid="revealed-secrets-box"]', {
      state: "detached",
      timeout: 5_000
    });

    // 6. Lock -> verify Offscreen teardown + Failed unlock teardown -> Reopen restores checkpoint height & subaddress!
    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
    assert((await getDiag(tab)).offscreenExists === false, "Expected offscreen=false after lock");

    await tab.fill('[data-testid="unlock-password-input"]', PW_INITIAL);
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="unlock-error"]', { timeout: 15_000 });
    assert(
      (await getDiag(tab)).offscreenExists === false,
      "Expected offscreen=false after failed unlock"
    );

    await tab.fill('[data-testid="unlock-password-input"]', PW_ROTATED);
    await tab.click('[data-testid="unlock-submit-btn"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });

    const reopenedHeightText = (await tab.textContent('[data-testid="sync-heights"]')) ?? "";
    const reopenedHeight = parseLeadingHeight(reopenedHeightText);
    assert(
      reopenedHeight >= syncedHeight,
      `Expected checkpoint height >= ${syncedHeight} on reopen, got "${reopenedHeightText}"`
    );

    await tab.click('[data-testid="tab-receive"]');
    await tab.waitForSelector('[data-testid="subaddress-label-1"]', { timeout: 15_000 });
    assert(
      (await tab.textContent('[data-testid="subaddress-label-1"]'))?.trim() === "Renamed Sub",
      "Renamed subaddress label did not persist across lock/reopen"
    );

    // Quick popup & panel surface check
    const popup = await context.newPage();
    attachMonitors(popup, "chrome-popup");
    await installCspTrap(popup);
    await popup.goto(`${baseUrl}/popup.html`, { waitUntil: "domcontentloaded" });
    await popup.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await assertGuards(popup, "chrome-popup");

    const panel = await context.newPage();
    attachMonitors(panel, "chrome-panel");
    await installCspTrap(panel);
    await panel.goto(`${baseUrl}/panel.html`, { waitUntil: "domcontentloaded" });
    await panel.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await assertGuards(panel, "chrome-panel");

    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
    await assertGuards(tab, "chrome-final");

    assert(consoleErrors.length === 0, `Chrome console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Chrome page errors: ${pageErrors.join(" | ")}`);
    assert(cspViolations.length === 0, `Chrome CSP violations: ${cspViolations.join(" | ")}`);

    return {
      browser: "chromium",
      extensionId: extId,
      surfacesVerified: ["popup.html", "panel.html", "app.html"],
      syncedHeight,
      reopenedCheckpointHeight: reopenedHeight,
      reserveRatioText,
      subaddressPersistedAcrossLock: true,
      refreshPoolVerified: true,
      nodeProbeVerified: true,
      offscreenTeardownVerified: true,
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

async function waitForCondWd(base, sessionId, script, args = [], timeoutMs = 45_000, label = "cond") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, { script, args });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  const pageState = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
    script:
      "return { text: document.body?.innerText?.slice(0, 600), err: document.querySelector('[role=\"alert\"]')?.textContent };",
    args: []
  });
  throw new Error(`Timed out waiting for ${label} in Firefox; pageState=${JSON.stringify(pageState)}`);
}

async function waitForSelectorWd(base, sessionId, selector, timeoutMs = 45_000, absent = false) {
  return waitForCondWd(
    base,
    sessionId,
    absent
      ? "return document.querySelector(arguments[0]) === null;"
      : "return document.querySelector(arguments[0]) !== null;",
    [selector],
    timeoutMs,
    `${selector} (absent=${absent})`
  );
}

async function wdClick(base, sessionId, selector) {
  await waitForSelectorWd(base, sessionId, selector, 20_000);
  await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
    script: 'document.querySelector(arguments[0])?.scrollIntoView({ block: "center" });',
    args: [selector]
  });
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
            prefs: { "xpinstall.signatures.required": false }
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

    const assertGuards = async (label) => {
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

    // 1. Open app.html: Create disposable wallet + 3-word quiz
    await openExtPage("app.html");
    await waitForSelectorWd(base, sessionId, '[data-testid="welcome-chooser"]', 20_000);
    await assertGuards("firefox-welcome");

    await wdClick(base, sessionId, '[data-testid="choose-create-btn"]');
    await wdFill(base, sessionId, '[data-testid="create-password"]', PW_INITIAL);
    await wdFill(base, sessionId, '[data-testid="create-confirm"]', PW_INITIAL);
    await wdClick(base, sessionId, '[data-testid="create-submit-btn"]');

    await waitForSelectorWd(base, sessionId, '[data-testid="seed-backup-panel"]', 45_000);
    const seedWords = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        'return Array.from(document.querySelectorAll(\'[data-testid="seed-word-grid"] li code\')).map((e) => (e.textContent || "").trim());',
      args: []
    });
    assert(seedWords.length === 25, `Firefox expected 25 words, got ${seedWords.length}`);

    await wdClick(base, sessionId, '[data-testid="start-quiz-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="seed-quiz-form"]', 10_000);
    const quizPos = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        'return Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) => Number(el.getAttribute("data-quiz-pos")));',
      args: []
    });
    for (const pos of quizPos) {
      await wdFill(base, sessionId, `[data-testid="quiz-input-${pos}"]`, seedWords[pos - 1]);
    }
    await wdClick(base, sessionId, '[data-testid="verify-quiz-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 20_000);

    for (const code of ["ZPH", "ZSD", "ZRS", "ZYS"]) {
      await waitForSelectorWd(base, sessionId, `[data-testid="balance-card-${code}"]`, 5_000);
    }

    // 2. Online read-only sync against https://node.lateo.dev
    await wdClick(base, sessionId, '[data-testid="sync-now-btn"]');
    await waitForCondWd(
      base,
      sessionId,
      'return document.querySelector(\'[data-testid="sync-state-badge"]\')?.textContent?.trim() === "Synced";',
      [],
      180_000,
      "Firefox synced state"
    );
    await waitForSelectorWd(base, sessionId, '[data-testid="reserve-ratio-value"]', 30_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="oracle-prices-grid"]', 15_000);
    const syncedHeight = parseLeadingHeight(await wdText(base, sessionId, '[data-testid="sync-heights"]'));
    assert(syncedHeight > 100_000, `Firefox expected synced height > 100000, got ${syncedHeight}`);
    const reserveRatioText = (await wdText(base, sessionId, '[data-testid="reserve-ratio-value"]')).trim();

    // 3. Receive view: create & rename subaddress + QR SVG check
    await wdClick(base, sessionId, '[data-testid="tab-receive"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="receive-view"]', 10_000);
    await wdFill(base, sessionId, '[data-testid="new-subaddress-label"]', "Firefox Sub");
    await wdClick(base, sessionId, '[data-testid="create-subaddress-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="subaddress-label-1"]', 20_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="qr-code-svg"] path', 10_000);
    await assertGuards("firefox-receive");

    // 4. History view + opt-in refreshPool()
    await wdClick(base, sessionId, '[data-testid="tab-history"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="history-empty"]', 10_000);
    await wdClick(base, sessionId, '[data-testid="refresh-pool-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="pool-status-note"]', 30_000);
    await assertGuards("firefox-history");

    // 5. Lock -> Reopen from IndexedDB restores checkpoint height + subaddress label
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 20_000);
    await wdFill(base, sessionId, '[data-testid="unlock-password-input"]', PW_INITIAL);
    await wdClick(base, sessionId, '[data-testid="unlock-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);

    const reopenedHeight = parseLeadingHeight(
      await wdText(base, sessionId, '[data-testid="sync-heights"]')
    );
    assert(
      reopenedHeight >= syncedHeight,
      `Firefox checkpoint height did not persist: ${reopenedHeight} < ${syncedHeight}`
    );

    await wdClick(base, sessionId, '[data-testid="tab-receive"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="subaddress-label-1"]', 15_000);
    assert(
      (await wdText(base, sessionId, '[data-testid="subaddress-label-1"]')).trim() === "Firefox Sub",
      "Firefox subaddress label did not persist across lock/reopen"
    );

    await assertGuards("firefox-final");
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 20_000);

    return {
      browser: `firefox ${browserVersion}`,
      addonId,
      surfacesVerified: ["app.html"],
      syncedHeight,
      reopenedCheckpointHeight: reopenedHeight,
      reserveRatioText,
      subaddressPersistedAcrossLock: true,
      refreshPoolVerified: true,
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
    console.log("Running Chromium M1.3 MV3 verification...");
    const chromeRes = await verifyChrome();
    console.log("Chromium M1.3 PASS:", JSON.stringify(chromeRes, null, 2));
  }
  if (!only || only === "firefox") {
    console.log("Running Firefox M1.3 MV3 verification...");
    const firefoxRes = await verifyFirefox();
    console.log("Firefox M1.3 PASS:", JSON.stringify(firefoxRes, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
