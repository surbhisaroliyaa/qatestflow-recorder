import { describe, it, expect } from 'vitest'
import { createHarRecorder, type WebContentsLike } from '../src/main/harCapture'

// =====================================================================
// The stateful half of F1 network capture, lifted out of index.ts's
// createWindow closure.
//
// It was 135 lines of CDP plumbing tangled up with everything else in the
// main process, and completely unreachable by a test. It now takes a
// STRUCTURAL type — anything with a debugger that can attach, send and
// listen — which is what lets these tests drive it with a fake instead of
// a real browser.
//
// That is the point of the extraction: not that index.ts is 133 lines
// shorter, but that this can now be proven.
// =====================================================================

/** A fake CDP debugger: records what was asked of it, and lets tests emit events. */
function fakeWc(bodies: Record<string, { body?: string; base64Encoded?: boolean }> = {}): {
  wc: WebContentsLike
  emit: (method: string, params: Record<string, unknown>) => void
  sent: string[]
  attached: () => boolean
  listeners: number
} {
  let attached = false
  let listener: ((e: unknown, m: string, p: Record<string, unknown>) => void) | null = null
  const sent: string[] = []
  const state = { listeners: 0 }
  const wc: WebContentsLike = {
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
      },
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        sent.push(method)
        if (method === 'Network.getResponseBody') {
          return bodies[String(params?.requestId)] ?? { body: '', base64Encoded: false }
        }
        return {}
      },
      on: (_e, cb) => {
        listener = cb
        state.listeners++
      },
      removeListener: () => {
        listener = null
        state.listeners--
      }
    }
  }
  return {
    wc,
    emit: (method, params) => listener?.(null, method, params),
    sent,
    attached: () => attached,
    get listeners() {
      return state.listeners
    }
  }
}

/** Drive one complete request through the recorder. */
async function record(
  emit: (m: string, p: Record<string, unknown>) => void,
  id: string,
  o: { url?: string; method?: string; status?: number; type?: string } = {}
): Promise<void> {
  emit('Network.requestWillBeSent', {
    requestId: id,
    request: { method: o.method ?? 'GET', url: o.url ?? 'https://shop.test/api/items' }
  })
  emit('Network.responseReceived', {
    requestId: id,
    type: o.type ?? 'XHR',
    response: { status: o.status ?? 200, mimeType: 'application/json', headers: {} }
  })
  emit('Network.loadingFinished', { requestId: id })
  // the body is fetched asynchronously before the entry is appended
  await new Promise((r) => setTimeout(r, 0))
}

describe('the capture toggle is separate from a capture running', () => {
  it('starts off, and remembers what the user chose', () => {
    const har = createHarRecorder()
    expect(har.isEnabled()).toBe(false)
    har.setEnabled(true)
    expect(har.isEnabled()).toBe(true)
    // Enabling does not start anything — the next RECORDING does.
    expect(har.isCapturing()).toBe(false)
  })

  it('reports capturing only between start and stop', async () => {
    const har = createHarRecorder()
    const f = fakeWc()
    expect(har.isCapturing()).toBe(false)
    await har.start(f.wc)
    expect(har.isCapturing()).toBe(true)
    har.stop()
    expect(har.isCapturing()).toBe(false)
  })
})

describe('attaching and detaching cleanly', () => {
  it('attaches the debugger and enables the network domain', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    expect(f.attached()).toBe(true)
    expect(f.sent).toContain('Network.enable')
  })

  it('detaches and removes its listener on stop', async () => {
    // A leaked listener keeps recording into a log nobody reads, and a leaked
    // attachment stops DevTools from opening on that tab.
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1')
    har.stop()
    expect(f.attached()).toBe(false)
    expect(f.listeners).toBe(0)
  })

  it('a second start while capturing is a no-op, not a second listener', async () => {
    // main can call start on several load events for one recording.
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await har.start(f.wc)
    expect(f.listeners).toBe(1)
  })

  it('stopping when nothing is running is harmless', () => {
    expect(createHarRecorder().stop()).toBe(0)
  })
})

