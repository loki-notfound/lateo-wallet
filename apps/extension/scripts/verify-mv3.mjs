#!/usr/bin/env node
/**
 * Automated M1.1 MV3 WASM verification harness for Chromium and Firefox.
 * Uses disposable random wallets only; never touches real funds or external nodes.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME_DIST = path.join(ROOT, "dist", "chrome");
const FIREFOX_DIST = path.join(ROOT, "dist", "firefox");
const CACHE_BROWSERS = path.join(os.homedir(), ".cache", "lateo-wallet-browsers");
const TEST_PASSWORD = "m11-disposable-vault-password";

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

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-chrome-mv3-"));
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
    const swUrl = sw.url();
    const match = swUrl.match(/^chrome-extension:\/\/([a-z]{32})\//);
    assert(match, `Unexpected service worker URL: ${swUrl}`);
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

    const readPageGuards = async (page, label) => {
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

    // 1. Popup surface: cold locked check + create disposable wallet
    const popup = await context.newPage();
    attachMonitors(popup, "chrome-popup");
    await installCspTrap(popup);
    await popup.goto(`${baseUrl}/popup.html`, { waitUntil: "domcontentloaded" });
    await popup.waitForSelector('[data-testid="diag-host-kind"]', { timeout: 15_000 });
    await readPageGuards(popup, "chrome-popup-initial");

    const initDiag = {
      hostKind: (await popup.textContent('[data-testid="diag-host-kind"]'))?.trim(),
      offscreen: (await popup.textContent('[data-testid="diag-offscreen"]'))?.trim(),
      nodePerm: (await popup.textContent('[data-testid="diag-node-perm"]'))?.trim()
    };
    assert(initDiag.hostKind === "chrome-offscreen", `Expected chrome-offscreen, got ${initDiag.hostKind}`);
    assert(initDiag.offscreen === "false", `Expected offscreen=false initially, got ${initDiag.offscreen}`);
    assert(initDiag.nodePerm === "true", `Expected default node host_permission=true on Chrome`);

    await popup.fill('[data-testid="password-input"]', TEST_PASSWORD);
    await popup.click('[data-testid="create-btn"]');
    await popup.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });

    const createdAddr = (await popup.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(createdAddr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Invalid created address: ${createdAddr}`);

    const afterCreateOffscreen = (await popup.textContent('[data-testid="diag-offscreen"]'))?.trim();
    assert(afterCreateOffscreen === "true", `Expected offscreen=true after create, got ${afterCreateOffscreen}`);

    // Verify encrypted IndexedDB records exist
    const idbCheck = await popup.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("lateo-wallet-db", 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const readAll = (storeName) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const metas = await readAll("vault_meta");
      const blobs = await readAll("wallet_blobs");
      db.close();
      return {
        metaCount: metas.length,
        kdfAlg: metas[0]?.kdf?.alg,
        kdfIterations: metas[0]?.kdf?.iterations,
        blobCount: blobs.length,
        blobKinds: blobs.map((b) => b.kind).sort(),
        blobSizes: blobs.map((b) => b.ciphertext?.byteLength ?? 0)
      };
    });
    assert(idbCheck.metaCount === 1, `Expected 1 vault_meta record, got ${idbCheck.metaCount}`);
    assert(idbCheck.kdfAlg === "PBKDF2-SHA256", `Unexpected KDF alg: ${idbCheck.kdfAlg}`);
    assert(idbCheck.kdfIterations === 600000, `Unexpected KDF iterations: ${idbCheck.kdfIterations}`);
    assert(
      idbCheck.blobCount === 2 && idbCheck.blobKinds.join(",") === "cache,keys",
      `Expected keys+cache blobs in IndexedDB, got ${JSON.stringify(idbCheck)}`
    );

    // 2. Side Panel surface
    const panel = await context.newPage();
    attachMonitors(panel, "chrome-panel");
    await installCspTrap(panel);
    await panel.goto(`${baseUrl}/panel.html`, { waitUntil: "domcontentloaded" });
    await panel.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await readPageGuards(panel, "chrome-panel");
    const panelAddr = (await panel.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(panelAddr === createdAddr, "Side panel address mismatch");

    // 3. Full Tab surface + Lock -> verify Offscreen Document teardown
    const tab = await context.newPage();
    attachMonitors(tab, "chrome-tab");
    await installCspTrap(tab);
    await tab.goto(`${baseUrl}/app.html`, { waitUntil: "domcontentloaded" });
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await readPageGuards(tab, "chrome-tab");
    const tabAddr = (await tab.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(tabAddr === createdAddr, "Full tab address mismatch");

    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-btn"]', { timeout: 15_000 });
    const afterLockOffscreen = (await tab.textContent('[data-testid="diag-offscreen"]'))?.trim();
    assert(
      afterLockOffscreen === "false",
      `Expected offscreen=false after Lock teardown, got ${afterLockOffscreen}`
    );

    // 4. Reload Full Tab & unlock completely offline from IndexedDB
    await tab.reload({ waitUntil: "domcontentloaded" });
    await tab.waitForSelector('[data-testid="unlock-btn"]', { timeout: 15_000 });
    await tab.fill('[data-testid="password-input"]', TEST_PASSWORD);
    await tab.click('[data-testid="unlock-btn"]');
    await tab.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 45_000 });

    const reopenedAddr = (await tab.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(
      reopenedAddr === createdAddr,
      `Reopened address mismatch: ${reopenedAddr} !== ${createdAddr}`
    );
    const afterUnlockOffscreen = (await tab.textContent('[data-testid="diag-offscreen"]'))?.trim();
    assert(afterUnlockOffscreen === "true", `Expected offscreen=true after unlock`);

    await tab.click('[data-testid="lock-btn"]');
    await tab.waitForSelector('[data-testid="unlock-btn"]', { timeout: 15_000 });
    const finalOffscreen = (await tab.textContent('[data-testid="diag-offscreen"]'))?.trim();
    assert(finalOffscreen === "false", `Expected offscreen=false after final lock`);

    await readPageGuards(popup, "chrome-popup-final");
    await readPageGuards(panel, "chrome-panel-final");
    await readPageGuards(tab, "chrome-tab-final");

    assert(consoleErrors.length === 0, `Chrome console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Chrome page errors: ${pageErrors.join(" | ")}`);
    assert(cspViolations.length === 0, `Chrome CSP violations: ${cspViolations.join(" | ")}`);

    return {
      browser: "chromium",
      extensionId: extId,
      surfacesVerified: ["popup.html", "panel.html", "app.html"],
      offscreenLifecycle: {
        initial: initDiag.offscreen,
        afterCreate: afterCreateOffscreen,
        afterLock: afterLockOffscreen,
        afterUnlock: afterUnlockOffscreen,
        afterFinalLock: finalOffscreen
      },
      defaultNodeHostPermissionGranted: initDiag.nodePerm === "true",
      indexedDb: idbCheck,
      addressPrefix: createdAddr.slice(0, 10),
      addressMatchedAfterOfflineReopen: reopenedAddr === createdAddr,
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

async function waitForSelectorWd(base, sessionId, selector, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.querySelector(arguments[0]) !== null;",
      args: [selector]
    });
    if (found) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const pageState = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
    script:
      "return { text: document.body?.innerText?.slice(0, 500), err: document.querySelector('[data-testid=\"error-banner\"]')?.textContent };",
    args: []
  });
  throw new Error(
    `Timed out waiting for selector ${selector} in Firefox; pageState=${JSON.stringify(pageState)}`
  );
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
  const geckoLog = [];

  const driver = spawn(geckodriverBin, ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" }
  });
  driver.stdout.on("data", (d) => geckoLog.push(d.toString()));
  driver.stderr.on("data", (d) => geckoLog.push(d.toString()));

  // Wait for geckodriver /status
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

    // Install unpacked MV3 extension via official Mozilla WebDriver endpoint
    const addonId = await wdReq(base, "POST", `/session/${sessionId}/moz/addon/install`, {
      path: FIREFOX_DIST,
      temporary: true
    });
    assert(addonId === "wallet@lateo.dev", `Unexpected installed addonId: ${addonId}`);

    // Resolve the real runtime moz-extension:// UUID via privileged chrome context
    await wdReq(base, "POST", `/session/${sessionId}/moz/context`, { context: "chrome" });
    const extHost = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const policy = WebExtensionPolicy.getByID(arguments[0]);
        return policy ? policy.mozExtensionHostname : null;
      `,
      args: [addonId]
    });
    assert(extHost, `Could not resolve mozExtensionHostname for ${addonId}`);
    const extBase = `moz-extension://${extHost}`;

    // Open extension popup.html in a new foreground tab from chrome context, then switch to content
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

    // 1. Open popup.html
    await openExtPage("popup.html");
    await waitForSelectorWd(base, sessionId, '[data-testid="diag-host-kind"]', 20_000);

    // Attach CSP + error listener on page
    const setupMonitors = async () =>
      wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
        script: `
          window.__lateoErrors = [];
          window.__lateoCsp = [];
          window.addEventListener("error", (e) => window.__lateoErrors.push(e.message));
          window.addEventListener("unhandledrejection", (e) => window.__lateoErrors.push(String(e.reason)));
          document.addEventListener("securitypolicyviolation", (e) => window.__lateoCsp.push(e.violatedDirective));
          return {
            styleTags: document.querySelectorAll("style").length,
            inlineStyles: document.querySelectorAll("[style]").length
          };
        `,
        args: []
      });

    const popupGuards = await setupMonitors();
    assert(popupGuards.styleTags === 0, `Firefox popup had ${popupGuards.styleTags} <style> tags`);
    assert(
      popupGuards.inlineStyles === 0,
      `Firefox popup had ${popupGuards.inlineStyles} inline [style] attrs`
    );

    // Inspect initial diagnostics & exact Firefox host_permissions behavior
    const initDiag = await wdReq(base, "POST", `/session/${sessionId}/execute/async`, {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const allPerms = await browser.permissions.getAll();
          const hasNode = await browser.permissions.contains({ origins: ["https://node.lateo.dev/*"] });
          done({
            hostKind: document.querySelector('[data-testid="diag-host-kind"]')?.textContent?.trim(),
            keepAlive: document.querySelector('[data-testid="diag-keepalive"]')?.textContent?.trim(),
            nodePermUi: document.querySelector('[data-testid="diag-node-perm"]')?.textContent?.trim(),
            apiHasNode: hasNode,
            grantedOrigins: allPerms.origins ?? [],
            grantedPermissions: allPerms.permissions ?? []
          });
        })().catch((e) => done({ error: String(e) }));
      `,
      args: []
    });
    assert(!initDiag.error, `Firefox diagnostics error: ${initDiag.error}`);
    assert(
      initDiag.hostKind === "firefox-event-page",
      `Expected firefox-event-page, got ${initDiag.hostKind}`
    );
    assert(initDiag.keepAlive === "true", `Expected keepAlive=true in Firefox, got ${initDiag.keepAlive}`);

    // 2. Create disposable random wallet (compiles zephyr.wasm + posts to zephyr.worker.js under strict CSP!)
    const pwEl = await wdReq(base, "POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: '[data-testid="password-input"]'
    });
    const pwId = Object.values(pwEl)[0];
    await wdReq(base, "POST", `/session/${sessionId}/element/${pwId}/value`, {
      text: TEST_PASSWORD
    });
    const createBtn = await wdReq(base, "POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: '[data-testid="create-btn"]'
    });
    const createBtnId = Object.values(createBtn)[0];
    await wdReq(base, "POST", `/session/${sessionId}/element/${createBtnId}/click`, {});

    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);

    const createdInfo = await wdReq(base, "POST", `/session/${sessionId}/execute/async`, {
      script: `
        const done = arguments[arguments.length - 1];
        (async () => {
          const addr = document.querySelector('[data-testid="primary-address"]')?.textContent?.replace(/\\s+/g, "").trim();
          const keepAlive = document.querySelector('[data-testid="diag-keepalive"]')?.textContent?.trim();
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("lateo-wallet-db", 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const readAll = (name) => new Promise((resolve, reject) => {
            const tx = db.transaction(name, "readonly");
            const r = tx.objectStore(name).getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          const metas = await readAll("vault_meta");
          const blobs = await readAll("wallet_blobs");
          db.close();
          done({
            addr,
            keepAlive,
            errors: window.__lateoErrors ?? [],
            csp: window.__lateoCsp ?? [],
            metaCount: metas.length,
            kdfAlg: metas[0]?.kdf?.alg,
            kdfIterations: metas[0]?.kdf?.iterations,
            blobCount: blobs.length,
            blobKinds: blobs.map((b) => b.kind).sort(),
            blobSizes: blobs.map((b) => b.ciphertext?.byteLength ?? 0)
          });
        })().catch((e) => done({ error: String(e) }));
      `,
      args: []
    });
    assert(!createdInfo.error, `Firefox create inspect error: ${createdInfo.error}`);
    assert(
      createdInfo.addr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdInfo.addr),
      `Invalid Firefox created address: ${createdInfo.addr}`
    );
    assert(createdInfo.metaCount === 1 && createdInfo.blobCount === 2, `Firefox IDB check failed`);
    assert(createdInfo.errors.length === 0, `Firefox errors: ${JSON.stringify(createdInfo.errors)}`);
    assert(createdInfo.csp.length === 0, `Firefox CSP violations: ${JSON.stringify(createdInfo.csp)}`);

    // 3. Open Full Tab (app.html), lock, reload, unlock offline
    await openExtPage("app.html");
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 20_000);
    const tabGuards = await setupMonitors();
    assert(tabGuards.styleTags === 0 && tabGuards.inlineStyles === 0, "Firefox app.html style guard failed");

    const lockBtn = await wdReq(base, "POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: '[data-testid="lock-btn"]'
    });
    await wdReq(base, "POST", `/session/${sessionId}/element/${Object.values(lockBtn)[0]}/click`, {});
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-btn"]', 15_000);

    // Reload app.html and unlock offline
    await wdReq(base, "POST", `/session/${sessionId}/refresh`, {});
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-btn"]', 15_000);

    const unlockPw = await wdReq(base, "POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: '[data-testid="password-input"]'
    });
    await wdReq(base, "POST", `/session/${sessionId}/element/${Object.values(unlockPw)[0]}/value`, {
      text: TEST_PASSWORD
    });
    const unlockBtn = await wdReq(base, "POST", `/session/${sessionId}/element`, {
      using: "css selector",
      value: '[data-testid="unlock-btn"]'
    });
    await wdReq(base, "POST", `/session/${sessionId}/element/${Object.values(unlockBtn)[0]}/click`, {});
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 45_000);

    const reopenedAddr = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        'return document.querySelector(\'[data-testid="primary-address"]\')?.textContent?.replace(/\\s+/g, "").trim();',
      args: []
    });
    assert(
      reopenedAddr === createdInfo.addr,
      `Firefox reopened address mismatch: ${reopenedAddr} !== ${createdInfo.addr}`
    );

    const finalErrors = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: "return { errors: window.__lateoErrors ?? [], csp: window.__lateoCsp ?? [] };",
      args: []
    });
    assert(finalErrors.errors.length === 0, `Firefox final errors: ${JSON.stringify(finalErrors.errors)}`);
    assert(finalErrors.csp.length === 0, `Firefox final CSP violations: ${JSON.stringify(finalErrors.csp)}`);

    return {
      browser: `firefox ${browserVersion}`,
      addonId,
      surfacesVerified: ["popup.html", "app.html"],
      hostKind: initDiag.hostKind,
      keepAliveActiveWhileUnlocked: createdInfo.keepAlive === "true",
      firefoxHostPermissionsObserved: {
        defaultNodeHostPermissionGrantedAtInstall: initDiag.apiHasNode,
        grantedOriginsAtInstall: initDiag.grantedOrigins,
        grantedPermissionsAtInstall: initDiag.grantedPermissions
      },
      indexedDb: {
        metaCount: createdInfo.metaCount,
        kdfAlg: createdInfo.kdfAlg,
        kdfIterations: createdInfo.kdfIterations,
        blobCount: createdInfo.blobCount,
        blobKinds: createdInfo.blobKinds,
        blobSizes: createdInfo.blobSizes
      },
      addressPrefix: createdInfo.addr.slice(0, 10),
      addressMatchedAfterOfflineReopen: reopenedAddr === createdInfo.addr,
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
  const results = {};
  if (!only || only === "chrome") {
    console.log("Running Chromium MV3 verification...");
    results.chrome = await verifyChrome();
    console.log("Chromium MV3 PASS:", JSON.stringify(results.chrome, null, 2));
  }
  if (!only || only === "firefox") {
    console.log("Running Firefox MV3 verification...");
    results.firefox = await verifyFirefox();
    console.log("Firefox MV3 PASS:", JSON.stringify(results.firefox, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
