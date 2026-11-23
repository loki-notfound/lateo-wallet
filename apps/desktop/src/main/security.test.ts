import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  DESKTOP_PAGE_CSP,
  DESKTOP_WORKER_CSP,
  isAllowedAppNavigation,
  isAllowedDaemonRequest,
  isWorkerAssetPath,
  withDaemonCorsHeaders
} from "./security.js";

describe("Electron main-process security policy", () => {
  it("allows navigation strictly within app://lateo", () => {
    expect(isAllowedAppNavigation(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isAllowedAppNavigation("https://wallet.lateo.dev")).toBe(false);
    expect(isAllowedAppNavigation("http://127.0.0.1:17767")).toBe(false);
    expect(isAllowedAppNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedAppNavigation("javascript:alert(1)")).toBe(false);
  });

  it("enforces validateNodeUrl and resource-type restrictions on daemon RPC requests", () => {
    expect(isAllowedDaemonRequest(`${APP_ORIGIN}/assets/app.js`, "script", true)).toBe(true);
    expect(isAllowedDaemonRequest("https://node.lateo.dev/json_rpc", "xhr", true)).toBe(false);
    expect(isAllowedDaemonRequest("https://node.lateo.dev/json_rpc", "xhr", false)).toBe(true);
    expect(isAllowedDaemonRequest("http://127.0.0.1:17767/json_rpc", "fetch", false)).toBe(true);
    expect(isAllowedDaemonRequest("http://192.168.1.50:17767/json_rpc", "fetch", false)).toBe(false);
    expect(isAllowedDaemonRequest("https://node.lateo.dev/script.js", "script", false)).toBe(false);
    expect(isAllowedDaemonRequest("https://node.lateo.dev/json_rpc?x=1", "fetch", false)).toBe(false);
    expect(isAllowedDaemonRequest("https://user:pass@node.lateo.dev/json_rpc", "fetch", false)).toBe(
      false
    );
  });

  it("identifies worker asset paths and serves strict Page/Worker CSP policies", () => {
    expect(isWorkerAssetPath("/assets/zephyr.worker-B784jDau.js")).toBe(true);
    expect(isWorkerAssetPath("/assets/index-abc123.js")).toBe(false);
    expect(DESKTOP_PAGE_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(DESKTOP_PAGE_CSP).toContain("style-src 'self'");
    expect(DESKTOP_PAGE_CSP).not.toContain("'unsafe-inline'");
    expect(DESKTOP_WORKER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
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
});
