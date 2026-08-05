import { describe, it, expect } from 'vitest'
import { buildFailureMarkScript, removeFailureMarkScript } from '../src/main/replay'

// The failure screenshot is the evidence a human reads first, and it kept
// arriving with no red banner on it — same test, banner on one run and not the
// next. It was diagnosed as an injection race and given a retry; that was wrong.
// The injection always succeeded. The script appended the banner and returned
// INSTANTLY, and the capture that followed sometimes beat the paint.
//
// So the script now resolves only after two animation frames and reports whether
// the banner is really in the DOM. These tests run the generated script against
// hand-rolled stubs — no jsdom dependency — and pin that behaviour.

interface FakeNode {
  id: string
  textContent: string
  style: { cssText: string }
}

/** Minimal document + rAF, with manual control over when frames fire. */
function makeEnv(opts: { rafFires?: boolean } = {}) {
  const { rafFires = true } = opts
  const nodes: FakeNode[] = []
  const pending: (() => void)[] = []
  const doc = {
    body: {
      appendChild: (n: FakeNode) => {
        nodes.push(n)
      }
    },
    createElement: (): FakeNode => ({ id: '', textContent: '', style: { cssText: '' } }),
    getElementById: (id: string) => nodes.find((n) => n.id === id) ?? null
  }
  const raf = (cb: () => void): void => {
    if (rafFires) pending.push(cb)
  }
  const timers: { fn: () => void; ms: number }[] = []
  const setTimeoutStub = (fn: () => void, ms: number): number => {
    timers.push({ fn, ms })
    return timers.length
  }
  const clearTimeoutStub = (): void => {}
  const flushFrames = (): void => {
    // Two rounds: the script schedules a second rAF from inside the first.
    for (let round = 0; round < 2; round++) {
      const due = pending.splice(0, pending.length)
      due.forEach((f) => f())
    }
  }
  const fireTimers = (): void => timers.splice(0, timers.length).forEach((t) => t.fn())
  return { doc, raf, setTimeoutStub, clearTimeoutStub, flushFrames, fireTimers, nodes, timers }
}

const run = (script: string, env: ReturnType<typeof makeEnv>): Promise<unknown> =>
  new Function(
    'document',
    'requestAnimationFrame',
    'setTimeout',
    'clearTimeout',
    `return ${script}`
  )(env.doc, env.raf, env.setTimeoutStub, env.clearTimeoutStub) as Promise<unknown>

const step = { type: 'a11y', value: 'serious' } as never

describe('buildFailureMarkScript', () => {
  it('adds the banner with the error text', async () => {
    const env = makeEnv()
    const p = run(buildFailureMarkScript(step, 'Accessibility: 1 rule'), env)
    env.flushFrames()
    await p
    const banner = env.nodes.find((n) => n.id === '__qaflow_fail_banner')
    expect(banner).toBeDefined()
    expect(banner!.textContent).toContain('Accessibility: 1 rule')
    expect(banner!.textContent.startsWith('✗')).toBe(true)
  })

  it('does NOT resolve before a frame has been painted', async () => {
    // The whole bug: the old script resolved immediately, so the caller captured
    // a page whose banner had not been composited yet.
    const env = makeEnv()
    let settled = false
    const p = run(buildFailureMarkScript(step, 'boom'), env).then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled, 'resolved before any animation frame fired').toBe(false)
    env.flushFrames()
    await p
    expect(settled).toBe(true)
  })

  it('reports painted:true once the banner is in the DOM', async () => {
    const env = makeEnv()
    const p = run(buildFailureMarkScript(step, 'boom'), env)
    env.flushFrames()
    expect(await p).toMatchObject({ ok: true, painted: true })
  })

  it('reports painted:FALSE when the banner could not be added at all', async () => {
    // The script guards on `document.body`, which is genuinely absent mid-
    // navigation. `painted` has to be a real check of the DOM — if it just
    // returned true, the caller would skip its retry and save a bannerless
    // screenshot while believing it had annotated one. Found by mutation
    // testing: hardcoding painted:true broke no other test in this file.
    const env = makeEnv()
    ;(env.doc as { body: unknown }).body = null
    const p = run(buildFailureMarkScript(step, 'boom'), env)
    env.flushFrames()
    expect(await p).toMatchObject({ painted: false })
  })

  it('still resolves when rAF never fires, via the timeout', async () => {
    // rAF does not fire on a hidden or occluded window. A decoration must never
    // hang a run, so the timeout is load-bearing, not belt-and-braces.
    const env = makeEnv({ rafFires: false })
    const p = run(buildFailureMarkScript(step, 'boom'), env)
    expect(env.timers.length, 'no fallback timer was scheduled').toBe(1)
    expect(env.timers[0].ms).toBeLessThanOrEqual(1000)
    env.fireTimers()
    // …and it reports painted:FALSE, because nothing was composited. Saying
    // painted:true here is what let a bannerless screenshot be saved silently.
    expect(await p).toMatchObject({ ok: true, framed: false, painted: false })
  })

  it('truncates a very long error so the banner stays readable', async () => {
    const env = makeEnv()
    const p = run(buildFailureMarkScript(step, 'x'.repeat(400)), env)
    env.flushFrames()
    await p
    const banner = env.nodes.find((n) => n.id === '__qaflow_fail_banner')!
    expect(banner.textContent.length).toBeLessThan(200)
  })
})

describe('removeFailureMarkScript', () => {
  it('removes both the banner and the culprit outline', () => {
    // The marks live only inside the PNG — leaving them on the live page would
    // corrupt every screenshot taken afterwards.
    const src = removeFailureMarkScript()
    expect(src).toContain('__qaflow_fail_banner')
    expect(src).toContain('__qaflow_fail_box')
  })
})
