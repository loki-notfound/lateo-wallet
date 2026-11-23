import { describe, expect, it } from "vitest";
import { encodeQrSvgData } from "./index.js";

describe("CSP-safe QR SVG matrix encoding", () => {
  it("encodes a 98-character Zephyr address into pure SVG path data without HTML or styles", () => {
    const sampleAddr =
      "ZEPHs0000EXAMPLE0000PLACEHOLDER000000000000000000000000000000000000000000000000000000000000000000";
    const qr = encodeQrSvgData(sampleAddr);
    expect(qr.size).toBeGreaterThanOrEqual(29);
    expect(qr.quietZone).toBe(4);
    expect(qr.viewBoxSize).toBe(qr.size + 8);
    expect(qr.pathData).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(qr.pathData).not.toContain("<");
    expect(qr.pathData).not.toContain("style");
  });

  it("rejects empty payload", () => {
    expect(() => encodeQrSvgData("")).toThrow();
  });
});
