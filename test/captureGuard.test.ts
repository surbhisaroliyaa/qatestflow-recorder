import { describe, it, expect } from 'vitest'
import { capturePageWithin, type CapturedImage } from '../src/main/captureGuard'

// The bug this function exists for (2026-09-23, Round 13 step 6): a replayed
// step failed, the red failure banner was painted into the page, and
// `await currentWC.capturePage()` on the very next line never came back. No
// screenshot, no trace folder, the banner never erased, and the recovery panel
// — sent seventy lines further down — never offered. One failed step killed the
// whole run with no way out.
//
// What makes it worth its own module: a `try/catch` cannot catch this. A promise
// that never settles never throws. So the tests below are mostly about the ONE
// case a normal test never covers — a promise that simply does not finish.

const fakeImage = (): CapturedImage => ({
  toPNG: () => Buffer.from('png'),
  resize: () => fakeImage()
})

describe('capturePageWithin', () => {
  it('returns the image when the capture finishes in time', async () => {
    const img = fakeImage()
    const wc = { capturePage: async (): Promise<CapturedImage> => img }
    expect(await capturePageWithin(wc, 1000)).toBe(img)
  })

  // THE case. A capture that never settles must not take the run with it.
  // `sleep` is injected so this proves the guarantee instantly rather than
  // sitting on a real timer — the deadline is the contract, not the duration.
  it('gives up on a capture that never finishes', async () => {
    let settled = false
    const wc = {
      capturePage: () =>
        new Promise<CapturedImage>(() => {
          // deliberately never resolves — this is the 2026-09-23 hang
        })
    }
    const result = await capturePageWithin(wc, 3000, async () => {
      settled = true
    })
    expect(result).toBeNull()
    expect(settled).toBe(true) // it was the DEADLINE that won, not the capture
  })

  // "The page is gone" and "the page never painted" lead the caller to the same
  // decision: carry on without a picture. One code path, so one return value.
  it('returns null when the capture throws', async () => {
    const wc = {
      capturePage: async (): Promise<CapturedImage> => {
        throw new Error('Object has been destroyed')
      }
    }
    expect(await capturePageWithin(wc, 1000)).toBeNull()
  })

  // A capture that wins the race still wins it when a deadline exists — the
  // guard must not turn a slow-but-fine capture into a miss.
  it('prefers a real capture over a deadline that has not expired', async () => {
    const img = fakeImage()
    const wc = {
      capturePage: (): Promise<CapturedImage> => new Promise((r) => setTimeout(() => r(img), 5))
    }
    expect(await capturePageWithin(wc, 2000)).toBe(img)
  })
})
