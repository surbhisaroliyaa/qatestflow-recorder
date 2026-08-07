import { describe, it, expect } from 'vitest'
import {
  applySaves,
  isRuntimeToken,
  newRunTokens,
  parseSaveSpec,
  pickPath,
  resolveRuntimeStep,
  resolveRuntimeText,
  savedNameOf
} from '../src/main/runtimeTokens'
import { isRuntimeToken as rendererIsRuntimeToken } from '../src/renderer/src/dataDriven'
import { runtimeTokenUse, generatePlaywrightTest } from '../src/renderer/src/playwrightExport'

// =====================================================================
// F24.1 — the tokens that make an API test RE-RUNNABLE.
//
// POST /users {"email":"qa@x.com"}  → run 1 ✅, run 2 ❌ 409 (email taken)
// DELETE /orders/123                → run 1 ✅, run 2 ❌ 404 (already gone)
//
// A test that passes exactly once is worse than no test: it goes red forever
// and looks like a product bug. {{uuid}}/{{timestamp}}/{{randomInt}} give each
// run its own data; {{saved:orderId}} carries a value the SERVER invented from
// one step to the next, which is the only way create → verify → delete works.
//
// This engine is mirrored in two other places, and each mirror has already
// broken once. The last section checks all three still agree.
// =====================================================================

const s = (o: Record<string, unknown>): never => o as never

