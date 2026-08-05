import { describe, it, expect } from 'vitest'
import {
  mergeEnvValues,
  missingEnvMessage,
  missingEnvNames,
  runData,
  runFixturePaths,
  runSecretRefs
} from '../src/shared/runInputs'

// These are the decisions that used to be re-made, slightly differently, in
// every run path. Each test below corresponds to a real inconsistency between
// those paths — the point of the module is that there is now one answer.

describe('runSecretRefs', () => {
  it('collects refs in order and dedupes them', () => {
    expect(
      runSecretRefs([
        { type: 'type', secretRef: 'sec_a' },
        { type: 'type', secretRef: 'sec_b' },
        { type: 'type', secretRef: 'sec_a' }
      ])
    ).toEqual(['sec_a', 'sec_b'])
  })

  it('ignores steps with no ref', () => {
    // A path that forgot these typed an empty password, and all three
    // cross-browser engines timed out identically — looking like an engine fault.
    expect(runSecretRefs([{ type: 'click' }, { type: 'type', value: 'plain' }])).toEqual([])
  })

  it('ignores an empty-string ref rather than passing it on', () => {
    expect(runSecretRefs([{ type: 'type', secretRef: '' }])).toEqual([])
  })
})

describe('runFixturePaths', () => {
  it('collects one path per upload step', () => {
    expect(
      runFixturePaths([
        { type: 'upload', value: 'C:\\files\\a.png' },
        { type: 'click' },
        { type: 'upload', value: 'C:\\files\\b.pdf' }
      ])
    ).toEqual(['C:\\files\\a.png', 'C:\\files\\b.pdf'])
  })

  it('splits a multi-file upload step', () => {
    // One step can carry several files, newline-separated.
    expect(runFixturePaths([{ type: 'upload', value: 'a.png\nb.png\nc.png' }])).toEqual([
      'a.png',
      'b.png',
      'c.png'
    ])
  })

  it('dedupes the same file used twice', () => {
    expect(
      runFixturePaths([
        { type: 'upload', value: 'a.png' },
        { type: 'upload', value: 'a.png' }
      ])
    ).toEqual(['a.png'])
  })

  it('skips disabled uploads and blank lines', () => {
    expect(
      runFixturePaths([
        { type: 'upload', value: 'a.png', disabled: true },
        { type: 'upload', value: 'b.png\n\n  \n' }
      ])
    ).toEqual(['b.png'])
  })

  it('returns nothing when there are no uploads', () => {
    // Uploads never travelled into a parallel run, so every upload test died on
    // ENOENT — which the failure classifier then read as a stale selector.
    expect(runFixturePaths([{ type: 'click' }])).toEqual([])
  })
})

describe('runData', () => {
  const rows = [{ username: 'standard_user' }]

  it('returns the block when there are both columns and rows', () => {
    expect(runData(['username'], rows)).toEqual({ columns: ['username'], rows })
  })

  it('returns undefined when the table has no rows', () => {
    expect(runData(['username'], [])).toBeUndefined()
    expect(runData(['username'], undefined)).toBeUndefined()
  })

  it('returns undefined when the steps declare no columns', () => {
    expect(runData([], rows)).toBeUndefined()
  })

  it('is what stops a data-driven test running as a plain one', () => {
    // Omitting this block does not fail loudly — the generator emits an ordinary
    // test whose {{username}} stays literal text and gets typed into the form.
    // Cross-browser passed no data block at all.
    expect(runData(['username'], rows)).not.toBeUndefined()
  })
})

describe('missingEnvNames', () => {
  it('reports a name the resolver could not fill', () => {
    expect(
      missingEnvNames(['SAUCE_PW'], { values: { SAUCE_PW: '' }, unresolved: ['SAUCE_PW'] })
    ).toEqual(['SAUCE_PW'])
  })

  it('treats the resolver’s EMPTY STRING as missing, not as a value', () => {
    // The bug I shipped in the first version of this guard: `values[n] !== undefined`
    // is true for '', so the empty string was copied in, the variable was judged
    // present, and the guard never fired once. Emptiness is the test.
    const resolved = { values: { A: '', B: 'real' }, unresolved: ['A'] }
    expect(missingEnvNames(['A', 'B'], resolved)).toEqual(['A'])
  })

  it('does not report a name supplied out of band', () => {
    // A monitor's pinned environment always wins — the resolver only knows the
    // ACTIVE environment plus the process, so it cannot see the pin.
    expect(
      missingEnvNames(['SAUCE_PW'], { values: { SAUCE_PW: '' }, unresolved: ['SAUCE_PW'] }, {
        SAUCE_PW: 'secret_sauce'
      })
    ).toEqual([])
  })

  it('reports nothing when the run needs no variables', () => {
    expect(missingEnvNames([], { values: {}, unresolved: [] })).toEqual([])
  })

  it('ignores unresolved names the run does not actually need', () => {
    expect(missingEnvNames(['A'], { values: { A: 'x' }, unresolved: ['B'] })).toEqual([])
  })
})

describe('mergeEnvValues', () => {
  it('keeps the out-of-band value when both are present', () => {
    expect(mergeEnvValues({ PW: 'pinned' }, { PW: 'active' })).toEqual({ PW: 'pinned' })
  })

  it('fills in a value the caller did not supply', () => {
    expect(mergeEnvValues({}, { PW: 'active' })).toEqual({ PW: 'active' })
  })

  it('never lets an empty string overwrite or masquerade as a value', () => {
    expect(mergeEnvValues({ PW: 'pinned' }, { PW: '' })).toEqual({ PW: 'pinned' })
    expect(mergeEnvValues({}, { PW: '' })).toEqual({})
  })
})

describe('missingEnvMessage', () => {
  it('names the variables rather than describing the symptom', () => {
    const msg = missingEnvMessage(['SAUCE_PW'])
    expect(msg).toContain('{{env:SAUCE_PW}}')
    expect(msg).toContain('1 environment variable had no value')
  })

  it('pluralises', () => {
    expect(missingEnvMessage(['A', 'B'])).toContain('2 environment variables had no value')
  })

  it('says so when the pinned environment is the thing that is gone', () => {
    expect(missingEnvMessage(['SAUCE_PW'], { pinnedButMissing: true })).toMatch(/no longer exists/)
  })

  it('uses the caller’s fix hint instead of the generic one', () => {
    // Passed in rather than appended by the caller: two sentences each telling you
    // to pick an environment reads like a stutter.
    const msg = missingEnvMessage(['SAUCE_PW'], { fixHint: 'Pick one on the card.' })
    expect(msg).toContain('Pick one on the card.')
    expect(msg).not.toContain('the environment this run uses')
  })

  it('keeps the fix hint when the pinned environment is also gone', () => {
    const msg = missingEnvMessage(['SAUCE_PW'], {
      pinnedButMissing: true,
      fixHint: 'Pick one on the card.'
    })
    expect(msg).toMatch(/no longer exists/)
    expect(msg).toContain('Pick one on the card.')
  })
})
