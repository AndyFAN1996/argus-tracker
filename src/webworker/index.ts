// Do strong type WebWorker as soon as it is possible:
// https://github.com/microsoft/TypeScript/issues/14877
// At the moment "webworker" lib conflicts with  jest-environment-jsdom that uses "dom" lib
import { Type as MType } from '../common/messages.gen.js'
import { FromWorkerData } from '../common/interaction.js'

import QueueSender from './QueueSender.js'
import BatchWriter from './BatchWriter.js'

declare function postMessage(message: FromWorkerData, transfer?: any[]): void

enum WorkerStatus {
  NotActive,
  Starting,
  Stopping,
  Active,
  Stopped,
}

const AUTO_SEND_INTERVAL = 60 * 1000
const KEEPALIVE_SAFE_RANGE = Math.floor((64 << 10) * 0.8)
const DEFAULT_BATCH_SIZE = 1_000_000
const DEFAULT_WEAK_NETWORK_BATCH_SIZE = 200_000

let sender: QueueSender | null = null
let writer: BatchWriter | null = null
let pressureLevel = 0
let normalBatchSize = DEFAULT_BATCH_SIZE
let weakNetworkBatchSize = DEFAULT_WEAK_NETWORK_BATCH_SIZE
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let workerStatus: WorkerStatus = WorkerStatus.NotActive

function finalize(skipCompression?: boolean): void {
  if (!writer) {
    return
  }
  writer.finaliseBatch(skipCompression) // TODO: force sendAll?
}

function resetWriter(): void {
  if (writer) {
    writer.clean()
    // we don't need to wait for anything here since its sync
    writer = null
  }
}

function resetSender(): void {
  if (sender) {
    sender.clean()
    // allowing some time to send last batch
    setTimeout(() => {
      sender = null
    }, 20)
  }
}

function reset(): Promise<any> {
  return new Promise((res) => {
    workerStatus = WorkerStatus.Stopping
    if (sendIntervalID !== null) {
      clearInterval(sendIntervalID)
      sendIntervalID = null
    }
    resetWriter()
    resetSender()
    setTimeout(() => {
      workerStatus = WorkerStatus.NotActive
      res(null)
    }, 100)
  })
}

function initiateRestart(): void {
  if ([WorkerStatus.Stopped, WorkerStatus.Stopping].includes(workerStatus)) return
  postMessage('a_stop')
  // eslint-disable-next-line
  reset().then(() => {
    postMessage('a_start')
  })
}

function initiateFailure(reason: string): void {
  postMessage({ type: 'failure', reason })
  void reset()
}

let sendIntervalID: ReturnType<typeof setInterval> | null = null
let restartTimeoutID: ReturnType<typeof setTimeout>

// @ts-ignore
self.onmessage = ({ data }: { data: ToWorkerData }): any => {
  if (data === 'stop') {
    finalize()
    // eslint-disable-next-line
    reset().then(() => {
      workerStatus = WorkerStatus.Stopped
    })
    return
  }
  if (data === 'forceFlushBatch') {
    finalize()
    return
  }
  if (data === 'closing') {
    finalize(true)
    return
  }
  if (Array.isArray(data)) {
    if (pressureLevel >= 95) return
    if (writer) {
      const w = writer
      data.forEach((message) => {
        if (message[0] === MType.SetPageVisibility) {
          if (message[1]) {
            // .hidden
            restartTimeoutID = setTimeout(() => initiateRestart(), 30 * 60 * 1000)
          } else {
            clearTimeout(restartTimeoutID)
          }
        }
        w.writeMessage(message)
      })
    } else {
      postMessage('not_init')
      initiateRestart()
    }
    return
  }

  if (data.type === 'compressed') {
    if (!sender) {
      console.debug('OR WebWorker: sender not initialised. Compressed batch.')
      initiateRestart()
      return
    }
    data.batch && sender.sendCompressed(data.batch, data.batchNum)
  }
  if (data.type === 'uncompressed') {
    if (!sender) {
      console.debug('OR WebWorker: sender not initialised. Uncompressed batch.')
      initiateRestart()
      return
    }
    data.batch && sender.sendUncompressed(data.batch, data.batchNum)
  }

  if (data.type === 'start') {
    workerStatus = WorkerStatus.Starting
    sender = new QueueSender(
      data.ingestPoint,
      () => {
        // onUnauthorised
        initiateRestart()
      },
      (reason) => {
        // onFailure
        initiateFailure(reason)
      },
      data.connAttemptCount,
      data.connAttemptGap,
      (batch, batchNum) => {
        postMessage({ type: 'compress', batch, batchNum }, [batch.buffer])
      },
      data.pageNo,
      (weak) => writer?.setBatchSize(weak ? weakNetworkBatchSize : normalBatchSize),
      (level) => {
        pressureLevel = level
        if (level >= 70) finalize()
      },
    )
    writer = new BatchWriter(
      data.pageNo,
      data.timestamp,
      data.url,
      (batch, skipCompression) => {
        if (!sender) return;
        sender.push(batch, skipCompression)
      },
      data.tabId,
      () => postMessage({ type: 'queue_empty' }),
    )
    if (sendIntervalID === null) {
      sendIntervalID = setInterval(finalize, AUTO_SEND_INTERVAL)
    }
    return (workerStatus = WorkerStatus.Active)
  }

  if (data.type === 'auth') {
    if (!sender) {
      console.debug('OR WebWorker: sender not initialised. Received auth.')
      initiateRestart()
      return
    }

    if (!writer) {
      console.debug('OR WebWorker: writer not initialised. Received auth.')
      initiateRestart()
      return
    }

    sender.authorise(data.token)
    data.beaconSizeLimit && writer.setBeaconSizeLimit(data.beaconSizeLimit)
    normalBatchSize = data.batchSize ?? DEFAULT_BATCH_SIZE
    weakNetworkBatchSize = data.weakNetworkBatchSize ?? DEFAULT_WEAK_NETWORK_BATCH_SIZE
    writer.setBatchSize(normalBatchSize)
    return
  }
}
