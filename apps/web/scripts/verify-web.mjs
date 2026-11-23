#!/usr/bin/env node
/**
 * Automated Phase 2 Web PWA end-to-end verification harness for Chromium and Firefox.
 * Uses fresh, random, empty disposable wallets only (zero real funds, zero live broadcasts).
 *
 * Serves `apps/web/dist` over local HTTP with:
 * - Exact production Document CSP header (including frame-ancestors 'none', style-src 'self', etc.)
 * - Exact production Worker CSP header on `assets/zephyr.worker-*.js` (required by Firefox for WASM in workers)
 * - Same-origin `/rpc` read-only reverse proxy to `https://node.lateo.dev` that strictly blocks
 *   `/sendrawtransaction`, `/send_raw_transaction`, and any relay RPC method (HTTP 403).
 *
 * Also builds an isolated temporary mocked-relay fixture (in os.tmpdir(), never in apps/web/dist)
 * served under the exact same strict Document CSP to verify the M1.4 Review panel, non-dismissible
 * "Saving wallet state..." post-relay barrier, and beforeunload guard in both browsers.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
const WEB_DIST = path.join(WEB_ROOT, "dist");
const CACHE_BROWSERS = path.join(os.homedir(), ".cache", "lateo-wallet-browsers");
const UPSTREAM_NODE = "https://node.lateo.dev";

const PW_INITIAL = "WebPwa-Init-Pass!9";
const PW_ROTATED = "WebPwa-Rot-Pass!9";

const DOCUMENT_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://node.lateo.dev https: http://127.0.0.1:* http://localhost:*";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const BLOCKED_RELAY_PATH_RE = /\/(?:send_?raw_?transaction|relay_?tx|relay)(?:\/|$)/i;
const BLOCKED_RELAY_METHOD_RE = /^(?:send_?raw_?transaction|relay_?tx)$/i;

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

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Build an isolated temporary mock-barrier fixture (outside apps/web/dist) so
 * both Chromium and Firefox can verify the real Svelte 5 TxReviewPanel and
 * post-relay "Saving wallet state..." barrier under the exact production CSP.
 */
