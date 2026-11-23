import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbVaultStore } from "./idb-store.js";
import type { EncryptedVaultMetaRecord, EncryptedWalletBlobRecord } from "../vault/types.js";

function makeMeta(updatedAt = 1_700_000_000_000): EncryptedVaultMetaRecord {
  return {
    id: "primary",
    schemaVersion: 1,
    kdf: {
      alg: "PBKDF2-SHA256",
      iterations: 600_000,
      salt: "AAAAAAAAAAAAAAAAAAAAAA=="
    },
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAA",
    updatedAt
  };
}

function makeBlob(walletId = "w1", kind: "keys" | "cache" | "relay" = "cache"): EncryptedWalletBlobRecord {
  return {
    key: `${walletId}:${kind}`,
    walletId,
    kind,
    schemaVersion: 1,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: new Uint8Array([1, 2, 3, 4]),
    syncedHeight: 100,
    updatedAt: 1_700_000_000_000
  };
}

function installFakeIndexedDb(backing: {
  meta: Map<string, Record<string, unknown>>;
  blobs: Map<string, Record<string, unknown>>;
  throwOnTransaction?: Error;
  triggerBlocked?: boolean;
}) {
  let closeCalls = 0;

  const makeStore = (storeName: string) => {
    const map = storeName === "vault_meta" ? backing.meta : backing.blobs;
    return {
      get(key: string) {
        const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          req.result = map.get(key);
          req.onsuccess?.();
        });
        return req as unknown as IDBRequest;
      },
      put(val: Record<string, unknown>) {
        const key = storeName === "vault_meta" ? String(val.id) : String(val.key);
        map.set(key, { ...val });
        const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          req.result = key;
          req.onsuccess?.();
        });
        return req as unknown as IDBRequest;
      },
      delete(key: string) {
        map.delete(key);
      },
      clear() {
        map.clear();
      }
    };
  };

  const fakeIdb = {
    open() {
      const req: {
        result?: unknown;
        error?: Error;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        onupgradeneeded?: () => void;
      } = {};
      queueMicrotask(() => {
        if (backing.triggerBlocked) {
          req.onblocked?.();
          return;
        }
        const db = {
          onversionchange: null as (() => void) | null,
          close() {
            closeCalls += 1;
          },
          transaction() {
            if (backing.throwOnTransaction) {
              throw backing.throwOnTransaction;
            }
            let aborted = false;
            const tx: {
              error?: Error;
              oncomplete?: () => void;
              onabort?: () => void;
              onerror?: () => void;
              abort: () => void;
              objectStore: (name: string) => ReturnType<typeof makeStore>;
            } = {
              abort() {
                aborted = true;
              },
              objectStore(name: string) {
                return makeStore(name);
              }
            };
            setTimeout(() => {
              if (!aborted) {
                tx.oncomplete?.();
              }
            }, 0);
            return tx as unknown as IDBTransaction;
          }
        };
        req.result = db;
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    }
  };

  vi.stubGlobal("indexedDB", fakeIdb);
  return { getCloseCalls: () => closeCalls };
}

describe("IndexedDbVaultStore hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes the database handle cleanly when db.transaction() throws synchronously", async () => {
    const { getCloseCalls } = installFakeIndexedDb({
      meta: new Map(),
      blobs: new Map(),
      throwOnTransaction: new Error("NotFoundError")
    });

    const store = new IndexedDbVaultStore();
    await expect(store.readMeta()).rejects.toThrow("NotFoundError");
    await expect(store.writeBlobsAtomic([makeBlob()])).rejects.toThrow("NotFoundError");
    expect(getCloseCalls()).toBe(2);
  });

  it("rejects cleanly when indexedDB.open triggers onblocked", async () => {
    installFakeIndexedDb({
      meta: new Map(),
      blobs: new Map(),
      triggerBlocked: true
    });

    const store = new IndexedDbVaultStore();
    await expect(store.readMeta()).rejects.toThrow(/blocked/i);
  });

  it("detects stale cross-tab writes via monotonic revision CAS", async () => {
    const backing = {
      meta: new Map<string, Record<string, unknown>>(),
      blobs: new Map<string, Record<string, unknown>>()
    };
    installFakeIndexedDb(backing);

    const tabA = new IndexedDbVaultStore();
    const tabB = new IndexedDbVaultStore();

    await tabA.writeMeta(makeMeta(1_700_000_000_000));
    await tabA.writeBlobsAtomic([makeBlob("w1", "cache")]);

    // Both tabs observe revision 1
    await tabA.readMeta();
    await tabB.readMeta();
    await tabA.readBlob("w1", "cache");
    await tabB.readBlob("w1", "cache");

    // Tab A advances revision to 2
    await tabA.writeMeta(makeMeta(1_700_000_060_000));
    await tabA.writeBlobsAtomic([makeBlob("w1", "cache")]);

    // Tab B's stale writes must abort with STALE_VAULT_REVISION
    await expect(tabB.writeMeta(makeMeta(1_700_000_120_000))).rejects.toThrow(
      /STALE_VAULT_REVISION/
    );
    await expect(tabB.writeBlobsAtomic([makeBlob("w1", "cache")])).rejects.toThrow(
      /STALE_VAULT_REVISION/
    );
  });
});
