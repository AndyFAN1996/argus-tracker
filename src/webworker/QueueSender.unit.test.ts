import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import QueueSender from './QueueSender.js'

global.fetch = () => Promise.resolve(new Response()) // jsdom does not have it

function mockFetch(status: number, headers?: Record<string, string>) {
  return jest.spyOn(global, 'fetch').mockImplementation((request) =>
    Promise.resolve({ status, headers, request } as unknown as Response & {
      request: RequestInfo
    }),
  )
}
const baseURL = 'MYBASEURL'
const sampleArray = new Uint8Array(1)
const gzipArray = new Uint8Array([0x1f, 0x8b, 0x08])
const randomToken = 'abc'

const requestMock = {
  body: sampleArray,
  headers: { 'X-Session-Token': 'Bearer abc' },
  keepalive: true,
  method: 'POST',
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

const gzipRequestMock = {
  ...requestMock,
  headers: { ...requestMock.headers, 'Content-Encoding': 'gzip' },
}

function defaultQueueSender({
  url = baseURL,
  onUnauthorised = () => {},
  onFailed = () => {},
  onCompress = undefined,
}: Record<string, any> = {}) {
  return new QueueSender(baseURL, onUnauthorised, onFailed, 10, 1000, onCompress)
}

describe('QueueSender', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  // Test fetch first parameter + authorization header to be present

  // authorise() / push()
  test('Does not call fetch if not authorised', () => {
    const queueSender = defaultQueueSender()
    const fetchMock = mockFetch(200)

    queueSender.push(sampleArray)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test('Calls fetch on push() if authorised', async () => {
    const queueSender = defaultQueueSender()
    const fetchMock = mockFetch(200)

    queueSender.authorise(randomToken)
    expect(fetchMock).toHaveBeenCalledTimes(0)
    queueSender.push(sampleArray)
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject(requestMock)
  })
  test('Sends compressed request if onCompress is provided and compressed batch is included', async () => {
    const queueSender = defaultQueueSender({ onCompress: () => true })
    const fetchMock = mockFetch(200)

    // @ts-ignore
    const spyOnCompress = jest.spyOn(queueSender, 'onCompress')
    queueSender.authorise(randomToken)
    queueSender.push(sampleArray)
    await flushAsync()
    expect(spyOnCompress).toHaveBeenCalledTimes(1)
    queueSender.sendCompressed(gzipArray, 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(spyOnCompress).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      ...gzipRequestMock,
      body: gzipArray,
    })
  })
  test('Does not mark a batch as gzip when its magic header is invalid', async () => {
    const queueSender = defaultQueueSender({ onCompress: () => true })
    const fetchMock = mockFetch(200)

    queueSender.authorise(randomToken)
    queueSender.push(sampleArray)
    await flushAsync()
    queueSender.sendCompressed(sampleArray, 1)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject(requestMock)
  })
  test('Calls fetch on authorisation if there was a push() call before', async () => {
    const queueSender = defaultQueueSender()
    const fetchMock = mockFetch(200)

    queueSender.push(sampleArray)
    queueSender.authorise(randomToken)
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('keeps only one ingest request in flight', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve }),
    ).mockResolvedValue({ status: 200, headers: new Headers() } as Response)
    const queueSender = defaultQueueSender()

    queueSender.authorise(randomToken)
    queueSender.push(sampleArray)
    queueSender.push(sampleArray)
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFirst?.({ status: 200, headers: new Headers() } as Response)
    await flushAsync()
    await flushAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // .clean()
  test("Doesn't call fetch on push() after clean()", () => {
    const queueSender = defaultQueueSender()
    const fetchMock = mockFetch(200)
    jest.useFakeTimers()
    queueSender.authorise(randomToken)
    queueSender.clean()
    jest.runAllTimers()
    queueSender.push(sampleArray)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  test("Doesn't call fetch on authorisation if there was push() & clean() calls before", () => {
    const queueSender = defaultQueueSender()
    const fetchMock = mockFetch(200)

    queueSender.push(sampleArray)
    queueSender.clean()
    queueSender.authorise(randomToken)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  //Test N sequential ToBeCalledTimes(N)
  //Test N sequential pushes with different timeouts to be sequential

  // onUnauthorised
  test('Calls onUnauthorized callback on 401', (done) => {
    const onUnauthorised = jest.fn()
    const queueSender = defaultQueueSender({
      onUnauthorised,
    })
    const fetchMock = mockFetch(401)
    queueSender.authorise(randomToken)
    queueSender.push(sampleArray)
    setTimeout(() => {
      // how to make test simpler and more explicit?
      expect(onUnauthorised).toHaveBeenCalled()
      done()
    }, 100)
  })
  //Test onFailure
  //Test attempts timeout/ attempts count (toBeCalledTimes on one batch)
})