describe('what ends up in the archive', () => {
  it('captures a request/response pair as one entry', async () => {
    const f = fakeWc({ '1': { body: '{"items":[]}' } })
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1', { url: 'https://shop.test/api/items' })
    const log = har.captured()
    expect(log?.log.entries).toHaveLength(1)
    expect(log?.log.entries[0].request.url).toBe('https://shop.test/api/items')
    expect(log?.log.entries[0].response.content.text).toBe('{"items":[]}')
  })

  it('captures the document and data calls, and skips the rest', async () => {
    // An archive of every image and font is enormous and mostly noise.
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1', { type: 'Document' })
    await record(f.emit, '2', { type: 'XHR' })
    await record(f.emit, '3', { type: 'Image' })
    await record(f.emit, '4', { type: 'Font' })
    expect(har.count()).toBe(2)
  })

  it('ignores a response whose request was never seen', async () => {
    // Requests already in flight when capture starts arrive half-formed.
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    f.emit('Network.responseReceived', {
      requestId: 'orphan',
      type: 'XHR',
      response: { status: 200 }
    })
    f.emit('Network.loadingFinished', { requestId: 'orphan' })
    await new Promise((r) => setTimeout(r, 0))
    expect(har.count()).toBe(0)
  })

  it('ignores a request that never finished', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    f.emit('Network.requestWillBeSent', {
      requestId: 'hanging',
      request: { method: 'GET', url: 'https://shop.test/slow' }
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(har.count()).toBe(0)
  })

  it('keeps a base64 body marked as base64', async () => {
    const f = fakeWc({ '1': { body: 'AAAA', base64Encoded: true } })
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1')
    expect(har.captured()?.log.entries[0].response.content.encoding).toBe('base64')
  })

  it('records the method, so a GET and a POST to one URL stay distinct', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1', { method: 'GET', url: 'https://shop.test/api/o' })
    await record(f.emit, '2', { method: 'POST', url: 'https://shop.test/api/o' })
    expect(har.captured()?.log.entries.map((e) => e.request.method)).toEqual(['GET', 'POST'])
  })
})

describe('what is offered to the Save panel afterwards', () => {
  it('reports how many entries were captured', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1')
    await record(f.emit, '2')
    expect(har.stop()).toBe(2)
    expect(har.count()).toBe(2)
  })

  it('offers NOTHING when a capture caught nothing', async () => {
    // An empty archive attached to a test would make replay serve zero
    // responses and every request fall through to the live network — a
    // "deterministic" run that quietly isn't.
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    expect(har.stop()).toBe(0)
    expect(har.captured()).toBeNull()
  })

  it('keeps the log after stopping, so it can still be banked', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1')
    har.stop()
    expect(har.captured()?.log.entries).toHaveLength(1)
  })

  it('reset clears the previous run before a new recording', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    await record(f.emit, '1')
    har.stop()
    har.reset()
    expect(har.captured()).toBeNull()
    expect(har.count()).toBe(0)
  })
})

describe('it never takes the app down with it', () => {
  it('gives up quietly when the debugger cannot attach', async () => {
    // DevTools already open on that tab is the common cause. Capture is
    // unavailable; recording itself must carry on.
    const wc: WebContentsLike = {
      debugger: {
        isAttached: () => false,
        attach: () => {
          throw new Error('Another debugger is already attached')
        },
        detach: () => {},
        sendCommand: async () => ({}),
        on: () => {},
        removeListener: () => {}
      }
    }
    const har = createHarRecorder()
    await expect(har.start(wc)).resolves.toBeUndefined()
    expect(har.isCapturing()).toBe(false)
  })

  it('survives a detach that throws', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    f.wc.debugger.detach = (): never => {
      throw new Error('already detached')
    }
    expect(() => har.stop()).not.toThrow()
  })

  it('ignores a malformed CDP event instead of throwing', async () => {
    const f = fakeWc()
    const har = createHarRecorder()
    await har.start(f.wc)
    expect(() => {
      f.emit('Network.requestWillBeSent', {})
      f.emit('Network.responseReceived', { requestId: 'x' })
      f.emit('Network.loadingFinished', {})
      f.emit('Something.Else', { requestId: '1' })
    }).not.toThrow()
  })
})
