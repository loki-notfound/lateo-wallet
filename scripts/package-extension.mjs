#!/usr/bin/env node
/**
 * Deterministic, reproducible production ZIP packager for Lateo Wallet MV3 extensions.
 *
 * Emits:
 *   apps/extension/release/lateo-wallet-chrome-v<version>.zip
 *   apps/extension/release/lateo-wallet-firefox-v<version>.zip
 *   apps/extension/release/SHA256SUMS
 *
 * Reproducibility invariants:
 * - Strict UTF-8 lexicographical path sorting across all archive entries.
 * - File-only entries with normalized POSIX mode 0100644 (-rw-r--r--).
 * - Fixed MS-DOS timestamp corresponding to 2026-01-01T00:00:00Z.
 * - Zero extra fields (no OS UID/GID or variable atime/mtime/ctime metadata).
 * - Deterministic raw DEFLATE compression (zlib level 9).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT_DIR = path.join(ROOT, "apps", "extension");
const DIST_DIR = path.join(EXT_DIR, "dist");
const RELEASE_DIR = path.join(EXT_DIR, "release");

// Fixed timestamp: 2026-01-01 00:00:00 UTC in MS-DOS format
// Date: ((2026 - 1980) << 9) | (1 << 5) | 1 = 0x5c21
// Time: (0 << 11) | (0 << 5) | 0 = 0x0000
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x5c21;

// Version made by: UNIX (3) << 8 | ZIP 3.0 (30 = 0x1e)
const VERSION_MADE_BY_UNIX = 0x031e;
// Version needed to extract: 2.0 (20 = 0x0014)
const VERSION_NEEDED = 20;
// General purpose bit flag: Bit 11 (0x0800) = UTF-8 filename encoding
const GP_FLAG_UTF8 = 0x0800;
// Compression method: 8 = DEFLATE, 0 = STORE
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;
// External file attributes: POSIX regular file 0100644 (-rw-r--r--) in upper 16 bits
const EXT_ATTR_FILE_0644 = (0o100644 << 16) >>> 0;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFilesSorted(baseDir, currentDir = baseDir, out = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to package symbolic link: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      collectFilesSorted(baseDir, fullPath, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".map")) {
        throw new Error(`Refusing to package sourcemap file: ${fullPath}`);
      }
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      out.push({ relPath, fullPath });
    }
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

function buildDeterministicZipBuffer(sourceDir) {
  const files = collectFilesSorted(sourceDir);
  if (files.length === 0) {
    throw new Error(`No files found in ${sourceDir}`);
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const rawData = fs.readFileSync(file.fullPath);
    const nameBytes = Buffer.from(file.relPath, "utf8");
    const checksum = crc32(rawData);

    const useStore = rawData.length === 0;
    const compressedData = useStore
      ? rawData
      : zlib.deflateRawSync(rawData, {
          level: 9,
          memLevel: 8,
          strategy: zlib.constants.Z_DEFAULT_STRATEGY
        });
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE;

    // Local File Header (30 bytes + file name length)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(GP_FLAG_UTF8, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length = 0
    nameBytes.copy(localHeader, 30);

    // Central Directory File Header (46 bytes + file name length)
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    centralHeader.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(GP_FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length = 0
    centralHeader.writeUInt16LE(0, 32); // File comment length = 0
    centralHeader.writeUInt16LE(0, 34); // Disk number start = 0
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes = 0
    centralHeader.writeUInt32LE(EXT_ATTR_FILE_0644, 38); // External file attributes (0100644)
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBytes.copy(centralHeader, 46);

    localChunks.push(localHeader, compressedData);
    centralChunks.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralChunks.reduce((sum, buf) => sum + buf.length, 0);

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8); // Entries on this disk
  eocd.writeUInt16LE(files.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length = 0

  return {
    buffer: Buffer.concat([...localChunks, ...centralChunks, eocd]),
    entryCount: files.length
  };
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function main() {
  const pkgJsonPath = path.join(EXT_DIR, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  const version = pkgJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid version in apps/extension/package.json: ${version}`);
  }

  const targets = ["chrome", "firefox"];
  for (const target of targets) {
    const manifestPath = path.join(DIST_DIR, target, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Missing ${manifestPath}. Run "corepack pnpm build:extension" before packaging.`
      );
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== version) {
      throw new Error(
        `Version mismatch in dist/${target}/manifest.json: expected ${version}, got ${manifest.version}`
      );
    }
  }

  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  const sumLines = [];
  for (const target of targets) {
    const targetDist = path.join(DIST_DIR, target);
    const zipName = `lateo-wallet-${target}-v${version}.zip`;
    const zipPath = path.join(RELEASE_DIR, zipName);
    const { buffer, entryCount } = buildDeterministicZipBuffer(targetDist);
    fs.writeFileSync(zipPath, buffer);
    const digest = sha256Hex(buffer);
    sumLines.push(`${digest}  ${zipName}`);
    console.log(
      `Packaged ${zipName} (${entryCount} files, ${buffer.length} bytes, sha256=${digest})`
    );
  }

  const sumsPath = path.join(RELEASE_DIR, "SHA256SUMS");
  fs.writeFileSync(sumsPath, sumLines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${path.relative(ROOT, sumsPath)}`);
}

main();
