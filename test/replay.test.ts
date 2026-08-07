import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import {
  buildActionScript,
  buildCollectionScript,
  buildFailureMarkScript,
  buildLocateRectScript,
  buildProbeScript,
  removeFailureMarkScript,
  type ReplayCandidate,
  type ReplayStep
} from '../src/main/replay'

// =====================================================================
// The replay engine is the app's other CODE GENERATOR. For each step it
// builds a snippet of JavaScript that gets injected into the live page to
// find the element and act on it. So it has the same two failure modes as
// the exporter — the snippet won't parse, or a recorded value breaks out
// of the string it was embedded in — and those are what this file covers.
//
// What it CANNOT cover is behaviour: whether the ladder actually finds the
// right element, whether a hidden element is told apart from a disabled
// one. That needs a real DOM with real layout, so it lives in test-dom/
// and runs under `npm run test:dom`. Both halves matter; this is the half
// that can run in a second, on every commit.
// =====================================================================

const s = (o: Record<string, unknown>): ReplayStep => o as ReplayStep
const cand = (o: Record<string, unknown>): ReplayCandidate => o as ReplayCandidate
const CSS = [cand({ kind: 'id', score: 90, css: '#t' })]

/** Syntax-only parse of an injected snippet. Empty = the browser would accept it. */
function syntaxErrors(code: string): string[] {
  const sf = ts.createSourceFile('inject.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
}

describe('the syntax checker itself', () => {
  it('sees a break and stays quiet on a good snippet', () => {
    expect(syntaxErrors('(async () => { const a = ( })()')).not.toEqual([])
    expect(syntaxErrors('(async () => { return { ok: true } })()')).toEqual([])
  })
})

// =====================================================================
// § parses
// A snippet that doesn't parse throws inside the page, and the step fails
// with a JavaScript error rather than a test result — which reads to the
// user as "the website is broken".
// =====================================================================
describe('every injected snippet parses', () => {
  const steps: Array<[string, ReplayStep]> = [
    ['click', s({ type: 'click', candidates: CSS })],
    ['type', s({ type: 'type', value: 'hello', candidates: CSS })],
    ['select', s({ type: 'select', value: 'Two', candidates: CSS })],
    ['press', s({ type: 'press', key: 'Enter', candidates: CSS })],
    ['hover', s({ type: 'hover', candidates: CSS })],
    ['back', s({ type: 'back' })],
    ...[
      'visible',
      'hidden',
      'text-equals',
      'text-contains',
      'value',
      'empty',
      'count',
      'enabled',
      'disabled',
      'editable',
      'focused',
      'checked',
      'unchecked',
      'attribute',
      'class',
      'url-contains',
      'title'
    ].map(
      (assertKind): [string, ReplayStep] => [
        `assert ${assertKind}`,
        s({ type: 'assert', assertKind, value: 'x', attrName: 'href', candidates: CSS })
      ]
    )
  ]

  for (const [title, step] of steps) {
    it(title, () => {
      expect(syntaxErrors(buildActionScript(step))).toEqual([])
    })
  }

  it('the probe, collection, rect and failure-mark snippets too', () => {
    const step = s({ type: 'if', candidates: CSS })
    expect(syntaxErrors(buildProbeScript(step))).toEqual([])
    expect(syntaxErrors(buildCollectionScript(step))).toEqual([])
    expect(syntaxErrors(buildLocateRectScript(step))).toEqual([])
    expect(syntaxErrors(buildFailureMarkScript(step, 'Element not found'))).toEqual([])
    expect(syntaxErrors(removeFailureMarkScript())).toEqual([])
  })

  it('an empty ladder still produces a valid snippet', () => {
    // A step whose candidates were never captured must fail as a RESULT, not
    // as a syntax error inside the page.
    expect(syntaxErrors(buildActionScript(s({ type: 'click' })))).toEqual([])
    expect(syntaxErrors(buildActionScript(s({ type: 'click', candidates: [] })))).toEqual([])
  })
})

// =====================================================================
// § hostile values
// The recorded value, the expected text, the attribute name and the
// selectors are all pasted INTO a JavaScript program. A value that closes
// its own quote would run as code in the page under test.
// =====================================================================
describe('a recorded value cannot break out of the injected snippet', () => {
  const nasties: Array<[string, string]> = [
    ['a quote', `it's "quoted"`],
    ['a backslash', 'C:\\Users\\samee'],
    ['a newline', 'line one\nline two'],
    ['a template literal', '`${alert(1)}`'],
    ['a script-closing tag', '</script><script>alert(1)</script>'],
    ['a snippet terminator', "'; alert(1); '"],
    ['unicode + emoji', '“quoted” 🧪']
  ]

  for (const [title, value] of nasties) {
    it(`survives ${title}`, () => {
      for (const step of [
        s({ type: 'type', value, candidates: CSS }),
        s({ type: 'select', value, candidates: CSS }),
        s({ type: 'press', key: value, candidates: CSS }),
        s({ type: 'assert', assertKind: 'text-equals', value, candidates: CSS }),
        s({ type: 'assert', assertKind: 'attribute', value, attrName: value, candidates: CSS }),
        s({ type: 'assert', assertKind: 'url-contains', value }),
        s({ type: 'assert', assertKind: 'title', value })
      ]) {
        expect(syntaxErrors(buildActionScript(step)), `${step.type}/${step.assertKind}`).toEqual([])
      }
    })

    it(`survives ${title} in a selector and in the failure text`, () => {
      const hostile = [cand({ kind: 'text', score: 50, css: null, text: value })]
      expect(syntaxErrors(buildActionScript(s({ type: 'click', candidates: hostile })))).toEqual([])
      expect(syntaxErrors(buildFailureMarkScript(s({ type: 'click', candidates: hostile }), value)))
        .toEqual([])
    })
  }

  it('embeds values as data, never as bare source', () => {
    // The mechanism behind the cases above: everything user-supplied goes
    // through JSON.stringify, so a quote arrives escaped rather than closing
    // the string it sits in.
    const script = buildActionScript(
      s({ type: 'type', value: `a" + alert(1) + "b`, candidates: CSS })
    )
    expect(script).not.toContain('a" + alert(1) + "b')
    expect(script).toContain('\\"')
  })
})

// =====================================================================
// § the ladder's own rules
// These are decisions, visible in the emitted text, that the DOM tests
// then prove actually happen.
// =====================================================================
describe('the candidate ladder', () => {
  it('carries every candidate into the page, in one go', () => {
    const script = buildActionScript(
      s({
        type: 'click',
        candidates: [cand({ kind: 'id', score: 90, css: '#a' }), cand({ kind: 'text', score: 50, css: null, text: 'Go' })]
      })
    )
    expect(script).toContain('"css":"#a"')
    expect(script).toContain('"text":"Go"')
  })

  it('sorts pinned first, then by score', () => {
    expect(buildActionScript(s({ type: 'click', candidates: CSS }))).toContain(
      '(b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)'
    )
  })

  it('refuses a ladder that is only a bare tag, rather than acting on the wrong element', () => {
    // The honest-refusal rule: `button` on its own matches the FIRST button on
    // the page, which is almost never the recorded one. Failing beats a false pass.
    const script = buildActionScript(s({ type: 'click', candidates: CSS }))
    expect(script).toContain('isBareTag')
    expect(script).toContain('No reliable selector for this element')
  })

  it('keeps the three failures distinct — absence is not the same as a defect', () => {
    // An optional step SKIPS on the first two and FAILS on the third: a control
    // the user can see but cannot use is a real bug, not a missing element.
    const script = buildActionScript(s({ type: 'click', candidates: CSS }))
    expect(script).toContain('Element not found')
    expect(script).toContain('never became visible')
    expect(script).toContain('stayed disabled')
  })

  it('counts a group with the SHADOW-PIERCING walk, like every other lookup', () => {
    // This one call used document.querySelectorAll while the rest of the engine
    // used deepQueryAll, so on a web-component page a count check reported 0
    // matches while clicking one of those very elements worked. Proven against
    // a real shadow root in test-dom/checks.spec.ts.
    const script = buildActionScript(
      s({ type: 'assert', assertKind: 'count', value: '3', candidates: CSS })
    )
    expect(script).toContain('deepQueryAll(c.css, document).length')
    expect(script).not.toContain('document.querySelectorAll(c.css).length')
  })

  it('a control-flow probe asks a question — it never waits the full find timeout', () => {
    // An `if` on an absent cookie banner is the COMMON case; waiting 30s for it
    // would add half a minute to every run of a test that handles one.
    const probe = buildProbeScript(s({ type: 'if', candidates: CSS }), 1500)
    expect(probe).toContain('Date.now() + 1500')
    expect(probe).toContain('found')
  })
})
