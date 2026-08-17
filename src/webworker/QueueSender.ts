import BatchStore, { StoredBatch } from './BatchStore.js'

const INGEST_PATH = '/v1/web/i'
const KEEPALIVE_SIZE_LIMIT = 64 << 10 // 64 kB
const MEMORY_QUEUE_LIMIT = 5 * 1024 * 1024
const STORAGE_QUEUE_LIMIT = 50 * 1024 * 1024
const SLOW_REQUEST_MS = 1500
const HEALTHY_REQUEST_MS = 800
const MAX_PACING_MS = 10_000

type PressureLevel = 0 | 70 | 85 | 95

interface QueueItem {
  key: string
  batch?: Uint8Array
  size: number
  batchNum: number
  pageNo: number
  token: string
  createdAt: number
  persisted: boolean
  persisting?: Promise<void>
  retries: number
  skipCompression: boolean
}

export default class QueueSender {
  private busy = false
  private stopped = false
  private restoring = false
  private readonly queue: QueueItem[] = []
  private current: QueueItem | null = null
  private readonly ingestURL: string
  private token: string | null = null
  private lastBatchNum = 0
  private totalQueueBytes = 0
  private pressureLevel: PressureLevel = 0
  private weakNetwork = false
  private consecutiveFailures = 0
  private healthyResponses = 0
  private readonly store = new BatchStore()

  constructor(
    ingestBaseURL: string,
    private readonly onUnauthorised: () => any,
    private readonly onFailure: (reason: string) => any,
    private readonly MAX_ATTEMPTS_COUNT = 6,
    private readonly ATTEMPT_TIMEOUT = 1000,
    private readonly onCompress?: (batch: Uint8Array, batchNum: number) => any,
    private readonly pageNo = 0,
    private readonly onNetworkMode?: (weak: boolean) => void,
    private readonly onPressure?: (level: PressureLevel) => void,
  ) {
    this.ingestURL = ingestBaseURL + INGEST_PATH
  }

  public getQueueStatus() {
    return this.queue.length === 0 && !this.busy && !this.restoring
  }

  authorise(token: string): void {
    this.token = token
    this.queue.forEach((item) => {
      if (!item.token) item.token = token
      void this.ensurePersisted(item).catch(() => undefined)
    })
    if (!this.store.available) {
      this.drain()
      return
    }

    this.restoring = true
    void this.store
      .list(this.ingestURL)
      .then((stored) => this.restore(stored))
      .catch(() => undefined)
      .finally(() => {
        this.restoring = false
        this.drain()
      })
  }

  push(batch: Uint8Array, skipCompression = false): void {
    const batchNum = ++this.lastBatchNum
    const createdAt = Date.now()
    const item: QueueItem = {
      key: `${this.ingestURL}:${this.pageNo}:${batchNum}:${createdAt}`,
      batch,
      size: batch.byteLength,
      batchNum,
      pageNo: this.pageNo,
      token: this.token ?? '',
      createdAt,
      persisted: false,
      retries: 0,
      skipCompression,
    }
    this.queue.push(item)
    this.totalQueueBytes += item.size
    this.updatePressure()
    if (item.token) void this.ensurePersisted(item).catch(() => undefined)
    this.drain()
  }

  private restore(stored: StoredBatch[]) {
    const known = new Set(this.queue.map((item) => item.key))
    const recovered: QueueItem[] = []
    stored.forEach((batch) => {
      if (known.has(batch.key)) return
      recovered.push({
        key: batch.key,
        batch: new Uint8Array(batch.body),
        size: batch.size,
        batchNum: batch.batchNum,
        pageNo: batch.pageNo,
        token: batch.token,
        createdAt: batch.createdAt,
        persisted: true,
        retries: 0,
        skipCompression: false,
      })
      if (batch.pageNo === this.pageNo) {
        this.lastBatchNum = Math.max(this.lastBatchNum, batch.batchNum)
      }
    })
    if (recovered.length > 0) {
      this.queue.unshift(...recovered)
      this.totalQueueBytes += recovered.reduce((sum, item) => sum + item.size, 0)
      this.updatePressure()
      this.spillMemory()
    }
  }

  private drain() {
    if (this.busy || this.restoring || this.stopped || !this.token) return
    const item = this.queue.shift()
    if (!item) return
    if (!item.token) item.token = this.token
    this.busy = true
    this.current = item

    const prepare = this.ensurePersisted(item)
      .catch(() => undefined)
      .then(() => this.loadBody(item))

    void prepare
      .then((body) => {
        if (!body || this.current !== item || this.stopped) return
        if (!item.skipCompression && this.onCompress) {
          this.onCompress(body, item.batchNum)
          item.batch = undefined
        } else {
          this.sendBatch(body, false, item)
        }
      })
      .catch((error: Error) => this.failCurrent(`Failed to load queued batch: ${error.message}`))
  }

  private ensurePersisted(item: QueueItem): Promise<void> {
    if (item.persisted || !this.store.available || !item.batch) return Promise.resolve()
    if (item.persisting) return item.persisting

    const batch = item.batch
    const persisting = this.store
      .put({
        key: item.key,
        ingestURL: this.ingestURL,
        token: item.token,
        pageNo: item.pageNo,
        batchNum: item.batchNum,
        body: batch.buffer.slice(batch.byteOffset, batch.byteOffset + batch.byteLength) as ArrayBuffer,
        size: item.size,
        createdAt: item.createdAt,
      })
      .then(() => {
        item.persisted = true
        this.spillMemory()
      })
      .finally(() => {
        item.persisting = undefined
      })
    item.persisting = persisting
    return persisting
  }

