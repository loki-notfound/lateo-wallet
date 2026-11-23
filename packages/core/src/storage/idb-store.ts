import type { VaultBlobStore } from "./types.js";
import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind
} from "../vault/types.js";

const DB_NAME = "lateo-wallet-db";
const DB_VERSION = 1;
const STORE_META = "vault_meta";
const STORE_BLOBS = "wallet_blobs";

type StoredWithRevision<T> = T & { readonly revision?: number };

function extractRevision(record: unknown): number {
  if (record && typeof record === "object" && "revision" in record) {
    const rev = (record as { revision?: unknown }).revision;
    if (typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0) {
      return rev;
    }
  }
  return 0;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("IndexedDB open failed"));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
      }
    };
    req.onblocked = () => {
      reject(new Error("IndexedDB upgrade blocked by an open connection in another tab"));
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function openStrictTx(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode
): IDBTransaction {
  if (mode === "readwrite") {
    return db.transaction(storeNames, mode, { durability: "strict" });
  }
  return db.transaction(storeNames, mode);
}

/**
 * Execute an IndexedDB request and resolve ONLY when the transaction commits
 * (`tx.oncomplete`) with strict durability so readwrite operations survive power loss.
 */
function runTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T | undefined;
        let settled = false;
        const fail = (err: unknown): void => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch {
            // Best-effort handle cleanup
          }
          reject(err instanceof Error ? err : new Error("IndexedDB transaction failed"));
        };

        try {
          const tx = openStrictTx(db, storeName, mode);
          const store = tx.objectStore(storeName);
          const req = fn(store);
          req.onsuccess = () => {
            result = req.result;
          };
          req.onerror = () => fail(req.error ?? new Error("IndexedDB request failed"));
          tx.oncomplete = () => {
            if (settled) return;
            settled = true;
            db.close();
            resolve(result as T);
          };
          tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted"));
          tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction error"));
        } catch (err) {
          fail(err);
        }
      })
  );
}

/**
 * Shared origin IndexedDB VaultBlobStore used by browser extension hosts,
 * the Web PWA, and desktop renderers. Always waits for `tx.oncomplete` with
 * `{ durability: "strict" }`, guards against stale cross-tab writes via
 * monotonic record revisions, and supports atomic multi-blob and vault writes.
 */
export class IndexedDbVaultStore implements VaultBlobStore {
  private readonly knownRevisions = new Map<string, number>();

