import { encode } from "uqr";

export interface QrSvgData {
  /** Number of QR modules along one edge (without quiet zone) */
  readonly size: number;
  /** Quiet zone modules added on each side (ISO 18004 recommends 4) */
  readonly quietZone: number;
  /** Combined SVG viewBox dimension (size + 2 * quietZone) */
  readonly viewBoxSize: number;
  /** Single SVG path data string for all dark modules at 1x1 unit scale */
  readonly pathData: string;
}

/**
 * Encode text into a deterministic, CSP-safe SVG path matrix (zero HTML strings,
 * zero inline styles). Render dark modules (#1c1d1f) on an explicit #ffffff
 * quiet zone even in dark mode.
 */
export function encodeQrSvgData(text: string, quietZone = 4): QrSvgData {
  if (!text) {
    throw new Error("QR payload must not be empty");
  }
  const result = encode(text, { ecc: "M", border: 0 });
  const size = result.size;
  const parts: string[] = [];

  for (let y = 0; y < size; y++) {
    const row = result.data[y];
    if (!row) continue;
    for (let x = 0; x < size; x++) {
      if (row[x]) {
        parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
      }
    }
  }

  return {
    size,
    quietZone,
    viewBoxSize: size + quietZone * 2,
    pathData: parts.join("")
  };
}
