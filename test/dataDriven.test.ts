import { describe, it, expect } from 'vitest'
import {
  dataColumns,
  envVarNames,
  extractTokens,
  isRuntimeToken,
  resolveRow,
  stepHasTokens,
  substituteSteps,
  substituteText,
  toColumnName
} from '../src/renderer/src/dataDriven'

// Every case here is a bug that actually shipped, or the invariant that stops it
// coming back. Named accordingly — a test whose failure message doesn't tell you
// what broke in the real world is only half a test.

// The module is typed against the ambient RecorderStep; tests build partials.
const step = (s: Record<string, unknown>): never => s as never

describe('token extraction', () => {
  it('matches lazily so two adjacent tokens stay separate', () => {
    // A greedy regex swallowed the gap and produced ONE token named "a}} {{b".
    expect(extractTokens('{{a}} {{b}}')).toEqual(['a', 'b'])
  })

  it('trims whitespace inside the braces', () => {
    expect(extractTokens('{{  username  }}')).toEqual(['username'])
  })

  it('returns nothing for empty / missing text rather than throwing', () => {
    expect(extractTokens(undefined)).toEqual([])
    expect(extractTokens('')).toEqual([])
    expect(extractTokens('no tokens here')).toEqual([])
  })
})

describe('dataColumns', () => {
  it('turns plain tokens into columns, in first-seen order, deduped', () => {
    const cols = dataColumns([
      step({ type: 'type', value: '{{username}}' }),
      step({ type: 'type', value: '{{password}}' }),
      step({ type: 'assert', value: 'welcome {{username}}' })
    ])
    expect(cols).toEqual(['username', 'password'])
  })

  it('does NOT make a column out of an env token', () => {
    // {{env:PW}} comes from the environment, never from the table.
    expect(dataColumns([step({ type: 'type', value: '{{env:PW}}' })])).toEqual([])
  })

  it('does NOT make a column out of a runtime token (F24.1)', () => {
    // Nobody types a uuid into a data table, and a saved id does not exist until
    // the run produces it. These used to become empty columns.
    const cols = dataColumns([
      step({ type: 'type', value: '{{uuid}}' }),
      step({ type: 'type', value: '{{timestamp}}' }),
      step({ type: 'type', value: '{{randomInt}}' }),
      step({ type: 'api', url: '/orders/{{saved:orderId}}' })
    ])
    expect(cols).toEqual([])
  })

  it('reads tokens out of an API step’s checks and expected body', () => {
    // These fields were left out of tokenFields, so a {{column}} in an assertion
    // was never recognised as a column and got compared as literal text.
    const cols = dataColumns([
      step({ type: 'api', apiChecks: 'name equals {{customer}}' }),
      step({ type: 'api', apiExpectBody: '{"id":"{{orderId}}"}' })
    ])
    expect(cols).toEqual(['customer', 'orderId'])
  })
})

describe('envVarNames', () => {
  it('collects env names used by the STEPS', () => {
    expect(envVarNames([step({ type: 'type', value: '{{env:API_KEY}}' })], [])).toEqual(['API_KEY'])
  })

  it('collects env names used only inside DATA ROWS', () => {
    // The exact shape of the 2026-08-05 monitor bug: every row's password was
    // {{env:SAUCE_PW}} and no step mentioned it. A caller that only scanned steps
    // would resolve nothing and the run would type a raw token as a password.
    const names = envVarNames(
      [step({ type: 'type', value: '{{password}}' })],
      [{ username: 'standard_user', password: '{{env:SAUCE_PW}}' }]
    )
    expect(names).toEqual(['SAUCE_PW'])
  })

  it('dedupes a name used in several places', () => {
    const names = envVarNames(
      [step({ type: 'type', value: '{{env:PW}}' }), step({ type: 'type', value: '{{env:PW}}' })],
      [{ pw: '{{env:PW}}' }]
    )
    expect(names).toEqual(['PW'])
  })
})

