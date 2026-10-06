import { describe, it, expect } from 'vitest'
import {
  headlessRunEnv,
  mergeEnvValues,
  missingEnvMessage,
  missingEnvNames,
  planRun,
  runData,
  runFixturePaths,
  runSecretRefs,
  type EnvSources
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
      missingEnvNames(
        ['SAUCE_PW'],
        { values: { SAUCE_PW: '' }, unresolved: ['SAUCE_PW'] },
        {
          SAUCE_PW: 'secret_sauce'
        }
      )
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

  it('does not tell you to add a protected data cell to an environment', () => {
    // "{{env:secret:sec_91a…}}" names something that doesn't exist. A cell goes
    // missing when the encrypted store can't be read here; retyping fixes it.
    const msg = missingEnvMessage(['secret:sec_91a', 'SAUCE_PW'])
    expect(msg).not.toContain('secret:')
    expect(msg).toContain('{{env:SAUCE_PW}}')
    expect(msg).toContain('1 protected data-table value could not be read')
    expect(missingEnvMessage(['secret:sec_91a'])).not.toMatch(/environment variable/)
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

// =====================================================================
// The environment a headless run gets — shared by the in-app monitor and the
// command line, so a scheduled run with the app CLOSED fills the saved
// password the same way the app does with it open.
//
// The store is a fake: a plain map, plus a record of what was asked for, so a
// test can also prove the store was NOT consulted when something outranks it.
// =====================================================================
describe('headlessRunEnv', () => {
  const store = (values: Record<string, string>): { sources: EnvSources; asked: string[][] } => {
    const asked: string[][] = []
    const sources: EnvSources = {
      getSecrets: async (refs: string[]) => {
        asked.push(refs)
        const out: Record<string, string> = {}
        for (const r of refs) if (values[r] !== undefined) out[r] = values[r]
        return out
      },
      // env:get's contract: a name with no value is '' AND listed as unresolved.
      resolveNames: async (names: string[]) => {
        const out: Record<string, string> = {}
        const unresolved: string[] = []
        for (const n of names) {
          const key = n.startsWith('secret:') ? n.slice('secret:'.length) : `env:${n}`
          out[n] = values[key] ?? ''
          if (!out[n]) unresolved.push(n)
        }
        return { values: out, unresolved }
      }
    }
    return { sources, asked }
  }
  const login = [
    { type: 'navigate' },
    { type: 'type', secret: true, secretRef: 'sec_pw', value: '' }
  ]

  it('fills PASSWORD from the stored secret', async () => {
    const { sources } = store({ sec_pw: 'secret_sauce' })
    const out = await headlessRunEnv(login, [], [], {}, sources)
    expect(out.env.PASSWORD).toBe('secret_sauce')
    expect(out.missing).toEqual([])
  })

  it('a pinned environment’s PASSWORD beats the stored one', async () => {
    const { sources, asked } = store({ sec_pw: 'secret_sauce' })
    const out = await headlessRunEnv(login, [], [], { PASSWORD: 'pinned' }, sources)
    expect(out.env.PASSWORD).toBe('pinned')
    expect(asked).toEqual([])
  })

  it('a value set outside the app beats the store — how CI overrides it', async () => {
    const { sources, asked } = store({ sec_pw: 'secret_sauce' })
    const out = await headlessRunEnv(login, [], [], {}, sources, { PASSWORD: 'from-ci' })
    // Left OUT of the env, not copied in: the child inherits the OS value, and
    // the store is never even asked.
    expect(out.env.PASSWORD).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('an EMPTY outside value is no value — the store still fills it', async () => {
    const { sources } = store({ sec_pw: 'secret_sauce' })
    const out = await headlessRunEnv(login, [], [], {}, sources, { PASSWORD: '' })
    expect(out.env.PASSWORD).toBe('secret_sauce')
  })

  it('a store this account cannot read leaves PASSWORD unset, so the run can refuse', async () => {
    const { sources } = store({})
    const out = await headlessRunEnv(login, [], [], {}, sources)
    expect('PASSWORD' in out.env).toBe(false)
  })

  it('honours a pre-F40 literal on a secret step when there is no ref', async () => {
    const { sources } = store({})
    const out = await headlessRunEnv(
      [{ type: 'type', secret: true, value: 'old_literal' }],
      [],
      [],
      {},
      sources
    )
    expect(out.env.PASSWORD).toBe('old_literal')
  })

  it('protected data cells become PASSWORD_1… and the lookup keys stay out', async () => {
    const { sources } = store({ sec_a: 'secret_sauce', sec_b: 'wrong' })
    const rows = [
      { username: 'u1', password: '{{secret:sec_a}}' },
      { username: 'u2', password: '{{secret:sec_b}}' }
    ]
    const out = await headlessRunEnv([], rows, ['secret:sec_a', 'secret:sec_b'], {}, sources)
    expect(out.env).toEqual({ PASSWORD_1: 'secret_sauce', PASSWORD_2: 'wrong' })
    expect(out.missing).toEqual([])
  })

  it('an outside PASSWORD_1 beats the stored cell, like PASSWORD', async () => {
    const { sources } = store({ sec_a: 'secret_sauce', sec_b: 'wrong' })
    const rows = [{ password: '{{secret:sec_a}}' }, { password: '{{secret:sec_b}}' }]
    const out = await headlessRunEnv([], rows, ['secret:sec_a', 'secret:sec_b'], {}, sources, {
      PASSWORD_1: 'ci'
    })
    expect(out.env.PASSWORD_1).toBeUndefined()
    expect(out.env.PASSWORD_2).toBe('wrong')
  })

  it('names what it could not resolve', async () => {
    const { sources } = store({})
    const out = await headlessRunEnv([], [], ['API_KEY', 'secret:sec_gone'], {}, sources)
    expect(out.missing).toEqual(['API_KEY', 'secret:sec_gone'])
  })

  it('an environment value for an {{env:…}} name beats the resolver', async () => {
    const { sources } = store({ 'env:API_KEY': 'active' })
    const out = await headlessRunEnv([], [], ['API_KEY'], { API_KEY: 'pinned' }, sources)
    expect(out.env.API_KEY).toBe('pinned')
  })
})

describe('planRun', () => {
  const blocks: Record<string, { type: string; blockRef?: string; createsData?: string }[]> = {
    login: [{ type: 'navigate' }, { type: 'type' }, { type: 'click' }],
    outer: [{ type: 'block', blockRef: 'login' }, { type: 'assert' }]
  }
  type Step = (typeof blocks)[string][number]
  const load = async (ref: string): Promise<Step[] | null> => blocks[ref] ?? null

  it('expands a linked block and maps every inner step back to the block’s row', async () => {
    const plan = await planRun(
      [{ type: 'navigate' }, { type: 'block', blockRef: 'login' }, { type: 'assert' }],
      load
    )
    expect(plan.flat.map((s) => s.type)).toEqual([
      'navigate',
      'navigate',
      'type',
      'click',
      'assert'
    ])
    expect(plan.map).toEqual([0, 1, 1, 1, 2])
  })

  it('flattens nested blocks', async () => {
    const plan = await planRun([{ type: 'block', blockRef: 'outer' }], load)
    expect(plan.flat).toHaveLength(4)
    expect(plan.map).toEqual([0, 0, 0, 0])
  })

  it('drops a disabled or dangling block, but keeps a disabled plain step', async () => {
    const plan = await planRun(
      [
        { type: 'block', blockRef: 'login', disabled: true },
        { type: 'block', blockRef: 'gone' },
        { type: 'click', disabled: true }
      ],
      load
    )
    expect(plan.flat).toEqual([{ type: 'click', disabled: true }])
    expect(plan.map).toEqual([2])
  })

  it('carries a block’s “creates data” flag onto its first inner step only', async () => {
    const plan = await planRun([{ type: 'block', blockRef: 'login', createsData: 'user' }], load)
    expect(plan.flat[0].createsData).toBe('user')
    expect(plan.flat[1].createsData).toBeUndefined()
    // The block file itself is not mutated.
    expect(blocks.login[0].createsData).toBeUndefined()
  })
})
