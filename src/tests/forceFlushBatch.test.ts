import { describe, expect, jest, test } from '@jest/globals'
import App from '../main/app/index.js'
import { CustomEvent, TabData, Timestamp } from '../main/app/messages.gen.js'

describe('forceFlushBatch', () => {
  test('posts pending Renderer messages before flushing the worker batch', () => {
    const postMessage = jest.fn()
    const eventMessage = CustomEvent('feedback', '{}')
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      worker: { postMessage },
      messages: [eventMessage],
      commitCallbacks: [],
      session: { getTabId: () => 'tab-1' },
      timestamp: () => 1234,
    })

    app.forceFlushBatch()

    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage.mock.calls[0]?.[0]).toEqual([
      Timestamp(1234),
      TabData('tab-1'),
      eventMessage,
    ])
    expect(postMessage.mock.calls[1]?.[0]).toBe('forceFlushBatch')
    expect(app.messages).toEqual([])
  })

  test('still flushes the worker when there are no pending Renderer messages', () => {
    const postMessage = jest.fn()
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      worker: { postMessage },
      messages: [],
      commitCallbacks: [],
      session: { getTabId: () => 'tab-1' },
      timestamp: () => 1234,
    })

    app.forceFlushBatch()

    expect(postMessage).toHaveBeenCalledWith('forceFlushBatch')
  })

  test.each([
    ['socket mode', { socketMode: true, insideIframe: false }],
    ['iframe mode', { socketMode: false, insideIframe: true }],
  ])('does not reroute pending messages in %s', (_name, mode) => {
    const postMessage = jest.fn()
    const eventMessage = CustomEvent('feedback', '{}')
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      worker: { postMessage },
      messages: [eventMessage],
      commitCallbacks: [],
      session: { getTabId: () => 'tab-1' },
      timestamp: () => 1234,
      ...mode,
    })

    app.forceFlushBatch()

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith('forceFlushBatch')
    expect(app.messages).toEqual([eventMessage])
  })
})