describe('substituteText', () => {
  const row = { username: 'standard_user' }
  const env = { PW: 'secret_sauce' }

  it('fills a data column from the row', () => {
    expect(substituteText('{{username}}', row, env)).toBe('standard_user')
  })

  it('fills an env token from the resolved map', () => {
    expect(substituteText('{{env:PW}}', row, env)).toBe('secret_sauce')
  })

  it('leaves a runtime token EXACTLY as written (F24.1)', () => {
    // Blanking it turned `DELETE /orders/{{saved:id}}` into `DELETE /orders/`,
    // which on a real API can mean "delete the entire collection".
    expect(substituteText('/orders/{{saved:orderId}}', row, env)).toBe('/orders/{{saved:orderId}}')
    expect(substituteText('{{uuid}}', row, env)).toBe('{{uuid}}')
  })

  it('resolves an unknown column to empty string', () => {
    // Deliberate: the field ends up empty and the step fails, which is the signal.
    expect(substituteText('{{nope}}', row, env)).toBe('')
  })

  it('resolves an unset env token to empty string', () => {
    expect(substituteText('{{env:MISSING}}', row, {})).toBe('')
  })

  it('substitutes several tokens in one string', () => {
    expect(substituteText('{{username}}/{{env:PW}}', row, env)).toBe('standard_user/secret_sauce')
  })
})

describe('substituteSteps', () => {
  it('substitutes value, url and every API field but leaves selectors alone', () => {
    const [out] = substituteSteps(
      [
        step({
          type: 'api',
          selector: "getByTestId('{{username}}')",
          value: '{{username}}',
          url: 'https://x.test/{{username}}',
          apiHeaders: '{"k":"{{env:PW}}"}',
          apiBody: '{"u":"{{username}}"}',
          apiChecks: 'name equals {{username}}',
          apiExpectBody: '{"u":"{{username}}"}'
        })
      ],
      { username: 'bob' },
      { PW: 'pw' }
    ) as unknown as Record<string, string>[]

    expect(out.value).toBe('bob')
    expect(out.url).toBe('https://x.test/bob')
    expect(out.apiHeaders).toBe('{"k":"pw"}')
    expect(out.apiBody).toBe('{"u":"bob"}')
    expect(out.apiChecks).toBe('name equals bob')
    expect(out.apiExpectBody).toBe('{"u":"bob"}')
    // A selector is never tokenized — substituting it would break the locator.
    expect(out.selector).toBe("getByTestId('{{username}}')")
  })

  it('does not mutate the input steps', () => {
    const steps = [step({ type: 'type', value: '{{username}}' })]
    substituteSteps(steps, { username: 'bob' }, {})
    expect((steps[0] as unknown as { value: string }).value).toBe('{{username}}')
  })
})

describe('resolveRow', () => {
  it('resolves env tokens inside cells', () => {
    expect(resolveRow({ password: '{{env:PW}}' }, { PW: 'secret_sauce' })).toEqual({
      password: 'secret_sauce'
    })
  })

  it('survives a null/undefined cell instead of throwing', () => {
    expect(resolveRow({ a: undefined as unknown as string }, {})).toEqual({ a: '' })
  })
})

describe('isRuntimeToken', () => {
  it('recognises the dynamic tokens and any saved: reference', () => {
    expect(isRuntimeToken('uuid')).toBe(true)
    expect(isRuntimeToken('timestamp')).toBe(true)
    expect(isRuntimeToken('randomInt')).toBe(true)
    expect(isRuntimeToken('saved:orderId')).toBe(true)
  })

  it('does not claim ordinary or env tokens', () => {
    expect(isRuntimeToken('username')).toBe(false)
    expect(isRuntimeToken('env:PW')).toBe(false)
  })
})

describe('stepHasTokens', () => {
  it('is true only when a tokenizable field carries a token', () => {
    expect(stepHasTokens(step({ type: 'type', value: '{{a}}' }))).toBe(true)
    expect(stepHasTokens(step({ type: 'type', value: 'plain' }))).toBe(false)
    // A selector containing braces must not count as parameterized.
    expect(stepHasTokens(step({ type: 'click', selector: '{{a}}' }))).toBe(false)
  })
})

describe('toColumnName', () => {
  it('camel-cases a human label into a valid identifier', () => {
    expect(toColumnName('Username')).toBe('username')
    expect(toColumnName('First name')).toBe('firstName')
    expect(toColumnName('E-mail address')).toBe('eMailAddress')
  })

  it('never returns something the export cannot write as data.<name>', () => {
    // A leading digit would emit `data.1st` — a syntax error in the spec.
    expect(toColumnName('1st field')).toMatch(/^[A-Za-z_]/)
    expect(toColumnName('')).toBe('value')
    expect(toColumnName(undefined)).toBe('value')
    expect(toColumnName('!!!')).toBe('value')
  })
})