describe('dynamic tokens', () => {
  it('gives a fresh value per RUN, and the SAME value twice within one run', () => {
    // A POST body and a later assertion have to agree, or the test checks
    // something it never created.
    const t = newRunTokens()
    const a = resolveRuntimeText('{{uuid}}', t)
    const b = resolveRuntimeText('{{uuid}}', t)
    expect(a).toBe(b)
    expect(resolveRuntimeText('{{uuid}}', newRunTokens())).not.toBe(a)
  })

  it('produces a uuid shaped like a uuid', () => {
    expect(resolveRuntimeText('{{uuid}}', newRunTokens())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('substitutes inside a larger string, not just on its own', () => {
    const out = resolveRuntimeText('qa+{{timestamp}}@example.com', newRunTokens())
    expect(out).toMatch(/^qa\+\d+@example\.com$/)
  })

  it('memoises each kind separately', () => {
    const t = newRunTokens()
    const both = resolveRuntimeText('{{uuid}}|{{randomInt}}', t)
    const [uuid, int] = both.split('|')
    expect(uuid).not.toBe(int)
    expect(resolveRuntimeText('{{randomInt}}', t)).toBe(int)
  })
})

describe('saved tokens', () => {
  it('substitutes a value lifted out of an earlier response', () => {
    const t = newRunTokens()
    t.saved.orderId = 'A-99'
    expect(resolveRuntimeText('/orders/{{saved:orderId}}', t)).toBe('/orders/A-99')
  })

  it('leaves an UNRESOLVED saved token as the literal token, never blank', () => {
    // A silent '' turns `DELETE /orders/{{saved:id}}` into `DELETE /orders/`,
    // which on a real API can mean "delete the whole collection". Failing
    // loudly on a nonsense URL is the safe direction.
    const out = resolveRuntimeText('/orders/{{saved:missing}}', newRunTokens())
    expect(out).toBe('/orders/{{saved:missing}}')
    expect(out).not.toBe('/orders/')
  })

  it('tolerates spacing inside the braces', () => {
    const t = newRunTokens()
    t.saved.id = '7'
    expect(resolveRuntimeText('{{ saved:id }}', t)).toBe('7')
    expect(savedNameOf('saved: id ')).toBe('id')
  })

  it('leaves tokens that belong to someone else alone', () => {
    // {{env:X}} and data-table {{column}} are substituted by the renderer
    // BEFORE the run. Touching them here would blank a value already resolved.
    const t = newRunTokens()
    expect(resolveRuntimeText('{{env:PASSWORD}}', t)).toBe('{{env:PASSWORD}}')
    expect(resolveRuntimeText('{{username}}', t)).toBe('{{username}}')
  })
})

describe('which fields of a step get resolved', () => {
  const t = newRunTokens()
  t.saved.orderId = 'A-99'

  it('resolves url, value, headers, body, checks and expected body', () => {
    const out = resolveRuntimeStep(
      s({
        type: 'api',
        url: '/orders/{{saved:orderId}}',
        value: '{{saved:orderId}}',
        apiHeaders: 'X-Id: {{saved:orderId}}',
        apiBody: '{"id":"{{saved:orderId}}"}',
        apiChecks: 'id equals {{saved:orderId}}',
        apiExpectBody: '{{saved:orderId}}'
      }),
      t
    )
    for (const field of ['url', 'value', 'apiHeaders', 'apiBody', 'apiChecks', 'apiExpectBody']) {
      expect(out[field], field).toContain('A-99')
      expect(out[field], field).not.toContain('{{')
    }
  })

  it('resolves apiChecks — the field whose absence made chained tests impossible', () => {
    // Without it, `id equals {{saved:orderId}}` was compared against the LITERAL
    // string and could never pass. Silently. Asserting that a GET returns the id
    // an earlier POST created is the most natural thing to want from a chained
    // API test, and it was the one thing that couldn't work.
    const out = resolveRuntimeStep(s({ type: 'api', apiChecks: 'id equals {{saved:orderId}}' }), t)
    expect(out.apiChecks).toBe('id equals A-99')
  })

  it('never touches the selector — only user-supplied DATA is tokenized', () => {
    const step = s({ type: 'click', selector: "getByTestId('{{saved:orderId}}')" })
    expect(resolveRuntimeStep(step, t).selector).toBe("getByTestId('{{saved:orderId}}')")
  })

  it('returns a COPY, so the saved test keeps the tokens you authored', () => {
    const step = s({ type: 'api', url: '/orders/{{saved:orderId}}' })
    const out = resolveRuntimeStep(step, t)
    expect(out).not.toBe(step)
    expect(step.url).toBe('/orders/{{saved:orderId}}')
  })

  it('returns the SAME object when there is nothing to do', () => {
    // The common case: don't clone every step of every run.
    const step = s({ type: 'click', selector: 'x' })
    expect(resolveRuntimeStep(step, t)).toBe(step)
  })
})

describe('saving a value out of a response', () => {
  it('reads dot paths, including array indexes', () => {
    const body = { id: 1, data: { token: 'abc' }, items: [{ sku: 'A' }] }
    expect(pickPath(body, 'id')).toBe(1)
    expect(pickPath(body, 'data.token')).toBe('abc')
    expect(pickPath(body, 'items.0.sku')).toBe('A')
  })

  it('misses safely rather than throwing', () => {
    expect(pickPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(pickPath(null, 'a')).toBeUndefined()
    expect(pickPath({ items: [] }, 'items.notanindex')).toBeUndefined()
  })

  it('parses one `name = path` per line', () => {
    expect(parseSaveSpec('orderId = id\ntoken=data.token')).toEqual([
      { name: 'orderId', path: 'id' },
      { name: 'token', path: 'data.token' }
    ])
  })

  it('stores each saved value for later steps', () => {
    const t = newRunTokens()
    expect(applySaves('{"id":"A-99"}', 'orderId = id', t)).toBeNull()
    expect(t.saved.orderId).toBe('A-99')
  })

  it('REFUSES a line that is not `name = path`, instead of skipping it', () => {
    // A response check typed into this box (`id not-empty`) used to vanish:
    // saved, never run, never mentioned, absent from the export — every layer
    // looking correct. An ignored assertion is worse than a red run.
    const t = newRunTokens()
    expect(applySaves('{"id":1}', 'id not-empty', t)).toBeTruthy()
  })

  it('says the body was not JSON rather than blaming the path', () => {
    const err = applySaves('<html>502</html>', 'orderId = id', newRunTokens())
    expect(err).toMatch(/isn't JSON/i)
    expect(err).toContain('502')
  })

  it('fails where the cause is obvious when a path misses', () => {
    // Saving nothing silently means failing LATER with a baffling URL.
    const err = applySaves('{"id":1}', 'orderId = order.id', newRunTokens())
    expect(err).toContain('orderId')
    expect(err).toContain('order.id')
  })

  it('refuses to save an object or array as if it were a value', () => {
    expect(applySaves('{"data":{"a":1}}', 'x = data', newRunTokens())).toMatch(/object\/array/i)
  })

  it('treats null as unsaveable — String(null) would store "null"', () => {
    expect(applySaves('{"id":null}', 'orderId = id', newRunTokens())).toBeTruthy()
  })
})

// =====================================================================
// § the mirrors
// This engine is described in three places. main resolves the tokens, the
// renderer must NOT treat them as data columns, and the exporter has to
// emit an equivalent for each one. Two of the three have broken before.
// =====================================================================
describe('all three copies agree on what a runtime token IS', () => {
  const RUNTIME = ['uuid', 'timestamp', 'randomInt', 'saved:orderId']
  const NOT_RUNTIME = ['env:PASSWORD', 'username', 'loop:index', 'total']

  it('main and the renderer classify every token the same way', () => {
    // If the renderer thought {{uuid}} were a data column it would blank it out
    // before main ever saw it, and the run would POST an empty string.
    for (const name of [...RUNTIME, ...NOT_RUNTIME]) {
      expect(rendererIsRuntimeToken(name), name).toBe(isRuntimeToken(name))
    }
  })

  it('main resolves exactly the tokens it claims to', () => {
    for (const name of RUNTIME) expect(isRuntimeToken(name), name).toBe(true)
    for (const name of NOT_RUNTIME) expect(isRuntimeToken(name), name).toBe(false)
  })

  // The emitted CODE only. Every line carries a `//` note describing the step as
  // the user authored it — tokens included, deliberately — so asserting against
  // the whole file would be reading the comment, not the code.
  const codeOnly = (spec: string): string =>
    spec
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')

  it('the exporter emits a real value for every dynamic token main resolves', () => {
    // A token main resolves but the exporter does not would survive into the
    // exported spec as the literal text "{{uuid}}" — the app creates unique data
    // and CI posts the same string every time.
    for (const [name, expected] of [
      ['uuid', 'randomUUID()'],
      ['timestamp', 'Date.now()'],
      ['randomInt', 'Math.random()']
    ] as const) {
      const code = codeOnly(
        generatePlaywrightTest(
          [s({ type: 'api', apiMethod: 'POST', url: `https://a.test/{{${name}}}` })],
          { name: 'T' }
        )
      )
      expect(code, name).toContain(expected)
      expect(code, name).not.toContain(`{{${name}}}`)
    }
  })

  it('the exporter carries a saved token through as a reference', () => {
    const code = codeOnly(
      generatePlaywrightTest(
        [
          s({ type: 'api', apiMethod: 'POST', url: 'https://a.test/', apiSave: 'orderId = id' }),
          s({ type: 'api', apiMethod: 'DELETE', url: 'https://a.test/{{saved:orderId}}' })
        ],
        { name: 'T' }
      )
    )
    expect(code).toContain('saved.orderId')
    expect(code).not.toContain('{{saved:orderId}}')
  })

  it('the exporter scans the SAME step fields main resolves', () => {
    // The documented past bug: a token living only in apiChecks was missed, so
    // the spec referenced `saved` without declaring it and would not compile.
    // Every field main substitutes must also be one the exporter looks in.
    const FIELDS = ['url', 'value', 'apiHeaders', 'apiBody', 'apiChecks', 'apiExpectBody']
    for (const field of FIELDS) {
      const step = s({ type: 'api', [field]: '{{saved:orderId}}' })
      expect(runtimeTokenUse([step]).saved, field).toBe(true)
      // …and main substitutes into it, so the two lists are the same list.
      const t = newRunTokens()
      t.saved.orderId = 'A-99'
      expect(String(resolveRuntimeStep(step, t)[field]), field).toBe('A-99')
    }
  })

  it('a dynamic token in any of those fields is seen by the exporter too', () => {
    for (const field of ['url', 'apiBody', 'apiChecks', 'apiExpectBody']) {
      expect(runtimeTokenUse([s({ type: 'api', [field]: '{{uuid}}' })]).uuid, field).toBe(true)
    }
  })
})
