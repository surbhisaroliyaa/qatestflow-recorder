import { describe, it, expect } from 'vitest'
import { resolveVideoMode } from '../src/shared/videoPolicy'

// The bug this function exists for: ⏺ on failure + 🎬 always + a passing run
// produced no video, because the .webm is written inside the trace folder and
// an on-failure trace policy creates no folder for a run that passed. The
// toolbar said "always" and meant "sometimes".
describe('resolveVideoMode', () => {
  it('resolves the unachievable pair to the nearest achievable one', () => {
    // THE case. 'always' cannot be honoured under an on-failure trace, so it
    // becomes a video on exactly the runs that keep a trace.
    expect(resolveVideoMode('failure', 'always')).toBe('failure')
  })

  it('gives no video when no trace is kept — there is nowhere to put one', () => {
    expect(resolveVideoMode('off', 'always')).toBe('off')
    expect(resolveVideoMode('off', 'failure')).toBe('off')
    expect(resolveVideoMode('off', 'off')).toBe('off')
  })

  it('leaves an achievable policy exactly as asked', () => {
    // An always-trace can host a video for every run, so nothing is resolved
    // away here. If this ever returned 'failure', video would be silently
    // downgraded for the people who explicitly asked to record everything.
    expect(resolveVideoMode('always', 'always')).toBe('always')
    expect(resolveVideoMode('always', 'failure')).toBe('failure')
    expect(resolveVideoMode('always', 'off')).toBe('off')
    // on-failure trace + on-failure video already agree: both keep the same runs.
    expect(resolveVideoMode('failure', 'failure')).toBe('failure')
    expect(resolveVideoMode('failure', 'off')).toBe('off')
  })

  it('never turns a video ON that the user did not ask for', () => {
    // The inverse failure: a resolver that "helpfully" upgraded 'off' would
    // record and store video for someone who explicitly declined it. Every
    // trace policy, one assertion — 'off' in must mean 'off' out.
    for (const trace of ['always', 'failure', 'off'] as const) {
      expect(resolveVideoMode(trace, 'off')).toBe('off')
    }
  })
})
