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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
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
          db.close();
          reject(err instanceof Error ? err : new Error("IndexedDB transaction failed"));
        };

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
      })
  );
}

/**
 * Shared origin IndexedDB VaultBlobStore used by browser extension hosts,
 * the Web PWA, and desktop renderers. Always waits for `tx.oncomplete` with
 * `{ durability: "strict" }` and supports atomic multi-blob and vault writes.
 */
export class IndexedDbVaultStore implements VaultBlobStore {
  async readMeta(): Promise<EncryptedVaultMetaRecord | undefined> {
    return runTx<EncryptedVaultMetaRecord | undefined>(STORE_META, "readonly", (s) =>
      s.get("primary")
    );
  }

  async writeMeta(record: EncryptedVaultMetaRecord): Promise<void> {
    await runTx(STORE_META, "readwrite", (s) => s.put(record));
  }

  async readBlob(
    walletId: string,
    kind: WalletBlobKind
  ): Promise<EncryptedWalletBlobRecord | undefined> {
    return runTx<EncryptedWalletBlobRecord | undefined>(STORE_BLOBS, "readonly", (s) =>
      s.get(`${walletId}:${kind}`)
    );
  }

  async writeBlob(record: EncryptedWalletBlobRecord): Promise<void> {
    await runTx(STORE_BLOBS, "readwrite", (s) => s.put(record));
  }

  async writeBlobsAtomic(blobs: readonly EncryptedWalletBlobRecord[]): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        db.close();
        reject(err instanceof Error ? err : new Error("Atomic wallet blobs write failed"));
      };

      const tx = openStrictTx(db, STORE_BLOBS, "readwrite");
      const blobStore = tx.objectStore(STORE_BLOBS);
      for (const blob of blobs) {
        blobStore.put(blob);
      }

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve();
      };
      tx.onabort = () => fail(tx.error ?? new Error("Atomic wallet blobs transaction aborted"));
      tx.onerror = () => fail(tx.error ?? new Error("Atomic wallet blobs transaction error"));
    });
  }

  async writeVaultAtomic(
    meta: EncryptedVaultMetaRecord,
    blobs: readonly EncryptedWalletBlobRecord[]
  ): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        db.close();
        reject(err instanceof Error ? err : new Error("Atomic vault write failed"));
      };

      const tx = openStrictTx(db, [STORE_BLOBS, STORE_META], "readwrite");
      const blobStore = tx.objectStore(STORE_BLOBS);
      const metaStore = tx.objectStore(STORE_META);

      for (const blob of blobs) {
        blobStore.put(blob);
      }
      metaStore.put(meta);

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve();
      };
      tx.onabort = () => fail(tx.error ?? new Error("Atomic vault transaction aborted"));
      tx.onerror = () => fail(tx.error ?? new Error("Atomic vault transaction error"));
    });
  }

  async deleteWalletBlobs(walletId: string): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        db.close();
        reject(err instanceof Error ? err : new Error("Delete wallet blobs failed"));
      };

      const tx = openStrictTx(db, STORE_BLOBS, "readwrite");
      const store = tx.objectStore(STORE_BLOBS);
      store.delete(`${walletId}:keys`);
      store.delete(`${walletId}:cache`);
      store.delete(`${walletId}:relay`);

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve();
      };
      tx.onabort = () => fail(tx.error ?? new Error("Delete blobs transaction aborted"));
      tx.onerror = () => fail(tx.error ?? new Error("Delete blobs transaction error"));
    });
  }

  async clearAll(): Promise<void> {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        db.close();
        reject(err instanceof Error ? err : new Error("Clear vault failed"));
      };

      const tx = openStrictTx(db, [STORE_META, STORE_BLOBS], "readwrite");
      tx.objectStore(STORE_META).clear();
      tx.objectStore(STORE_BLOBS).clear();

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve();
      };
      tx.onabort = () => fail(tx.error ?? new Error("Clear vault transaction aborted"));
      tx.onerror = () => fail(tx.error ?? new Error("Clear vault transaction error"));
    });
  }
}
