import { describe, it, expect } from 'vitest'
import { analyzeControlFlow, hasControlFlow, resolveLoopTokens } from '../src/shared/controlFlow'

// An unbalanced control block is not a cosmetic problem. The exporter emitted an
// unmatched `{`, Playwright treated it as a FATAL LOAD ERROR, and the whole batch
// was abandoned — 55 tests reported as failures in two seconds. Three separate
// bugs in this project had that same shape, so the pairing rules are pinned here.

const s = (type: string, extra: Record<string, unknown> = {}): { type: string } =>
  ({ type, ...extra }) as { type: string }

describe('analyzeControlFlow — well-formed blocks', () => {
  it('pairs a repeat with its endRepeat', () => {
    const map = analyzeControlFlow([s('repeat'), s('click'), s('endRepeat')])
    expect(map.errors).toEqual([])
    expect(map.spans.get(0)).toMatchObject({ start: 0, end: 2 })
    expect(map.ownerOf.get(2)).toBe(0)
  })

  it('pairs an if / else / endIf and records the else', () => {
    const map = analyzeControlFlow([s('if'), s('click'), s('else'), s('click'), s('endIf')])
    expect(map.errors).toEqual([])
    expect(map.spans.get(0)).toMatchObject({ start: 0, end: 4, elseAt: 2 })
  })

  it('indents the body one level and lines the markers up with each other', () => {
    const map = analyzeControlFlow([s('repeat'), s('click'), s('endRepeat')])
    expect(map.depth).toEqual([0, 1, 0])
  })

  it('handles nesting', () => {
    const map = analyzeControlFlow([
      s('repeat'),
      s('if'),
      s('click'),
      s('endIf'),
      s('endRepeat')
    ])
    expect(map.errors).toEqual([])
    expect(map.depth).toEqual([0, 1, 2, 1, 0])
  })
})

describe('analyzeControlFlow — the failures that killed whole batches', () => {
  it('reports a repeat that is never closed', () => {
    const map = analyzeControlFlow([s('repeat'), s('click')])
    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]).toMatch(/never closed/)
  })

  it('reports an endRepeat with nothing open', () => {
    const map = analyzeControlFlow([s('click'), s('endRepeat')])
    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]).toMatch(/without a matching/)
  })

  it('refuses crossed markers rather than guessing', () => {
    // `repeat … endIf` — silently re-pairing could loop over the wrong steps.
    const map = analyzeControlFlow([s('repeat'), s('click'), s('endIf')])
    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]).toMatch(/can't overlap/)
  })

  it('reports an else with no if', () => {
    const map = analyzeControlFlow([s('click'), s('else')])
    expect(map.errors[0]).toMatch(/"else" without a matching "if"/)
  })

  it('reports a second else on the same if', () => {
    const map = analyzeControlFlow([s('if'), s('else'), s('else'), s('endIf')])
    expect(map.errors.some((e) => /already has an "else"/.test(e))).toBe(true)
  })

  it('numbers errors from 1, the way the steps panel does', () => {
    // An error naming "step 0" would send you to the wrong row.
    const map = analyzeControlFlow([s('click'), s('endRepeat')])
    expect(map.errors[0]).toMatch(/^Step 2:/)
  })
})

describe('analyzeControlFlow — disabled steps', () => {
  it('ignores a disabled pair entirely', () => {
    const map = analyzeControlFlow([
      s('repeat', { disabled: true }),
      s('click'),
      s('endRepeat', { disabled: true })
    ])
    expect(map.errors).toEqual([])
  })

  it('reports a HALF-disabled pair as the error it is', () => {
    const map = analyzeControlFlow([s('repeat'), s('click'), s('endRepeat', { disabled: true })])
    expect(map.errors[0]).toMatch(/never closed/)
  })
})

describe('hasControlFlow', () => {
  it('is false for a plain recording, so simple paths stay simple', () => {
    expect(hasControlFlow([s('click'), s('type')])).toBe(false)
  })

  it('is true when a live control step is present', () => {
    expect(hasControlFlow([s('click'), s('repeat')])).toBe(true)
  })

  it('is false when the only control step is disabled', () => {
    expect(hasControlFlow([s('repeat', { disabled: true })])).toBe(false)
  })
})

describe('resolveLoopTokens', () => {
  const loop = { index: 0, n: 1, text: 'Backpack' }

  it('resolves 0-based and 1-based counters', () => {
    expect(resolveLoopTokens('{{loop:index}}', loop)).toBe('0')
    expect(resolveLoopTokens('{{loop:n}}', loop)).toBe('1')
  })

  it('resolves the current element text', () => {
    expect(resolveLoopTokens('{{loop:text}}', loop)).toBe('Backpack')
  })

  it('leaves the token INTACT outside a loop rather than blanking it', () => {
    // Same rule as {{saved:x}}: a token that silently became '' could turn a real
    // assertion into a vacuous one — the dead-check disease.
    expect(resolveLoopTokens('{{loop:n}}', null)).toBe('{{loop:n}}')
  })

  it('passes undefined through', () => {
    expect(resolveLoopTokens(undefined, loop)).toBeUndefined()
  })
})