  private assertAndComputeNextRevision(trackKey: string, existingRecord: unknown): number {
    const existingRev = existingRecord === undefined ? 0 : extractRevision(existingRecord);
    const known = this.knownRevisions.get(trackKey);
    if (known !== undefined && existingRev > known) {
      throw new Error(
        `STALE_VAULT_REVISION: storage key "${trackKey}" was modified by another tab or process`
      );
    }
    return Math.max(known ?? 0, existingRev) + 1;
  }

  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    const record = await runTx<StoredWithRevision<EncryptedVaultMetaRecord> | undefined>(
      STORE_META,
      "readonly",
      (s) => s.get("primary")
    );
    this.knownRevisions.set("meta:primary", record === undefined ? 0 : extractRevision(record));
    return record;
  }

  async writeMeta(record: EncryptedVaultMetaRecord): Promise<void> {
    const db = await openDb();
    let committedRev = 1;
    const trackKey = `meta:${record.id}`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // Best-effort handle cleanup
        }
        reject(err instanceof Error ? err : new Error("Write vault meta failed"));
      };

      try {
        const tx = openStrictTx(db, STORE_META, "readwrite");
        const store = tx.objectStore(STORE_META);
        const getReq = store.get(record.id);
        getReq.onsuccess = () => {
          try {
            committedRev = this.assertAndComputeNextRevision(trackKey, getReq.result);
            store.put({ ...record, revision: committedRev });
          } catch (err) {
            try {
              tx.abort();
            } catch {
              // Ignore abort errors
            }
            fail(err);
          }
        };
        getReq.onerror = () => fail(getReq.error ?? new Error("IndexedDB meta read failed"));

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          db.close();
          this.knownRevisions.set(trackKey, committedRev);
          resolve();
        };
        tx.onabort = () => fail(tx.error ?? new Error("Write vault meta transaction aborted"));
        tx.onerror = () => fail(tx.error ?? new Error("Write vault meta transaction error"));
      } catch (err) {
        fail(err);
      }
    });
  }

  async readBlob(
    walletId: string,
    kind: WalletBlobKind
  ): Promise<EncryptedWalletBlobRecord | undefined> {
    const blobKey = `${walletId}:${kind}`;
    const record = await runTx<StoredWithRevision<EncryptedWalletBlobRecord> | undefined>(
      STORE_BLOBS,
      "readonly",
      (s) => s.get(blobKey)
    );
    this.knownRevisions.set(`blob:${blobKey}`, record === undefined ? 0 : extractRevision(record));
    return record;
  }

  async writeBlob(record: EncryptedWalletBlobRecord): Promise<void> {
    await this.writeBlobsAtomic([record]);
  }

  async writeBlobsAtomic(blobs: readonly EncryptedWalletBlobRecord[]): Promise<void> {
    if (blobs.length === 0) return;
    const db = await openDb();
    const committedRevs = new Map<string, number>();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // Best-effort handle cleanup
        }
        reject(err instanceof Error ? err : new Error("Atomic wallet blobs write failed"));
      };

      try {
        const tx = openStrictTx(db, STORE_BLOBS, "readwrite");
        const blobStore = tx.objectStore(STORE_BLOBS);
        for (const blob of blobs) {
          const trackKey = `blob:${blob.key}`;
          const getReq = blobStore.get(blob.key);
          getReq.onsuccess = () => {
            if (settled) return;
            try {
              const nextRev = this.assertAndComputeNextRevision(trackKey, getReq.result);
              committedRevs.set(trackKey, nextRev);
              blobStore.put({ ...blob, revision: nextRev });
            } catch (err) {
              try {
                tx.abort();
              } catch {
                // Ignore abort errors
              }
              fail(err);
            }
          };
          getReq.onerror = () => fail(getReq.error ?? new Error("IndexedDB blob read failed"));
        }

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          db.close();
          for (const [k, rev] of committedRevs) {
            this.knownRevisions.set(k, rev);
          }
          resolve();
        };
        tx.onabort = () => fail(tx.error ?? new Error("Atomic wallet blobs transaction aborted"));
        tx.onerror = () => fail(tx.error ?? new Error("Atomic wallet blobs transaction error"));
      } catch (err) {
        fail(err);
      }
    });
  }

  async writeVaultAtomic(
    meta: EncryptedVaultMetaRecord,
    blobs: readonly EncryptedWalletBlobRecord[]
  ): Promise<void> {
    const db = await openDb();
    const committedRevs = new Map<string, number>();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // Best-effort handle cleanup
        }
        reject(err instanceof Error ? err : new Error("Atomic vault write failed"));
      };

      try {
        const tx = openStrictTx(db, [STORE_BLOBS, STORE_META], "readwrite");
        const blobStore = tx.objectStore(STORE_BLOBS);
        const metaStore = tx.objectStore(STORE_META);

        const metaTrackKey = `meta:${meta.id}`;
        const metaReq = metaStore.get(meta.id);
        metaReq.onsuccess = () => {
          if (settled) return;
          try {
            const nextMetaRev = this.assertAndComputeNextRevision(metaTrackKey, metaReq.result);
            committedRevs.set(metaTrackKey, nextMetaRev);
            metaStore.put({ ...meta, revision: nextMetaRev });
          } catch (err) {
            try {
              tx.abort();
            } catch {
              // Ignore abort errors
            }
            fail(err);
          }
        };
        metaReq.onerror = () => fail(metaReq.error ?? new Error("IndexedDB meta read failed"));

        for (const blob of blobs) {
          const trackKey = `blob:${blob.key}`;
          const blobReq = blobStore.get(blob.key);
          blobReq.onsuccess = () => {
            if (settled) return;
            try {
              const nextRev = this.assertAndComputeNextRevision(trackKey, blobReq.result);
              committedRevs.set(trackKey, nextRev);
              blobStore.put({ ...blob, revision: nextRev });
            } catch (err) {
              try {
                tx.abort();
              } catch {
                // Ignore abort errors
              }
              fail(err);
            }
          };
          blobReq.onerror = () => fail(blobReq.error ?? new Error("IndexedDB blob read failed"));
        }

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          db.close();
          for (const [k, rev] of committedRevs) {
            this.knownRevisions.set(k, rev);
          }
          resolve();
        };
        tx.onabort = () => fail(tx.error ?? new Error("Atomic vault transaction aborted"));
        tx.onerror = () => fail(tx.error ?? new Error("Atomic vault transaction error"));
      } catch (err) {
        fail(err);
      }
    });
  }

  async deleteWalletBlobs(walletId: string): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // Best-effort handle cleanup
        }
        reject(err instanceof Error ? err : new Error("Delete wallet blobs failed"));
      };

      try {
        const tx = openStrictTx(db, STORE_BLOBS, "readwrite");
        const store = tx.objectStore(STORE_BLOBS);
        store.delete(`${walletId}:keys`);
        store.delete(`${walletId}:cache`);
        store.delete(`${walletId}:relay`);

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          db.close();
          this.knownRevisions.delete(`blob:${walletId}:keys`);
          this.knownRevisions.delete(`blob:${walletId}:cache`);
          this.knownRevisions.delete(`blob:${walletId}:relay`);
          resolve();
        };
        tx.onabort = () => fail(tx.error ?? new Error("Delete blobs transaction aborted"));
        tx.onerror = () => fail(tx.error ?? new Error("Delete blobs transaction error"));
      } catch (err) {
        fail(err);
      }
    });
  }

  async clearAll(): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // Best-effort handle cleanup
        }
        reject(err instanceof Error ? err : new Error("Clear vault failed"));
      };

      try {
        const tx = openStrictTx(db, [STORE_META, STORE_BLOBS], "readwrite");
        tx.objectStore(STORE_META).clear();
        tx.objectStore(STORE_BLOBS).clear();

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          db.close();
          this.knownRevisions.clear();
          resolve();
        };
        tx.onabort = () => fail(tx.error ?? new Error("Clear vault transaction aborted"));
        tx.onerror = () => fail(tx.error ?? new Error("Clear vault transaction error"));
      } catch (err) {
        fail(err);
      }
    });
  }
}
