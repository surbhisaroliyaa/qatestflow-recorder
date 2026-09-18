import { describe, it, expect } from 'vitest'
import {
  isSecretForDisplay,
  looksLikePasswordStep,
  maskPasswordInputs,
  maskStepDescription,
  placeholderRows,
  planSecretEnv,
  refsByStepId,
  secretCell,
  secretCellEnv,
  secretCellRef,
  stripRowSecrets,
  stripStepSecrets,
  withoutSecretKeys,
  type SecretSink
} from '../src/shared/secretCells'

// =====================================================================
// NO PLAINTEXT PASSWORD ON DISK (Option A, 2026-09-18)
//
// A sweep of a real library found `secret_sauce` in plaintext in five
// places the F40 choke point never looked: unmarked password steps, data
// tables, version history, _backups/ and drafts. These tests pin the pure
// rules; the real library is the fixture shape they are modelled on.
// =====================================================================

/** An in-memory store standing in for the encrypted secrets.json. */
function fakeSink(initial: Record<string, string> = {}): SecretSink & { map: Record<string, string> } {
  const map = { ...initial }
  let n = 0
  return {
    map,
    get: (ref) => map[ref],
    put: (ref, value) => {
      map[ref] = value
    },
    newRef: () => `sec_${String(++n).padStart(4, '0')}`
  }
}

const step = (o: Record<string, unknown>): Record<string, unknown> => o

describe('a password step nobody marked secret', () => {
  // f4-self-heal-demo: hand-built for the self-heal demo, so no recorder ever
  // flagged it — and the file has no record of what type its field was.
  const unmarked = step({
    type: 'type',
    label: 'Password',
    value: 'secret_sauce',
    secret: false,
    selector: "locator('#password-OLD')"
  })

  it('is recognised by its name', () => {
    expect(looksLikePasswordStep(unmarked)).toBe(true)
    expect(looksLikePasswordStep(step({ type: 'type', label: 'x', selector: "locator('#pwd')", value: 'a' }))).toBe(true)
    expect(looksLikePasswordStep(step({ type: 'type', label: 'Passwd', value: 'a' }))).toBe(true)
  })

  it('is not confused with an ordinary field, a click, or a value that is not a secret', () => {
    expect(looksLikePasswordStep(step({ type: 'type', label: 'Username', value: 'standard_user' }))).toBe(false)
    expect(looksLikePasswordStep(step({ type: 'click', label: 'Password' }))).toBe(false)
    // Empty: "Password is required" tests depend on it staying empty.
    expect(looksLikePasswordStep(step({ type: 'type', label: 'Password', value: '' }))).toBe(false)
    // A token is already a reference, not a value.
    expect(looksLikePasswordStep(step({ type: 'type', label: 'Password', value: '{{password}}' }))).toBe(false)
  })

  it('is moved into the store ONLY when the by-name pass is asked for', () => {
    // Every save running the guess would re-mask a step the user deliberately
    // unmasked. It is a one-time migration repair.
    const sink = fakeSink()
    expect(stripStepSecrets([unmarked], sink).changed).toBe(false)

    const { steps, changed } = stripStepSecrets([unmarked], sink, { byName: true })
    expect(changed).toBe(true)
    const out = steps[0] as Record<string, unknown>
    expect(out.secret).toBe(true)
    expect(out.value).toBe('')
    expect(sink.map[out.secretRef as string]).toBe('secret_sauce')
    expect(JSON.stringify(steps)).not.toContain('secret_sauce')
  })
})

