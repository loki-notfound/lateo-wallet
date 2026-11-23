import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  buildStaticFileMap,
  DEFAULT_DAEMON_ORIGIN,
  DESKTOP_PAGE_CSP,
  DESKTOP_WORKER_CSP,
  isAllowedAppNavigation,
  isAllowedDaemonRequest,
  isWorkerAssetPath,
  resolveDaemonOrigin,
  shouldCancelDaemonRedirect,
  withDaemonCorsHeaders
} from "./security.js";

describe("Electron main-process security policy", () => {
  it("allows navigation strictly within app://lateo without port or userinfo", () => {
    expect(isAllowedAppNavigation(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isAllowedAppNavigation("app://lateo:8080/index.html")).toBe(false);
    expect(isAllowedAppNavigation("app://user@lateo/index.html")).toBe(false);
    expect(isAllowedAppNavigation("https://wallet.lateo.dev")).toBe(false);
    expect(isAllowedAppNavigation("http://127.0.0.1:17767")).toBe(false);
    expect(isAllowedAppNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedAppNavigation("javascript:alert(1)")).toBe(false);
  });

  it("scopes outbound daemon requests to authorized origins, xhr, allowed methods, and app://lateo initiator", () => {
    const defaultOnly = new Set<string>([DEFAULT_DAEMON_ORIGIN]);

    expect(
      isAllowedDaemonRequest(
        { url: `${APP_ORIGIN}/assets/app.js`, resourceType: "script", method: "GET" },
        defaultOnly,
        true
      )
    ).toBe(true);

    // Offline mode blocks all non-app requests
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        true
      )
    ).toBe(false);

    // Authorized default origin passes
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(true);

    // Unconfigured loopback and internet origins are blocked until authorized
    expect(
      isAllowedDaemonRequest(
        {
          url: "http://127.0.0.1:18081/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(false);
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://unconfigured.example/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(false);

    // Explicitly authorized custom local node passes for xhr/POST from app://lateo
    const withLocal = new Set<string>([
      DEFAULT_DAEMON_ORIGIN,
      resolveDaemonOrigin("http://127.0.0.1:17767")!
    ]);
    expect(
      isAllowedDaemonRequest(
        {
          url: "http://127.0.0.1:17767/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        withLocal,
        false
      )
    ).toBe(true);

    // Reject wrong resource types, wrong HTTP methods, wrong initiator, non-localhost HTTP, and bad URLs
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc",
          resourceType: "other",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(false);
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc",
          resourceType: "xhr",
          method: "DELETE",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(false);
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: "https://evil.example"
        },
        defaultOnly,
        false
      )
    ).toBe(false);
    expect(
      isAllowedDaemonRequest(
        {
          url: "http://192.168.1.50:17767/json_rpc",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        withLocal,
        false
      )
    ).toBe(false);
    expect(
      isAllowedDaemonRequest(
        {
          url: "https://node.lateo.dev/json_rpc?x=1",
          resourceType: "xhr",
          method: "POST",
          initiatorOrigin: APP_ORIGIN
        },
        defaultOnly,
        false
      )
    ).toBe(false);
  });

  it("cancels 3xx redirects on outbound daemon requests while allowing 200 and app://lateo", () => {
    expect(shouldCancelDaemonRedirect("https://node.lateo.dev/json_rpc", 301)).toBe(true);
    expect(shouldCancelDaemonRedirect("https://node.lateo.dev/json_rpc", 302)).toBe(true);
    expect(shouldCancelDaemonRedirect("https://node.lateo.dev/json_rpc", 307)).toBe(true);
    expect(shouldCancelDaemonRedirect("https://node.lateo.dev/json_rpc", 308)).toBe(true);
    expect(shouldCancelDaemonRedirect("https://node.lateo.dev/json_rpc", 200)).toBe(false);
    expect(shouldCancelDaemonRedirect(`${APP_ORIGIN}/index.html`, 302)).toBe(false);
  });

  it("identifies worker asset paths and serves strict Page/Worker CSP policies", () => {
    expect(isWorkerAssetPath("/assets/zephyr.worker-B784jDau.js")).toBe(true);
    expect(isWorkerAssetPath("/assets/index-abc123.js")).toBe(false);
    expect(DESKTOP_PAGE_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(DESKTOP_PAGE_CSP).toContain("style-src 'self'");
    expect(DESKTOP_PAGE_CSP).not.toContain("'unsafe-inline'");
    expect(DESKTOP_PAGE_CSP).not.toContain("[::1]");
    expect(DESKTOP_WORKER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(DESKTOP_WORKER_CSP).not.toContain("[::1]");
  });

  it("binds CORS response headers strictly to app://lateo", () => {
    const merged = withDaemonCorsHeaders({
      "Content-Type": ["application/json"],
      "access-control-allow-origin": ["*"]
    });
    expect(merged["Access-Control-Allow-Origin"]).toEqual([APP_ORIGIN]);
    expect(merged["Content-Type"]).toEqual(["application/json"]);
    expect(merged["access-control-allow-origin"]).toBeUndefined();
  });

  it("excludes symbolic links from buildStaticFileMap", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lateo-desktop-map-"));
    const outsideFile = path.join(os.tmpdir(), `lateo-outside-${Date.now()}.txt`);
    try {
      fs.writeFileSync(path.join(tmpRoot, "index.html"), "<html></html>");
      fs.writeFileSync(outsideFile, "secret");
      fs.symlinkSync(outsideFile, path.join(tmpRoot, "escape.txt"));

      const map = buildStaticFileMap(tmpRoot);
      expect(map.has("/index.html")).toBe(true);
      expect(map.has("/escape.txt")).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });
});