  private async loadBody(item: QueueItem): Promise<Uint8Array | undefined> {
    if (item.batch) return item.batch
    if (!item.persisted || !this.store.available) return undefined
    const stored = await this.store.get(item.key)
    return stored ? new Uint8Array(stored.body) : undefined
  }

  private spillMemory() {
    let memoryBytes = (this.current?.batch?.byteLength ?? 0) +
      this.queue.reduce((sum, item) => sum + (item.batch?.byteLength ?? 0), 0)
    for (let i = this.queue.length - 1; i >= 0 && memoryBytes > MEMORY_QUEUE_LIMIT; i--) {
      const item = this.queue[i]
      if (item.persisted && item.batch) {
        memoryBytes -= item.batch.byteLength
        item.batch = undefined
      }
    }
  }

  private retry(batch: Uint8Array, isCompressed: boolean, item: QueueItem, retryAfterMs = 0) {
    item.retries++
    this.consecutiveFailures++
    this.healthyResponses = 0
    if (this.consecutiveFailures >= 2) this.setWeakNetwork(true)
    if (item.retries > this.MAX_ATTEMPTS_COUNT) {
      this.failCurrent(`Failed to send batch after ${this.MAX_ATTEMPTS_COUNT} retries.`)
      return
    }
    const exponential = Math.min(30_000, this.ATTEMPT_TIMEOUT * 2 ** (item.retries - 1))
    const delay = Math.max(retryAfterMs, exponential)
    setTimeout(() => {
      if (this.current === item && !this.stopped) this.sendBatch(batch, isCompressed, item)
    }, delay)
  }

  private sendBatch(batch: Uint8Array, isCompressed: boolean, item: QueueItem): void {
    const headers = {
      'X-Session-Token': `Bearer ${item.token}`,
    } as Record<string, string>
    if (isCompressed) headers['Content-Encoding'] = 'gzip'

    const startedAt = Date.now()
    fetch(`${this.ingestURL}?batch=${item.pageNo}_${item.batchNum}`, {
      // @ts-ignore
      body: batch,
      method: 'POST',
      headers,
      keepalive: batch.length < KEEPALIVE_SIZE_LIMIT,
    })
      .then((response: Response) => {
        const duration = Date.now() - startedAt
        if (response.status === 401) {
          this.busy = false
          this.onUnauthorised()
          return
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          this.retry(batch, isCompressed, item, this.retryAfter(response))
          return
        }
        if (response.status >= 400) {
          this.failCurrent(`Ingest rejected batch with HTTP ${response.status}.`)
          return
        }
        this.completeCurrent(duration)
      })
      .catch((error: Error) => {
        console.warn('OpenReplay:', error)
        this.retry(batch, isCompressed, item)
      })
  }

  private retryAfter(response: Response): number {
    const value = response.headers?.get('Retry-After')
    if (!value) return 0
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(value)
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now())
  }

  private completeCurrent(duration: number) {
    const item = this.current
    if (!item) return
    this.consecutiveFailures = 0
    if (duration > SLOW_REQUEST_MS) {
      this.healthyResponses = 0
      this.setWeakNetwork(true)
    } else if (duration < HEALTHY_REQUEST_MS) {
      this.healthyResponses++
      if (this.healthyResponses >= 3) this.setWeakNetwork(false)
    }

    this.totalQueueBytes = Math.max(0, this.totalQueueBytes - item.size)
    this.current = null
    this.busy = false
    this.updatePressure()
    if (item.persisted && this.store.available) void this.store.delete(item.key).catch(() => undefined)

    const pacedDelay = this.weakNetwork && this.pressureLevel < 70
      ? Math.min(MAX_PACING_MS, Math.max(2000, duration))
      : 0
    setTimeout(() => this.drain(), pacedDelay)
  }

  private failCurrent(reason: string) {
    this.busy = false
    this.stopped = true
    this.onFailure(reason)
  }

  private setWeakNetwork(weak: boolean) {
    if (this.weakNetwork === weak) return
    this.weakNetwork = weak
    this.onNetworkMode?.(weak)
  }

  private updatePressure() {
    const ratio = this.totalQueueBytes / STORAGE_QUEUE_LIMIT
    if (this.pressureLevel === 95 && ratio >= 0.5) return
    const next: PressureLevel = ratio >= 0.95 ? 95 : ratio >= 0.85 ? 85 : ratio >= 0.7 ? 70 : 0
    if (next === this.pressureLevel) return
    this.pressureLevel = next
    this.onPressure?.(next)
  }

  sendCompressed(batch: Uint8Array, batchNum: number) {
    if (this.current?.batchNum !== batchNum) return
    const hasGzipMagic = batch[0] === 0x1f && batch[1] === 0x8b
    this.sendBatch(batch, hasGzipMagic, this.current)
  }

  sendUncompressed(batch: Uint8Array, batchNum: number) {
    if (this.current?.batchNum === batchNum) this.sendBatch(batch, false, this.current)
  }

  clean() {
    this.stopped = true
    this.token = null
  }
}
