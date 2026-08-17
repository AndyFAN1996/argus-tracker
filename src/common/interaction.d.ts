import Message from './messages.gen.js'
export interface Options {
  connAttemptCount?: number
  connAttemptGap?: number
}
type Start = {
  type: 'start'
  ingestPoint: string
  pageNo: number
  timestamp: number
  url: string
  tabId: string
} & Options
type Auth = {
  type: 'auth'
  token: string
  beaconSizeLimit?: number
  batchSize?: number
  weakNetworkBatchSize?: number
}
export type ToWorkerData =
  | null
  | 'stop'
  | Start
  | Auth
  | Array<Message>
  | {
      type: 'compressed'
      batch: Uint8Array
      batchNum: number
    }
  | {
      type: 'uncompressed'
      batch: Uint8Array
      batchNum: number
    }
  | 'closing'
  | 'forceFlushBatch'
  | 'check_queue'

type Failure = {
  type: 'failure'
  reason: string
}
type QEmpty = {
  type: 'queue_empty'
}
export type FromWorkerData =
  | 'a_stop'
  | 'a_start'
  | Failure
  | 'not_init'
  | {
      type: 'compress'
      batch: Uint8Array
      batchNum: number
    }
  | QEmpty
export {}
