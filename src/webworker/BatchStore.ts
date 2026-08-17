export interface StoredBatch {
  key: string
  ingestURL: string
  token: string
  pageNo: number
  batchNum: number
  body: ArrayBuffer
  size: number
  createdAt: number
}

const DB_NAME = 'argus-tracker-upload-v1'
const STORE_NAME = 'batches'
const DB_VERSION = 1
const MAX_AGE = 24 * 60 * 60 * 1000

export default class BatchStore {
  public readonly available = typeof indexedDB !== 'undefined'
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.available) {
      return Promise.reject(new Error('IndexedDB unavailable'))
    }
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Failed to open upload store'))
    })
    return this.dbPromise
  }

  async put(batch: StoredBatch): Promise<void> {
    const db = await this.open()
    await this.request(db, 'readwrite', (store) => store.put(batch))
  }

  async get(key: string): Promise<StoredBatch | undefined> {
    const db = await this.open()
    return this.request(db, 'readonly', (store) => store.get(key))
  }

  async delete(key: string): Promise<void> {
    const db = await this.open()
    await this.request(db, 'readwrite', (store) => store.delete(key))
  }

  async list(ingestURL: string): Promise<StoredBatch[]> {
    const db = await this.open()
    const all = await this.request<StoredBatch[]>(db, 'readonly', (store) => store.getAll())
    const expiresBefore = Date.now() - MAX_AGE
    const active: StoredBatch[] = []
    await Promise.all(
      all.map(async (batch) => {
        if (batch.createdAt < expiresBefore) {
          await this.delete(batch.key)
        } else if (batch.ingestURL === ingestURL) {
          active.push(batch)
        }
      }),
    )
    return active.sort((a, b) => a.createdAt - b.createdAt || a.batchNum - b.batchNum)
  }

  private request<T = void>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode)
      const request = run(transaction.objectStore(STORE_NAME))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => reject(request.error ?? new Error('Upload store request failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Upload store aborted'))
    })
  }
}