describe('stripping steps', () => {
  it('moves a marked secret and keeps an existing ref', () => {
    const sink = fakeSink()
    const { steps } = stripStepSecrets(
      [step({ type: 'type', secret: true, value: 'hunter2', secretRef: 'sec_keep' })],
      sink
    )
    expect((steps[0] as Record<string, unknown>).secretRef).toBe('sec_keep')
    expect(sink.map.sec_keep).toBe('hunter2')
  })

  it("reuses the previous autosave's ref for the same step, so drafts don't pile up entries", () => {
    // The renderer never learns the ref, so every autosave re-sends plaintext.
    const sink = fakeSink()
    const first = stripStepSecrets([step({ id: 5, type: 'type', secret: true, value: 'pw' })], sink)
    const again = stripStepSecrets([step({ id: 5, type: 'type', secret: true, value: 'pw' })], sink, {
      refsById: refsByStepId(first.steps)
    })
    expect((again.steps[0] as Record<string, unknown>).secretRef).toBe(
      (first.steps[0] as Record<string, unknown>).secretRef
    )
    expect(Object.keys(sink.map)).toHaveLength(1)
  })

  it('leaves tokens, empties and ordinary steps alone, and does not mutate its input', () => {
    const input = [
      step({ type: 'type', secret: true, value: '{{env:PASSWORD}}' }),
      step({ type: 'type', secret: true, value: '' }),
      step({ type: 'type', value: 'standard_user' })
    ]
    const snapshot = JSON.stringify(input)
    const sink = fakeSink()
    const { changed } = stripStepSecrets(input, sink, { byName: true })
    expect(changed).toBe(false)
    expect(sink.map).toEqual({})
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('a data table', () => {
  // saucedemo-negative-login, verbatim: the matrix that motivated per-value names.
  const negativeLogin = [
    { username: 'locked_out_user', password: 'secret_sauce', expectedError: 'locked out' },
    { username: 'standard_user', password: 'wrong_pass', expectedError: 'do not match' },
    { username: 'ghost_user', password: 'secret_sauce', expectedError: 'do not match' },
    { username: '', password: 'secret_sauce', expectedError: 'Username is required' },
    { username: 'standard_user', password: '', expectedError: 'Password is required' },
    { username: '', password: '', expectedError: 'Username is required' }
  ]

  it('moves every sensitive value into the store, and nothing else', () => {
    const sink = fakeSink()
    const { rows, changed } = stripRowSecrets(negativeLogin, sink)
    expect(changed).toBe(true)
    const text = JSON.stringify(rows)
    expect(text).not.toContain('secret_sauce')
    expect(text).not.toContain('wrong_pass')
    // Non-sensitive columns carry on as they were.
    expect(rows![1].username).toBe('standard_user')
    expect(rows![1].expectedError).toBe('do not match')
  })

  it('keeps empty cells empty — the "Password is required" row depends on it', () => {
    const { rows } = stripRowSecrets(negativeLogin, fakeSink())
    expect(rows![4].password).toBe('')
    expect(rows![5].password).toBe('')
  })

  it('gives the same value in one column ONE ref', () => {
    const sink = fakeSink()
    const { rows } = stripRowSecrets(negativeLogin, sink)
    const refs = rows!.map((r) => secretCellRef(r.password))
    expect(refs[0]).toBe(refs[2])
    expect(refs[0]).toBe(refs[3])
    expect(refs[0]).not.toBe(refs[1])
    expect(Object.keys(sink.map)).toHaveLength(2)
  })

  it('is idempotent, and an edited cell reuses the ref of a value already stored', () => {
    const sink = fakeSink()
    const first = stripRowSecrets(negativeLogin, sink).rows!
    expect(stripRowSecrets(first, sink).changed).toBe(false)

    // The user retypes row 2 as secret_sauce: no new store entry.
    const edited = first.map((r, i) => (i === 1 ? { ...r, password: 'secret_sauce' } : r))
    const { rows } = stripRowSecrets(edited, sink)
    expect(secretCellRef(rows![1].password)).toBe(secretCellRef(first[0].password))
    expect(Object.keys(sink.map)).toHaveLength(2)
  })

  it('does not touch a table with nothing sensitive in it', () => {
    const rows = [{ username: 'a', item: 'backpack' }]
    expect(stripRowSecrets(rows, fakeSink())).toEqual({ rows, changed: false })
  })
})

describe('what the exported spec reads for a sensitive cell', () => {
  it('uses the plain name when a column has only one value', () => {
    // saucedemo-data-driven-demo: two rows, same password.
    const plan = planSecretEnv([
      { username: 'standard_user', password: 'secret_sauce' },
      { username: 'problem_user', password: 'secret_sauce' }
    ])
    expect(plan.cells.map((c) => c.password)).toEqual(['PASSWORD', 'PASSWORD'])
    expect(plan.sources.PASSWORD).toEqual({ value: 'secret_sauce' })
  })

  it('gives each DISTINCT value its own name, so a wrong password stays wrong', () => {
    // One PASSWORD for every row turned the "wrong_pass" row into a valid login.
    const sink = fakeSink()
    const rows = stripRowSecrets(
      [
        { user: 'a', password: 'secret_sauce' },
        { user: 'b', password: 'wrong_pass' },
        { user: 'c', password: 'secret_sauce' },
        { user: 'd', password: '' }
      ],
      sink
    ).rows!
    const plan = planSecretEnv(rows)
    expect(plan.cells.map((c) => c.password)).toEqual(['PASSWORD_1', 'PASSWORD_2', 'PASSWORD_1', undefined])
    // Filled from the store at run time — by ref, never by holding the value.
    expect(plan.sources.PASSWORD_1.ref).toBe(secretCellRef(rows[0].password))
    expect(sink.map[plan.sources.PASSWORD_2.ref!]).toBe('wrong_pass')
  })

  it('makes a legal variable name out of any column name', () => {
    expect(planSecretEnv([{ 'api-key': 'k' }]).cells[0]['api-key']).toBe('API_KEY')
  })

  it('leaves an {{env:…}} cell to the environment, where it already comes from', () => {
    expect(planSecretEnv([{ password: '{{env:REAL_PW}}' }]).cells[0]).toEqual({})
  })
})

describe('the env a headless run hands the exported spec', () => {
  it('maps resolved refs onto PASSWORD_1… and keeps lookup keys out', () => {
    const rows = [
      { password: secretCell('sec_a') },
      { password: secretCell('sec_b') },
      { password: 'typed-not-saved' }
    ]
    const resolved = { 'secret:sec_a': 'one', 'secret:sec_b': 'two', BASE_URL: 'http://x' }
    expect(secretCellEnv(rows, resolved)).toEqual({
      PASSWORD_1: 'one',
      PASSWORD_2: 'two',
      PASSWORD_3: 'typed-not-saved'
    })
    expect(withoutSecretKeys(resolved)).toEqual({ BASE_URL: 'http://x' })
  })
})

describe('describing a step never prints a password', () => {
  it('masks a flagged step, and an unflagged copy whose field is a password', () => {
    // A data-driven run describes a COPY with the row's password filled in.
    expect(isSecretForDisplay(step({ type: 'type', secret: true, value: 'x' }))).toBe(true)
    expect(isSecretForDisplay(step({ type: 'type', label: 'Password', value: 'secret_sauce' }))).toBe(true)
    expect(isSecretForDisplay(step({ type: 'type', label: 'Username', value: 'standard_user' }))).toBe(false)
  })

  it('shows an edge-case variant’s hostile value — that is the evidence', () => {
    const variant = step({ type: 'type', label: 'Password', value: "' OR 1=1 --", revealValue: true })
    expect(isSecretForDisplay(variant)).toBe(false)
    expect(looksLikePasswordStep(variant)).toBe(false)
  })

  it('repairs a description already written to disk', () => {
    expect(maskStepDescription('Type "secret_sauce" into Password')).toBe('Type "••••••••" into Password')
    expect(maskStepDescription('Type "standard_user" into Username')).toBe('Type "standard_user" into Username')
    expect(maskStepDescription('Click Login')).toBe('Click Login')
  })
})

describe('a page snapshot in a trace', () => {
  it("blanks a password field's typed value, in any attribute order or quoting", () => {
    // Verbatim from a real trace: React mirrors the typed value into the attribute.
    const real =
      '<input class="input_error form_input" placeholder="Password" type="password" data-test="password" id="password" value="secret_sauce">'
    expect(maskPasswordInputs(real)).not.toContain('secret_sauce')
    expect(maskPasswordInputs(real)).toContain('value=""')
    expect(maskPasswordInputs("<INPUT value='x' TYPE='Password'>")).toBe("<INPUT value=\"\" TYPE='Password'>")
    expect(maskPasswordInputs('<input type=password value=hunter2>')).toBe('<input type=password value="">')
  })

  it('leaves every other field and the rest of the page alone', () => {
    const html = '<p>Password for all users: secret_sauce</p><input type="text" value="standard_user">'
    expect(maskPasswordInputs(html)).toBe(html)
  })
})

describe('a bundle row set', () => {
  it('asks the recipient for one variable per distinct value, and leaves empties empty', () => {
    const { rows, scrubbed } = placeholderRows([
      { password: 'secret_sauce' },
      { password: 'wrong_pass' },
      { password: '' }
    ])
    expect(rows.map((r) => r.password)).toEqual(['{{env:PASSWORD_1}}', '{{env:PASSWORD_2}}', ''])
    expect(scrubbed).toEqual(['password'])
  })

  it('placeholders a stored {{secret:…}} cell too — a ref is meaningless on another machine', () => {
    const { rows } = placeholderRows([{ token: secretCell('sec_x') }])
    expect(rows[0].token).toBe('{{env:TOKEN}}')
  })
})