async function buildMockBarrierFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-web-mock-barrier-"));
  const srcDir = path.join(tmpDir, "src");
  const outDir = path.join(tmpDir, "dist");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.symlinkSync(path.join(WEB_ROOT, "node_modules"), path.join(tmpDir, "node_modules"), "dir");

  fs.writeFileSync(
    path.join(tmpDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Lateo Wallet Mock Barrier Fixture</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`
  );

  const mockMainTs = `import "@lateo-wallet/ui/styles";
import { mount } from "svelte";
import { WalletApp } from "@lateo-wallet/ui";
import type {
  PreparedTxDto,
  RelayOutcomeDto,
  WalletClient,
  WalletSnapshot
} from "@lateo-wallet/core/rpc";
import { DEFAULT_WALLET_PREFS } from "@lateo-wallet/core/storage";

const MOCK_ADDR =
  "ZEPHYR3dc1432222222222222222222222222222222222222222222222222222222222222222222222222222222222222222";
const MOCK_TXID = "b".repeat(64);

let snapshot: WalletSnapshot = {
  hasVault: true,
  locked: false,
  savingState: false,
  savingKind: null,
  pendingTx: null,
  persistFailure: null,
  unresolvedRelay: null,
  activeWallet: {
    id: "mock-1",
    name: "Mocked Offline Wallet",
    network: "mainnet",
    primaryAddress: MOCK_ADDR,
    restoreHeight: 913600,
    restoreHeightSource: "daemon",
    createdAt: "2026-11-23T00:00:00.000Z",
    viewOnly: false,
    seedBackupVerified: true
  },
  balances: [
    { asset: "ZPH", total: "100000000000000", unlocked: "100000000000000", locked: "0" },
    { asset: "ZSD", total: "0", unlocked: "0", locked: "0" },
    { asset: "ZRS", total: "0", unlocked: "0", locked: "0" },
    { asset: "ZYS", total: "0", unlocked: "0", locked: "0" }
  ],
  sync: {
    state: "synced",
    nodeUrl: window.location.origin + "/rpc",
    nodeHost: window.location.host,
    walletHeight: 913600,
    daemonHeight: 913600,
    percentDone: 100,
    lastSyncedAt: Date.now(),
    lastCheckpointAt: Date.now(),
    errorMessage: null,
    permissionOriginRequired: null
  },
  reserve: {
    height: 913600,
    hfVersion: 11,
    reserveRatio: "5.10",
    reserveRatioMa: "5.05",
    health: "healthy",
    conversions: {
      mintZsd: true,
      redeemZsd: true,
      mintZrs: true,
      redeemZrs: true,
      mintZys: true,
      redeemZys: true
    },
    statusSummary: "Healthy mock reserve",
    prices: null,
    updatedAt: Date.now()
  },
  lastPersistedAt: Date.now(),
  hostKind: "web-worker"
};

const listeners = new Set<(s: WalletSnapshot) => void>();
function emit(next: WalletSnapshot): WalletSnapshot {
  snapshot = next;
  for (const fn of listeners) fn(snapshot);
  return snapshot;
}

window.addEventListener("beforeunload", (ev) => {
  if (snapshot.savingState || snapshot.persistFailure) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

let releaseSaveBarrier: (() => void) | null = null;
(window as unknown as { __releaseMockSaveBarrier?: () => void }).__releaseMockSaveBarrier = () => {
  if (releaseSaveBarrier) {
    const fn = releaseSaveBarrier;
    releaseSaveBarrier = null;
    fn();
  }
};

const mockClient: WalletClient = {
  getSnapshot: async () => snapshot,
  getDiagnostics: async () => ({
    hostKind: "web-worker",
    offscreenExists: false,
    keepAliveActive: false,
    defaultNodeHostPermissionGranted: true,
    grantedOrigins: [window.location.origin + "/rpc"]
  }),
  getPrefs: async () => ({
    ...DEFAULT_WALLET_PREFS,
    activePublicNode: window.location.origin + "/rpc"
  }),
  updatePrefs: async (patch) => ({ ...DEFAULT_WALLET_PREFS, ...patch }),
  createWallet: async () => { throw new Error("not used"); },
  restoreFromSeed: async () => snapshot,
  restoreViewOnly: async () => snapshot,
  markSeedBackupVerified: async () => snapshot,
  unlockWallet: async () => snapshot,
  lockWallet: async () => emit({ ...snapshot, locked: true }),
  changeVaultPassword: async () => {},
  revealSecrets: async () => { throw new Error("not used"); },
  resetVault: async () => snapshot,
  syncNow: async () => snapshot,
  refreshReserve: async () => snapshot.reserve,
  probeNode: async () => { throw new Error("not used"); },
  switchNode: async () => snapshot,
  listSubaddresses: async () => [],
  createSubaddress: async () => { throw new Error("not used"); },
  setSubaddressLabel: async () => [],
  getHistory: async () => [],
  refreshPool: async () => ({ poolCount: 0, txs: [] }),
  exportTxProof: async () => "",
  prepareTransfer: async (params): Promise<PreparedTxDto> => {
    const dest = params.destinations[0]!;
    const prepared: PreparedTxDto = {
      token: "mock-token-1",
      kind: "transfer",
      status: "ready",
      sourceAsset: params.asset,
      destinationAsset: params.asset,
      destinations: [{ address: dest.address, amount: "1250000000000" }],
      txs: [
        {
          hash: MOCK_TXID,
          amount: "1250000000000",
          fee: "10000000000",
          feeAsset: "ZPH",
          totalDebited: "1260000000000",
          outcome: null
        }
      ],
      totalAmount: "1250000000000",
      totalFee: "10000000000",
      feeAsset: "ZPH",
      totalDebited: "1260000000000",
      amountMinted: null,
      pricingRecordHeight: null,
      pricingRecordExpiresAtHeight: null,
      daemonHeightAtPrepare: 913600,
      priority: params.priority ?? "default",
      nodeUrl: window.location.origin + "/rpc",
      nodeHost: window.location.host,
      preparedAt: Date.now(),
      expiresAt: Date.now() + 300000,
      relayAttempts: 0,
      maxRelayAttempts: 3,
      lastRelayError: null
    };
    emit({ ...snapshot, pendingTx: prepared });
    return prepared;
  },
  prepareSweep: async () => { throw new Error("not used"); },
  prepareConversion: async () => { throw new Error("not used"); },
  relayPrepared: async (): Promise<RelayOutcomeDto> => {
    emit({ ...snapshot, savingState: true, savingKind: "post-relay" });
    await new Promise<void>((resolve) => {
      releaseSaveBarrier = resolve;
    });
    emit({ ...snapshot, savingState: false, savingKind: null, pendingTx: null });
    return {
      kind: "relayed",
      txHashes: [MOCK_TXID],
      relayedAt: Date.now(),
      nodeHost: window.location.host,
      persisted: true
    };
  },
  discardPrepared: async () => emit({ ...snapshot, pendingTx: null }),
  retryPersist: async () => snapshot,
  clearUnresolvedRelay: async () => snapshot,
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app");
mount(WalletApp, {
  target,
  props: {
    client: mockClient,
    surface: "tab",
    defaultNodeUrl: window.location.origin + "/rpc"
  }
});
`;

  fs.writeFileSync(path.join(srcDir, "main.ts"), mockMainTs);

  await viteBuild({
    root: tmpDir,
    base: "/__mock-barrier/",
    logLevel: "silent",
    resolve: {
      alias: {
        "@lateo-wallet/ui/styles": path.join(REPO_ROOT, "packages/ui/src/styles/index.css"),
        "@lateo-wallet/ui": path.join(REPO_ROOT, "packages/ui/src/index.ts"),
        "@lateo-wallet/core/rpc": path.join(REPO_ROOT, "packages/core/src/rpc/protocol.ts"),
        "@lateo-wallet/core/storage": path.join(REPO_ROOT, "packages/core/src/storage/types.ts"),
        "@lateo-wallet/core/assets": path.join(REPO_ROOT, "packages/core/src/assets/index.ts"),
        "@lateo-wallet/core/node-url": path.join(REPO_ROOT, "packages/core/src/network/node-url.ts"),
        "@lateo-wallet/core/qr": path.join(REPO_ROOT, "packages/core/src/qr/index.ts"),
        "@lateo-wallet/core/tx": path.join(REPO_ROOT, "packages/core/src/tx/index.ts"),
        "@lateo-wallet/core/vault": path.join(REPO_ROOT, "packages/core/src/vault/index.ts"),
        "@lateo-wallet/core": path.join(REPO_ROOT, "packages/core/src/index.ts")
      }
    },
    plugins: [
      svelte({
        emitCss: true,
        compilerOptions: {
          runes: true,
          css: "external"
        }
      })
    ],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0
    }
  });

  return { tmpDir, outDir };
}

function startWebServer(distDir, mockBarrierDistDir) {
  const stats = {
    workerCspResponses: 0,
    rpcProxiedCount: 0,
    blockedRelayAttempts: 0,
    manifestServed: false
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // 1. Same-origin /rpc read-only reverse proxy (strictly blocks all tx relays)
      if (pathname === "/rpc" || pathname.startsWith("/rpc/")) {
        const subPath = pathname.slice("/rpc".length) || "/";
        if (BLOCKED_RELAY_PATH_RE.test(subPath)) {
          stats.blockedRelayAttempts += 1;
          res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff"
          });
          res.end(JSON.stringify({ error: "Transaction relay is strictly blocked in verification proxy" }));
          return;
        }

        const body =
          req.method === "POST" || req.method === "PUT" ? await readRequestBody(req) : undefined;

        if (body && body.length > 0 && /\/json_rpc$/i.test(subPath)) {
          try {
            const parsed = JSON.parse(body.toString("utf8"));
            if (typeof parsed?.method === "string" && BLOCKED_RELAY_METHOD_RE.test(parsed.method)) {
              stats.blockedRelayAttempts += 1;
              res.writeHead(403, {
                "Content-Type": "application/json; charset=utf-8",
                "X-Content-Type-Options": "nosniff"
              });
              res.end(JSON.stringify({ error: "Blocked relay JSON-RPC method" }));
              return;
            }
          } catch {
            // Non-JSON body; let upstream handle or reject
          }
        }

        const upstreamUrl = `${UPSTREAM_NODE}${subPath}`;
        const headers = {};
        if (req.headers["content-type"]) {
          headers["content-type"] = String(req.headers["content-type"]);
        }
        if (body !== undefined) {
          headers["content-length"] = String(body.byteLength);
        }

        const upstreamRes = await fetch(upstreamUrl, {
          method: req.method ?? "GET",
          headers,
          redirect: "manual",
          ...(body !== undefined ? { body } : {})
        });
        const upstreamBuf = Buffer.from(await upstreamRes.arrayBuffer());
        stats.rpcProxiedCount += 1;
        res.writeHead(upstreamRes.status, {
          "Content-Type": upstreamRes.headers.get("content-type") ?? "application/octet-stream",
          "Content-Length": String(upstreamBuf.byteLength),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        });
        res.end(upstreamBuf);
        return;
      }

      // 2. Temporary mocked-barrier fixture under exact same Document CSP
      if (mockBarrierDistDir && pathname.startsWith("/__mock-barrier/")) {
        const rel = pathname.slice("/__mock-barrier/".length) || "index.html";
        const resolved = path.resolve(mockBarrierDistDir, rel);
        if (!resolved.startsWith(mockBarrierDistDir) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
          res.writeHead(404, { "Content-Security-Policy": DOCUMENT_CSP });
          res.end("Not found");
          return;
        }
        const ext = path.extname(resolved);
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
          "Content-Security-Policy": DOCUMENT_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store"
        });
        res.end(fs.readFileSync(resolved));
        return;
      }

      // 3. Static production PWA assets from apps/web/dist
      const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const resolved = path.resolve(distDir, relPath);
      if (!resolved.startsWith(distDir) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        console.warn(`[verify-web server] 404 ${req.method} ${pathname}`);
        res.writeHead(404, {
          "Content-Security-Policy": DOCUMENT_CSP,
          "X-Content-Type-Options": "nosniff"
        });
        res.end("Not found");
        return;
      }

      const ext = path.extname(resolved);
      const isWorker = /^assets\/zephyr\.worker-[A-Za-z0-9_-]+\.js$/.test(relPath);
      if (isWorker) {
        stats.workerCspResponses += 1;
      }
      if (relPath === "manifest.webmanifest") {
        stats.manifestServed = true;
      }

      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Content-Security-Policy": isWorker ? WORKER_CSP : DOCUMENT_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": relPath === "index.html" ? "no-cache" : "no-store"
      });
      res.end(fs.readFileSync(resolved));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : "Proxy error");
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        stats
      });
    });
    server.on("error", reject);
  });
}

async function verifyChromium(baseUrl, stats) {
  const chromeBin = findBinary("CHROME_BIN", [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ]);
  assert(chromeBin, "No Chromium/Chrome binary found");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-web-chrome-"));
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    headless: false,
    args: ["--headless=new", "--no-sandbox", "--disable-gpu"]
  });

  try {
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[chrome] ${msg.text()}`);
    });
    page.on("pageerror", (err) => pageErrors.push(`[chrome] ${err.message}`));

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

    const assertGuards = async (label) => {
      const info = await page.evaluate(() => ({
        styleTags: document.querySelectorAll("style").length,
        inlineStyles: document.querySelectorAll("[style]").length,
        cspViolations: window.__lateoCspViolations ?? []
      }));
      assert(info.styleTags === 0, `[chrome:${label}] Found ${info.styleTags} <style> tags`);
      assert(info.inlineStyles === 0, `[chrome:${label}] Found ${info.inlineStyles} [style] attrs`);
      for (const v of info.cspViolations) {
        cspViolations.push(`[chrome:${label}] ${JSON.stringify(v)}`);
      }
    };

    // 1. Load PWA + verify manifest + create disposable wallet with live /rpc height + blank printsheet + 3-word quiz
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="welcome-chooser"]', { timeout: 20_000 });
    await assertGuards("welcome");

    const manifestOk = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return false;
      const res = await fetch(link.getAttribute("href"));
      if (!res.ok) return false;
      const json = await res.json();
      return Boolean(json.name && Array.isArray(json.icons) && json.icons.length > 0);
    });
    assert(manifestOk, "Chrome: manifest.webmanifest fetch or structure failed");

    await page.click('[data-testid="choose-create-btn"]');
    await page.fill('[data-testid="create-password"]', PW_INITIAL);
    await page.fill('[data-testid="create-confirm"]', PW_INITIAL);
    await page.click('[data-testid="create-submit-btn"]');

    await page.waitForSelector('[data-testid="seed-backup-panel"]', { timeout: 60_000 });
    const backupHeightSource = (await page.textContent('[data-testid="backup-height-source"]'))?.trim();
    assert(
      backupHeightSource === "Live daemon height",
      `Chrome: expected Live daemon height via /rpc, got "${backupHeightSource}"`
    );

    const seedWords = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="seed-word-grid"] li code')).map((e) =>
        (e.textContent ?? "").trim()
      )
    );
    assert(seedWords.length === 25, `Chrome: expected 25 seed words, got ${seedWords.length}`);

    // Verify blank printsheet has 25 empty slots and leaks zero live seed words
    const printCheck = await page.evaluate((words) => {
      const sheet = document.querySelector('[data-testid="blank-backup-sheet"]');
      if (!sheet) return { ok: false, reason: "missing sheet" };
      const slots = sheet.querySelectorAll(".lt-backup-slot").length;
      const text = (sheet.textContent ?? "").toLowerCase();
      const leaked = words.filter((w) => w.length > 3 && text.includes(w.toLowerCase()));
      return { ok: slots === 25 && leaked.length === 0, slots, leakedCount: leaked.length };
    }, seedWords);
    assert(printCheck.ok, `Chrome: blank printsheet check failed: ${JSON.stringify(printCheck)}`);

    await page.click('[data-testid="start-quiz-btn"]');
    await page.waitForSelector('[data-testid="seed-quiz-form"]', { timeout: 10_000 });
    const quizPos = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-quiz-pos]")).map((el) =>
        Number(el.getAttribute("data-quiz-pos"))
      )
    );
    for (const pos of quizPos) {
      await page.fill(`[data-testid="quiz-input-${pos}"]`, seedWords[pos - 1]);
    }
    await page.click('[data-testid="verify-quiz-btn"]');
    await page.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 30_000 });

    const createdAddr = (await page.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(createdAddr && /^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Chrome: invalid address ${createdAddr}`);
    assert(
      (await page.textContent('[data-testid="diag-host-kind"]'))?.trim() === "web-worker",
      "Chrome: expected hostKind === web-worker"
    );

    for (const code of ["ZPH", "ZSD", "ZRS", "ZYS"]) {
      await page.waitForSelector(`[data-testid="balance-card-${code}"]`, { timeout: 5_000 });
    }

    // 2. Live read-only sync against /rpc
    await page.click('[data-testid="sync-now-btn"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="sync-state-badge"]')?.textContent?.trim() === "Synced",
      null,
      { timeout: 240_000 }
    );
    await page.waitForSelector('[data-testid="reserve-ratio-value"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="oracle-prices-grid"]', { timeout: 15_000 });
    const syncedHeight = parseLeadingHeight(
      (await page.textContent('[data-testid="sync-heights"]')) ?? ""
    );
    assert(syncedHeight > 100_000, `Chrome: expected synced height > 100000, got ${syncedHeight}`);
    const reserveRatioText = (await page.textContent('[data-testid="reserve-ratio-value"]'))?.trim();

    // 3. M1.4 Send/Sweep & Convert validation + live reserve-gating banner
    await page.click('[data-testid="tab-send"]');
    await page.waitForSelector('[data-testid="send-view"]', { timeout: 10_000 });
    await page.fill('[data-testid="send-address-input-0"]', "ZEPHYRinvalidchecksum");
    await page.fill('[data-testid="send-amount-input-0"]', "1.25");
    await page.click('[data-testid="prepare-send-btn"]');
    await page.waitForSelector('[data-testid="send-error-banner"]', { timeout: 15_000 });
    assert(
      ((await page.textContent('[data-testid="send-error-banner"]')) ?? "").includes(
        "not a valid Zephyr mainnet address"
      ),
      "Chrome: expected invalid address rejection"
    );
    await page.click('[data-testid="send-mode-sweep"]');
    await page.waitForSelector('[data-testid="sweep-mode-explainer"]', { timeout: 5_000 });
    await page.fill('[data-testid="sweep-address-input"]', createdAddr);
    await page.click('[data-testid="prepare-send-btn"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="send-error-banner"]')
          ?.textContent?.includes("No unlocked ZPH available to sweep"),
      null,
      { timeout: 15_000 }
    );
    await assertGuards("send");

    await page.click('[data-testid="tab-convert"]');
    await page.waitForSelector('[data-testid="convert-view"]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="convert-reserve-gate-banner"]', { timeout: 10_000 });
    for (const pairId of ["ZPH-ZSD", "ZSD-ZPH", "ZPH-ZRS", "ZRS-ZPH", "ZSD-ZYS", "ZYS-ZSD"]) {
      await page.waitForSelector(`[data-testid="convert-pair-${pairId}"]`, { timeout: 5_000 });
    }
    await page.click('[data-testid="convert-pair-ZPH-ZRS"]');
    await page.fill('[data-testid="convert-amount-input"]', "1.12345");
    await page.waitForSelector('[data-testid="convert-amount-error"]', { timeout: 5_000 });
    assert(
      ((await page.textContent('[data-testid="convert-amount-error"]')) ?? "").includes(
        "at most 4 decimal places"
      ),
      "Chrome: expected >4 decimal conversion rejection"
    );
    await assertGuards("convert");

    // 4. Receive view: subaddress creation + rename + QR SVG
    await page.click('[data-testid="tab-receive"]');
    await page.waitForSelector('[data-testid="receive-view"]', { timeout: 10_000 });
    await page.fill('[data-testid="new-subaddress-label"]', "Web Sub 1");
    await page.click('[data-testid="create-subaddress-btn"]');
    await page.waitForSelector('[data-testid="subaddress-label-1"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="qr-code-svg"] path', { timeout: 10_000 });
    await assertGuards("receive");

    // 5. Settings: Node probe on /rpc + Password rotation + Danger Zone reveal & blur auto-mask
    await page.click('[data-testid="tab-security"]');
    await page.waitForSelector('[data-testid="node-switcher"]', { timeout: 10_000 });
    await page.click('[data-testid="probe-saved-default"]');
    await page.waitForSelector('[data-testid="node-probe-result"]', { timeout: 20_000 });
    const probeText = (await page.textContent('[data-testid="node-probe-result"]')) ?? "";
    assert(probeText.includes("Connected to"), `Chrome: expected Connected probe, got "${probeText}"`);

    await page.fill('[data-testid="current-pw-input"]', PW_INITIAL);
    await page.fill('[data-testid="change-pw-password"]', PW_ROTATED);
    await page.fill('[data-testid="change-pw-confirm"]', PW_ROTATED);
    await page.click('[data-testid="change-pw-submit"]');
    await page.waitForSelector('[data-testid="change-pw-success"]', { timeout: 20_000 });

    await page.fill('[data-testid="reveal-pw-input"]', PW_ROTATED);
    await page.click('[data-testid="reveal-submit-btn"]');
    await page.waitForSelector('[data-testid="revealed-secrets-box"]', { timeout: 20_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForSelector('[data-testid="revealed-secrets-box"]', {
      state: "detached",
      timeout: 5_000
    });

    // 6. Lock + FULL PAGE RELOAD + Unlock from origin IndexedDB -> verify address & synced checkpoint height!
    await page.click('[data-testid="lock-btn"]');
    await page.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
    await assertGuards("reloaded-locked");

    await page.fill('[data-testid="unlock-password-input"]', PW_INITIAL);
    await page.click('[data-testid="unlock-submit-btn"]');
    await page.waitForSelector('[data-testid="unlock-error"]', { timeout: 20_000 });

    await page.fill('[data-testid="unlock-password-input"]', PW_ROTATED);
    await page.click('[data-testid="unlock-submit-btn"]');
    await page.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 60_000 });

    const reopenedAddr = (await page.textContent('[data-testid="primary-address"]'))
      ?.replace(/\s+/g, "")
      .trim();
    assert(reopenedAddr === createdAddr, `Chrome: address mismatch after reload (${reopenedAddr} !== ${createdAddr})`);

    const reopenedHeight = parseLeadingHeight(
      (await page.textContent('[data-testid="sync-heights"]')) ?? ""
    );
    assert(
      reopenedHeight >= syncedHeight,
      `Chrome: checkpoint height did not persist across reload (${reopenedHeight} < ${syncedHeight})`
    );

    await page.click('[data-testid="tab-receive"]');
    await page.waitForSelector('[data-testid="subaddress-label-1"]', { timeout: 15_000 });
    assert(
      (await page.textContent('[data-testid="subaddress-label-1"]'))?.trim() === "Web Sub 1",
      "Chrome: subaddress label did not persist across reload"
    );

    // 7. Verify localStorage/sessionStorage hygiene (prefs only, zero secrets/blobs)
    const storageAudit = await page.evaluate(
      ({ pw1, pw2, addr, words }) => {
        const lsKeys = Object.keys(localStorage);
        const lsDump = lsKeys.map((k) => `${k}=${localStorage.getItem(k)}`).join("\n");
        const leakedWord = words.find((w) => w.length > 4 && lsDump.includes(w));
        return {
          lsKeys,
          ssLen: sessionStorage.length,
          hasPw: lsDump.includes(pw1) || lsDump.includes(pw2),
          hasAddr: lsDump.includes(addr),
          leakedWord: leakedWord ?? null
        };
      },
      { pw1: PW_INITIAL, pw2: PW_ROTATED, addr: createdAddr, words: seedWords }
    );
    assert(
      storageAudit.ssLen === 0 &&
        !storageAudit.hasPw &&
        !storageAudit.hasAddr &&
        !storageAudit.leakedWord &&
        storageAudit.lsKeys.every((k) => k === "lateo_wallet_prefs_v1"),
      `Chrome: localStorage/sessionStorage audit failed: ${JSON.stringify(storageAudit)}`
    );

    await page.click('[data-testid="lock-btn"]');
    await page.waitForSelector('[data-testid="unlock-screen"]', { timeout: 20_000 });
    await assertGuards("final");

    // 8. Verify mocked M1.4 Review panel + non-dismissible "Saving wallet state..." barrier + beforeunload under strict CSP
    await page.goto(`${baseUrl}/__mock-barrier/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="wallet-unlocked"]', { timeout: 15_000 });
    await page.click('[data-testid="tab-send"]');
    await page.fill('[data-testid="send-address-input-0"]', createdAddr);
    await page.fill('[data-testid="send-amount-input-0"]', "1.25");
    await page.click('[data-testid="prepare-send-btn"]');
    await page.waitForSelector('[data-testid="tx-review-panel"]', { timeout: 10_000 });
    await page.click('[data-testid="confirm-relay-btn"]');
    await page.waitForSelector('[data-testid="post-relay-saving-barrier"]', { timeout: 10_000 });

    const barrierCheck = await page.evaluate(() => {
      const lockBtn = document.querySelector('[data-testid="lock-btn"]');
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return {
        lockDisabled: Boolean(lockBtn?.hasAttribute("disabled")),
        beforeUnloadPrevented: ev.defaultPrevented
      };
    });
    assert(
      barrierCheck.lockDisabled && barrierCheck.beforeUnloadPrevented,
      `Chrome: saving barrier guard failed: ${JSON.stringify(barrierCheck)}`
    );

    await page.evaluate(() => window.__releaseMockSaveBarrier?.());
    await page.waitForSelector('[data-testid="post-relay-saving-barrier"]', {
      state: "detached",
      timeout: 10_000
    });
    await page.waitForSelector('[data-testid="relay-receipt-panel"]', { timeout: 10_000 });
    const afterBarrierUnload = await page.evaluate(() => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    assert(!afterBarrierUnload, "Chrome: beforeunload remained active after save completed");
    await assertGuards("mock-barrier");

    assert(stats.workerCspResponses > 0, "Chrome: expected worker CSP response header to be served");
    assert(consoleErrors.length === 0, `Chrome console errors: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `Chrome page errors: ${pageErrors.join(" | ")}`);
    assert(cspViolations.length === 0, `Chrome CSP violations: ${cspViolations.join(" | ")}`);

    return {
      browser: "chromium",
      syncedHeight,
      reopenedCheckpointHeight: reopenedHeight,
      reserveRatioText,
      blankPrintSheetVerified: true,
      sendSweepConvertVerified: true,
      mockReviewAndSavingBarrierVerified: true,
      subaddressPersistedAcrossReload: true,
      passwordRotationAndBlurMaskVerified: true,
      localStorageHygieneVerified: true,
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
    throw new Error(`WebDriver ${method} ${endpoint} non-JSON (${res.status}): ${text}`);
  }
  if (!res.ok) {
    throw new Error(`WebDriver ${method} ${endpoint} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.value;
}

async function waitForCondWd(base, sessionId, script, args = [], timeoutMs = 60_000, label = "cond") {
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

async function waitForSelectorWd(base, sessionId, selector, timeoutMs = 60_000, absent = false) {
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

async function verifyFirefox(baseUrl, stats) {
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

  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const driver = spawn(geckodriverBin, ["--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const readyDeadline = Date.now() + 20_000;
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
  const workerResponsesBefore = stats.workerCspResponses;
  try {
    const session = await wdReq(base, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: firefoxBin,
            args: ["-headless"]
          }
        }
      }
    });
    sessionId = session.sessionId;
    const browserVersion = session.capabilities?.browserVersion ?? "unknown";

    const installMonitors = async () => {
      await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
        script: `
          if (!window.__lateoMonitors) {
            window.__lateoMonitors = true;
            window.__lateoErrors = [];
            window.__lateoCsp = [];
            const origErr = console.error;
            console.error = (...args) => {
              window.__lateoErrors.push(args.map(String).join(" "));
              return origErr.apply(console, args);
            };
            window.addEventListener("error", (e) => window.__lateoErrors.push(e.message));
            window.addEventListener("unhandledrejection", (e) => window.__lateoErrors.push(String(e.reason)));
            document.addEventListener("securitypolicyviolation", (e) => window.__lateoCsp.push(e.violatedDirective + ":" + e.blockedURI));
          }
        `,
        args: []
      });
    };

    const assertGuards = async (label) => {
      const g = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
        script: `
          return {
            styleTags: document.querySelectorAll("style").length,
            inlineStyles: document.querySelectorAll("[style]").length,
            errors: window.__lateoErrors ?? [],
            csp: window.__lateoCsp ?? []
          };
        `,
        args: []
      });
      assert(g.styleTags === 0, `[firefox:${label}] Found ${g.styleTags} <style> tags`);
      assert(g.inlineStyles === 0, `[firefox:${label}] Found ${g.inlineStyles} [style] attrs`);
      assert(g.errors.length === 0, `[firefox:${label}] Errors: ${JSON.stringify(g.errors)}`);
      assert(g.csp.length === 0, `[firefox:${label}] CSP violations: ${JSON.stringify(g.csp)}`);
    };

    // 1. Load PWA + create wallet + blank printsheet + 3-word quiz
    await wdReq(base, "POST", `/session/${sessionId}/url`, { url: `${baseUrl}/` });
    await waitForSelectorWd(base, sessionId, '[data-testid="welcome-chooser"]', 20_000);
    await installMonitors();
    await assertGuards("welcome");

    await wdClick(base, sessionId, '[data-testid="choose-create-btn"]');
    await wdFill(base, sessionId, '[data-testid="create-password"]', PW_INITIAL);
    await wdFill(base, sessionId, '[data-testid="create-confirm"]', PW_INITIAL);
    await wdClick(base, sessionId, '[data-testid="create-submit-btn"]');

    await waitForSelectorWd(base, sessionId, '[data-testid="seed-backup-panel"]', 60_000);
    const heightSource = (await wdText(base, sessionId, '[data-testid="backup-height-source"]')).trim();
    assert(heightSource === "Live daemon height", `Firefox: expected Live daemon height, got "${heightSource}"`);

    const seedWords = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script:
        'return Array.from(document.querySelectorAll(\'[data-testid="seed-word-grid"] li code\')).map((e) => (e.textContent || "").trim());',
      args: []
    });
    assert(seedWords.length === 25, `Firefox: expected 25 seed words, got ${seedWords.length}`);

    const printOk = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const sheet = document.querySelector('[data-testid="blank-backup-sheet"]');
        if (!sheet) return false;
        const slots = sheet.querySelectorAll(".lt-backup-slot").length;
        const text = (sheet.textContent || "").toLowerCase();
        const leaked = arguments[0].filter((w) => w.length > 3 && text.includes(w.toLowerCase()));
        return slots === 25 && leaked.length === 0;
      `,
      args: [seedWords]
    });
    assert(printOk, "Firefox: blank printsheet check failed");

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
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 30_000);

    const createdAddr = (await wdText(base, sessionId, '[data-testid="primary-address"]'))
      .replace(/\s+/g, "")
      .trim();
    assert(/^ZEPHYR[0-9A-Za-z]+$/.test(createdAddr), `Firefox: invalid address ${createdAddr}`);
    assert(
      (await wdText(base, sessionId, '[data-testid="diag-host-kind"]')).trim() === "web-worker",
      "Firefox: expected hostKind === web-worker"
    );

    for (const code of ["ZPH", "ZSD", "ZRS", "ZYS"]) {
      await waitForSelectorWd(base, sessionId, `[data-testid="balance-card-${code}"]`, 5_000);
    }

    // 2. Live read-only sync against /rpc
    await wdClick(base, sessionId, '[data-testid="sync-now-btn"]');
    await waitForCondWd(
      base,
      sessionId,
      'return document.querySelector(\'[data-testid="sync-state-badge"]\')?.textContent?.trim() === "Synced";',
      [],
      240_000,
      "Firefox synced state"
    );
    await waitForSelectorWd(base, sessionId, '[data-testid="reserve-ratio-value"]', 30_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="oracle-prices-grid"]', 15_000);
    const syncedHeight = parseLeadingHeight(await wdText(base, sessionId, '[data-testid="sync-heights"]'));
    assert(syncedHeight > 100_000, `Firefox: expected synced height > 100000, got ${syncedHeight}`);
    const reserveRatioText = (await wdText(base, sessionId, '[data-testid="reserve-ratio-value"]')).trim();

    // 3. M1.4 Send & Convert validation + live reserve-gating banner
    await wdClick(base, sessionId, '[data-testid="tab-send"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="send-view"]', 10_000);
    await wdFill(base, sessionId, '[data-testid="send-address-input-0"]', "ZEPHYRinvalidchecksum");
    await wdFill(base, sessionId, '[data-testid="send-amount-input-0"]', "1.25");
    await wdClick(base, sessionId, '[data-testid="prepare-send-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="send-error-banner"]', 15_000);
    assert(
      (await wdText(base, sessionId, '[data-testid="send-error-banner"]')).includes(
        "not a valid Zephyr mainnet address"
      ),
      "Firefox: expected invalid address rejection"
    );
    await assertGuards("send");

    await wdClick(base, sessionId, '[data-testid="tab-convert"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="convert-view"]', 10_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="convert-reserve-gate-banner"]', 10_000);
    for (const pairId of ["ZPH-ZSD", "ZSD-ZPH", "ZPH-ZRS", "ZRS-ZPH", "ZSD-ZYS", "ZYS-ZSD"]) {
      await waitForSelectorWd(base, sessionId, `[data-testid="convert-pair-${pairId}"]`, 5_000);
    }
    await wdClick(base, sessionId, '[data-testid="convert-pair-ZPH-ZRS"]');
    await wdFill(base, sessionId, '[data-testid="convert-amount-input"]', "2.12345");
    await waitForSelectorWd(base, sessionId, '[data-testid="convert-amount-error"]', 5_000);
    assert(
      (await wdText(base, sessionId, '[data-testid="convert-amount-error"]')).includes(
        "at most 4 decimal places"
      ),
      "Firefox: expected >4 decimal conversion rejection"
    );
    await assertGuards("convert");

    // 4. Receive view: subaddress creation + QR SVG
    await wdClick(base, sessionId, '[data-testid="tab-receive"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="receive-view"]', 10_000);
    await wdFill(base, sessionId, '[data-testid="new-subaddress-label"]', "Firefox Web Sub");
    await wdClick(base, sessionId, '[data-testid="create-subaddress-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="subaddress-label-1"]', 20_000);
    await waitForSelectorWd(base, sessionId, '[data-testid="qr-code-svg"] path', 10_000);
    await assertGuards("receive");

    // 5. Settings: Password rotation + Danger Zone reveal & blur auto-mask
    await wdClick(base, sessionId, '[data-testid="tab-security"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="node-switcher"]', 10_000);
    await wdFill(base, sessionId, '[data-testid="current-pw-input"]', PW_INITIAL);
    await wdFill(base, sessionId, '[data-testid="change-pw-password"]', PW_ROTATED);
    await wdFill(base, sessionId, '[data-testid="change-pw-confirm"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="change-pw-submit"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="change-pw-success"]', 20_000);

    await wdFill(base, sessionId, '[data-testid="reveal-pw-input"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="reveal-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="revealed-secrets-box"]', 20_000);
    await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: 'window.dispatchEvent(new Event("blur"));',
      args: []
    });
    await waitForSelectorWd(base, sessionId, '[data-testid="revealed-secrets-box"]', 5_000, true);

    // 6. Lock + FULL PAGE RELOAD + Unlock from origin IndexedDB
    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 20_000);
    await assertGuards("pre-reload");

    await wdReq(base, "POST", `/session/${sessionId}/refresh`, {});
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 20_000);
    await installMonitors();

    await wdFill(base, sessionId, '[data-testid="unlock-password-input"]', PW_ROTATED);
    await wdClick(base, sessionId, '[data-testid="unlock-submit-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 60_000);

    const reopenedAddr = (await wdText(base, sessionId, '[data-testid="primary-address"]'))
      .replace(/\s+/g, "")
      .trim();
    assert(reopenedAddr === createdAddr, `Firefox: address mismatch after reload`);

    const reopenedHeight = parseLeadingHeight(
      await wdText(base, sessionId, '[data-testid="sync-heights"]')
    );
    assert(
      reopenedHeight >= syncedHeight,
      `Firefox: checkpoint height did not persist across reload (${reopenedHeight} < ${syncedHeight})`
    );

    await wdClick(base, sessionId, '[data-testid="tab-receive"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="subaddress-label-1"]', 15_000);
    assert(
      (await wdText(base, sessionId, '[data-testid="subaddress-label-1"]')).trim() ===
        "Firefox Web Sub",
      "Firefox: subaddress label did not persist across reload"
    );

    const storageOk = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const keys = Object.keys(localStorage);
        const dump = keys.map((k) => k + "=" + localStorage.getItem(k)).join("\\n");
        return sessionStorage.length === 0 &&
          keys.every((k) => k === "lateo_wallet_prefs_v1") &&
          !dump.includes(arguments[0]) &&
          !dump.includes(arguments[1]);
      `,
      args: [PW_ROTATED, createdAddr]
    });
    assert(storageOk, "Firefox: localStorage/sessionStorage hygiene check failed");

    await wdClick(base, sessionId, '[data-testid="lock-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="unlock-screen"]', 20_000);
    await assertGuards("final");

    // 7. Mocked M1.4 Review panel + "Saving wallet state..." barrier + beforeunload under strict CSP
    await wdReq(base, "POST", `/session/${sessionId}/url`, {
      url: `${baseUrl}/__mock-barrier/index.html`
    });
    await waitForSelectorWd(base, sessionId, '[data-testid="wallet-unlocked"]', 15_000);
    await installMonitors();

    await wdClick(base, sessionId, '[data-testid="tab-send"]');
    await wdFill(base, sessionId, '[data-testid="send-address-input-0"]', createdAddr);
    await wdFill(base, sessionId, '[data-testid="send-amount-input-0"]', "1.25");
    await wdClick(base, sessionId, '[data-testid="prepare-send-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="tx-review-panel"]', 10_000);
    await wdClick(base, sessionId, '[data-testid="confirm-relay-btn"]');
    await waitForSelectorWd(base, sessionId, '[data-testid="post-relay-saving-barrier"]', 10_000);

    const barrierOk = await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: `
        const lockBtn = document.querySelector('[data-testid="lock-btn"]');
        const ev = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(ev);
        return Boolean(lockBtn && lockBtn.hasAttribute("disabled")) && ev.defaultPrevented;
      `,
      args: []
    });
    assert(barrierOk, "Firefox: post-relay saving barrier / beforeunload guard failed");

    await wdReq(base, "POST", `/session/${sessionId}/execute/sync`, {
      script: "window.__releaseMockSaveBarrier && window.__releaseMockSaveBarrier();",
      args: []
    });
    await waitForSelectorWd(base, sessionId, '[data-testid="post-relay-saving-barrier"]', 10_000, true);
    await waitForSelectorWd(base, sessionId, '[data-testid="relay-receipt-panel"]', 10_000);
    await assertGuards("mock-barrier");

    assert(
      stats.workerCspResponses > workerResponsesBefore,
      "Firefox: expected worker CSP header to be served for zephyr.worker-*.js"
    );

    return {
      browser: `firefox ${browserVersion}`,
      syncedHeight,
      reopenedCheckpointHeight: reopenedHeight,
      reserveRatioText,
      blankPrintSheetVerified: true,
      sendSweepConvertVerified: true,
      mockReviewAndSavingBarrierVerified: true,
      subaddressPersistedAcrossReload: true,
      passwordRotationAndBlurMaskVerified: true,
      localStorageHygieneVerified: true,
      workerCspVerified: true,
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
  assert(fs.existsSync(path.join(WEB_DIST, "index.html")), "Build apps/web/dist first (corepack pnpm build:web)");
  const fixture = await buildMockBarrierFixture();
  const srv = await startWebServer(WEB_DIST, fixture.outDir);

  try {
    // Explicitly verify the /rpc proxy blocks relay endpoints (403) before browser runs
    const blockedRes = await fetch(`${srv.baseUrl}/rpc/sendrawtransaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_as_hex: "00" })
    });
    assert(blockedRes.status === 403, `Expected /rpc/sendrawtransaction to return 403, got ${blockedRes.status}`);
    const blockedRes2 = await fetch(`${srv.baseUrl}/rpc/send_raw_transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_as_hex: "00" })
    });
    assert(blockedRes2.status === 403, `Expected /rpc/send_raw_transaction to return 403, got ${blockedRes2.status}`);
    // Reset counter after explicit guard probe
    srv.stats.blockedRelayAttempts = 0;

    const only = process.argv[2];
    if (!only || only === "chrome") {
      console.log("Running Chromium Phase 2 Web PWA verification...");
      const chromeRes = await verifyChromium(srv.baseUrl, srv.stats);
      console.log("Chromium Web PWA PASS:", JSON.stringify(chromeRes, null, 2));
    }
    if (!only || only === "firefox") {
      console.log("Running Firefox Phase 2 Web PWA verification...");
      const firefoxRes = await verifyFirefox(srv.baseUrl, srv.stats);
      console.log("Firefox Web PWA PASS:", JSON.stringify(firefoxRes, null, 2));
    }

    assert(srv.stats.blockedRelayAttempts === 0, "Unexpected live relay attempt detected during verification");
    assert(srv.stats.rpcProxiedCount > 0, "Expected read-only /rpc proxy traffic");
  } finally {
    srv.server.close();
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
