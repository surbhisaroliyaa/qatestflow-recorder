import { describe, it, expect } from 'vitest'
import { shouldKeepVideo, videoPath, VIDEO_DEFAULTS } from '../src/main/video'

// =====================================================================
// Run video — the retention policy.
//
// The recording itself is Chromium's job and the file writing is three lines;
// the part with rules in it is deciding WHICH runs keep their video, and that
// is the part easy to get subtly wrong in a way no manual test would catch.
//
// Both directions of wrong are expensive, and differently so:
//   · too generous — "on failure" quietly keeping every passing run fills a
//     disk with hundreds of megabytes of videos of nothing going wrong;
//   · too strict — throwing away the recording of the one failure someone
//     turned video on to chase, which is unrecoverable.
// =====================================================================
describe('which runs keep their video', () => {
  const pass = { ok: true }
  const fail = { ok: false }

  it('off keeps nothing, whatever happened', () => {
    expect(shouldKeepVideo('off', pass)).toBe(false)
    expect(shouldKeepVideo('off', fail)).toBe(false)
  })

  it('always keeps both outcomes', () => {
    expect(shouldKeepVideo('always', pass)).toBe(true)
    expect(shouldKeepVideo('always', fail)).toBe(true)
  })

  it('on-failure keeps the failure and DISCARDS the pass', () => {
    // The disk-filling direction. A passing run's video is a video of nothing
    // going wrong, and there will be hundreds of them.
    expect(shouldKeepVideo('failure', fail)).toBe(true)
    expect(shouldKeepVideo('failure', pass)).toBe(false)
  })

  it('an aborted run keeps nothing, even on "always"', () => {
    // Home pressed mid-pause: the run has no verdict, so there is nothing to
    // retain it FOR. The same rule the trace uses — one idea, one behaviour.
    expect(shouldKeepVideo('always', { ok: false, aborted: true })).toBe(false)
    expect(shouldKeepVideo('always', { ok: true, aborted: true })).toBe(false)
    expect(shouldKeepVideo('failure', { ok: false, aborted: true })).toBe(false)
  })
})

describe('where a video lives', () => {
  it('sits inside the run’s own trace folder', () => {
    // Not a second evidence folder with a second retention policy: a video
    // belongs to a run, so it is deleted by the same prune that deletes that
    // run's trace and can never outlive the thing it documents.
    expect(videoPath('/lib/_traces/trace-123').split(/[\\/]/).join('/')).toBe(
      '/lib/_traces/trace-123/run.webm'
    )
  })

  it('has a hard time limit, so a hung run cannot record forever', () => {
    // A run that hangs is exactly the kind someone turns video on to
    // investigate, and MediaRecorder buffers in RAM until it is told to stop.
    expect(VIDEO_DEFAULTS.maxMs).toBeGreaterThan(60_000)
    expect(VIDEO_DEFAULTS.maxMs).toBeLessThanOrEqual(15 * 60 * 1000)
  })

  it('records at a low frame rate on purpose', () => {
    // A test run is mostly a still page. The things being looked for — a flash,
    // a bounce, a shift — are visible at this rate, and the file stays small
    // enough to attach to a bug report.
    expect(VIDEO_DEFAULTS.fps).toBeGreaterThan(0)
    expect(VIDEO_DEFAULTS.fps).toBeLessThanOrEqual(15)
  })
})
