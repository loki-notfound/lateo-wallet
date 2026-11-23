import type { VaultBlobStore } from "@lateo-wallet/core/storage";
import type {
  EncryptedVaultMetaRecord,
  EncryptedWalletBlobRecord,
  WalletBlobKind
} from "@lateo-wallet/core/vault";

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

function runTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        };
      })
  );
}

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

  async deleteWalletBlobs(walletId: string): Promise<void> {
    await runTx(STORE_BLOBS, "readwrite", (s) => s.delete(`${walletId}:keys`));
    await runTx(STORE_BLOBS, "readwrite", (s) => s.delete(`${walletId}:cache`));
  }

  async clearAll(): Promise<void> {
    await runTx(STORE_META, "readwrite", (s) => s.clear());
    await runTx(STORE_BLOBS, "readwrite", (s) => s.clear());
  }
}
