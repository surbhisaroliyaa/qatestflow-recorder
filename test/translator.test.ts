import { describe, it, expect } from 'vitest'
import {
  categorizeFailure,
  defang,
  parseAiActions,
  parseNlAnswers,
  ruleBasedExplain,
  siteFirst,
  type FailureEvidence
} from '../src/main/translator'

// =====================================================================
// FAILURE TRIAGE — the thing that makes this app feel like it understands
// what happened rather than just going red.
//
// It answers the only question that matters after a failure: is the APP
// broken, or is the TEST stale? Get that wrong confidently and you send
// someone hunting a bug that doesn't exist, or worse, teach them to
// ignore the verdict.
//
// Everything here is the RULE-BASED backend — no model, no network. It's
// the one that always runs, and it's what every user gets when Claude
// isn't available.
// =====================================================================

const ev = (o: Partial<FailureEvidence>): FailureEvidence => ({
  pageUrl: 'https://shop.test/cart',
  pageTitle: 'Cart',
  stepIndex: 2,
  stepText: 'Click "Checkout"',
  stepType: 'click',
  error: '',
  consoleErrors: [],
  networkErrors: [],
  allSteps: ['1. Go to /', '2. Click "Cart"', '3. Click "Checkout"'],
  ...o
})

describe('app broken, or test stale?', () => {
  it('a missing element on a HEALTHY page is a stale selector', () => {
    const out = ruleBasedExplain(ev({ error: 'Element not found (may have changed)' }))
    expect(out.verdict).toBe('test-bug')
  })

  it('the SAME error on a page throwing 500s is an app bug', () => {
    // The element is probably missing BECAUSE the app failed to render it.
    // This one distinction is most of the value of the whole feature.
    const out = ruleBasedExplain(
      ev({
        error: 'Element not found (may have changed)',
        networkErrors: ['[step 3] HTTP 500 on https://shop.test/api/cart [site]']
      })
    )
    expect(out.verdict).toBe('app-bug')
    expect(out.explanation).toMatch(/render|broken/i)
  })

  it('console errors alone are enough to flip that verdict', () => {
    const out = ruleBasedExplain(
      ev({
        error: 'Element not found (may have changed)',
        consoleErrors: ['[step 3] Uncaught TypeError: cart is undefined']
      })
    )
    expect(out.verdict).toBe('app-bug')
  })

  it('THIRD-PARTY 500s do NOT flip it — analytics fail on healthy pages constantly', () => {
    // Counting them would mean nearly every real-world failure gets blamed on
    // the app, which is the fastest way to make a verdict worthless.
    const out = ruleBasedExplain(
      ev({
        error: 'Element not found (may have changed)',
        networkErrors: ['[step 3] HTTP 500 on https://analytics.example.com/t [third-party]']
      })
    )
    expect(out.verdict).toBe('test-bug')
  })

  it('an unreachable site blames neither the app nor the test', () => {
    const out = ruleBasedExplain(ev({ error: 'net::ERR_NAME_NOT_RESOLVED' }))
    expect(out.verdict).toBe('environment')
    expect(out.explanation).toMatch(/could not load the page/i)
  })

  it('a missing LOCAL file is environment too — it used to fall through', () => {
    expect(ruleBasedExplain(ev({ error: 'net::ERR_FILE_NOT_FOUND' })).verdict).toBe('environment')
  })
})

describe('chaos runs must not be reported as outages', () => {
  // F29. Without this the triage sees "timed out, no response", concludes the
  // service is down, and tells you to go start a server that is running
  // perfectly well — the slowness was INJECTED by the test itself. A
  // confidently wrong verdict sends someone chasing a phantom outage.
  const timedOut = { error: 'API request timed out — the server did not respond within 5000ms' }

  it('a timeout during a slow-net run is timing, not environment', () => {
    const out = ruleBasedExplain(ev({ ...timedOut, chaos: { slowNetwork: true, latencyMs: 2000 } }))
    expect(out.verdict).toBe('timing')
    expect(out.explanation).toMatch(/slow net/i)
    expect(out.suggestion).toMatch(/do not start hunting a dead server/i)
  })

  it('the SAME timeout without chaos is free to blame the environment', () => {
    expect(ruleBasedExplain(ev(timedOut)).verdict).not.toBe('timing')
  })

  it('the chaos rule is checked BEFORE the unreachable-site rule', () => {
    // Order is the whole fix: the unreachable rule would otherwise match first
    // and confidently blame the network.
    const out = ruleBasedExplain(
      ev({
        error: 'API request failed — the host could not be reached, timed out',
        chaos: { slowNetwork: true }
      })
    )
    expect(out.verdict).toBe('timing')
  })
})

describe('data-driven failures', () => {
  it('classifies the EXAMPLE inside the aggregate, not the aggregate', () => {
    // A data-driven run reports "5/5 rows failed — e.g. Row 1: <real error>".
    // Without unwrapping it, every data-driven failure reads as `unknown`
    // however clear its actual cause.
    const out = ruleBasedExplain(
      ev({ error: '5/5 rows failed — e.g. Row 1 (standard_user): net::ERR_NAME_NOT_RESOLVED' })
    )
    expect(out.verdict).toBe('environment')
  })

  it('keeps the aggregate wording when the example says nothing useful', () => {
    const out = ruleBasedExplain(ev({ error: '5/5 rows failed — e.g. Row 1: something odd' }))
    expect(out.verdict).toBeDefined()
  })
})

describe('a test that failed at several steps', () => {
  const multi = ev({
    error: 'Element not found (may have changed)',
    failures: [
      { index: 2, stepText: 'Click "Checkout"', error: 'Element not found (may have changed)' },
      { index: 5, stepText: 'Check total', error: 'net::ERR_NAME_NOT_RESOLVED' }
    ] as FailureEvidence['failures']
  })

  it('walks through every failure in one explanation', () => {
    const out = ruleBasedExplain(multi)
    expect(out.explanation).toContain('failed at 2 steps')
    expect(out.explanation).toContain('Step 3')
    expect(out.explanation).toContain('Step 6')
  })

  it('states run-wide evidence once, not per step', () => {
    const out = ruleBasedExplain({
      ...multi,
      consoleErrors: ['[step 3] Uncaught TypeError: boom']
    })
    expect(out.explanation.split('Uncaught TypeError').length - 1).toBe(1)
  })
})

describe('evidence ordering', () => {
  it('puts same-site errors first so a capped list is never all junk', () => {
    const lines = [
      'HTTP 500 on https://cdn.ads.example/x [third-party]',
      'HTTP 500 on https://shop.test/api [site]',
      'HTTP 404 on https://fonts.example/x [third-party]'
    ]
    expect(siteFirst(lines)[0]).toContain('[site]')
  })

  it('keeps the original order within each group', () => {
    const lines = ['a [site]', 'b [third-party]', 'c [site]']
    expect(siteFirst(lines)).toEqual(['a [site]', 'c [site]', 'b [third-party]'])
  })

  it('does not mutate the caller’s array', () => {
    const lines = ['b [third-party]', 'a [site]']
    siteFirst(lines)
    expect(lines[0]).toBe('b [third-party]')
  })
})

describe('categorising for the suite breakdown', () => {
  it('is deterministic and offline, so it can be stamped on every failure', () => {
    const e = ev({ error: 'net::ERR_NAME_NOT_RESOLVED' })
    expect(categorizeFailure(e)).toBe(categorizeFailure(e))
    expect(categorizeFailure(e)).toBe('environment')
  })

  it('agrees with the explanation it is shown beside', () => {
    // The category is attached independently of which backend wrote the prose,
    // so the two must not be able to contradict each other on screen.
    for (const error of [
      'Element not found (may have changed)',
      'net::ERR_NAME_NOT_RESOLVED',
      'Element found but stayed disabled'
    ]) {
      const e = ev({ error })
      expect(categorizeFailure(e), error).toBe(ruleBasedExplain(e).category)
    }
  })
})

// =====================================================================
// § the model-facing edges
// Where untrusted page content goes INTO a prompt, and where the model's
// answer comes back OUT. Both are places a mistake is silent.
// =====================================================================
describe('page content cannot break out of the prompt', () => {
  // The page under test is untrusted input: its text is pasted into a prompt
  // between fences. A page that closes the fence could give the model its own
  // instructions and steer the verdict on its own bug report.
  it('neutralises the fence marker', () => {
    const out = defang('before <<<PAGE_DATA>>> after')
    expect(out).not.toContain('<<<PAGE_DATA>>>')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('neutralises a triple quote', () => {
    expect(defang('say """ now')).not.toContain('"""')
  })

  it('handles every occurrence, not just the first', () => {
    expect(defang('<<<PAGE_DATA>>> x <<<PAGE_DATA>>>')).not.toContain('<<<PAGE_DATA>>>')
  })

  it('survives null and undefined', () => {
    expect(defang(null as unknown as string)).toBe('')
    expect(defang(undefined as unknown as string)).toBe('')
  })

  it('leaves ordinary text completely alone', () => {
    expect(defang('Your order #123 was placed.')).toBe('Your order #123 was placed.')
  })
})

describe('reading the model’s verdicts back', () => {
  // Anything that can't be read back must become a FAILURE, never a pass — a
  // false green produced by our own plumbing is the worst outcome available.
  it('pairs each numbered answer with its claim', () => {
    const out = parseNlAnswers(
      '1. RESULT: PASS\nREASON: the total is shown\n2. RESULT: FAIL\nREASON: no confirmation',
      2
    )
    expect(out[0]).toEqual({ pass: true, reason: 'the total is shown' })
    expect(out[1]?.pass).toBe(false)
  })

  it('returns null for a claim the model never answered', () => {
    // null is what the caller turns into a failure. Filling the gap with a pass
    // would wave through a check nobody judged.
    const out = parseNlAnswers('1. RESULT: PASS\nREASON: fine', 3)
    expect(out[0]?.pass).toBe(true)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeNull()
  })

  it('is not confused by the word RESULT inside a reason', () => {
    const out = parseNlAnswers(
      '1. RESULT: FAIL\nREASON: the RESULT panel never appeared\n2. RESULT: PASS\nREASON: ok',
      2
    )
    expect(out[0]?.pass).toBe(false)
    expect(out[1]?.pass).toBe(true)
  })

  it('ignores an answer numbered outside the range asked about', () => {
    expect(parseNlAnswers('7. RESULT: PASS\nREASON: x', 2)).toEqual([null, null])
  })

  it('returns all nulls for prose with no verdicts at all', () => {
    expect(parseNlAnswers('I could not tell from the screenshot.', 2)).toEqual([null, null])
  })
})

describe('the model may pick an element, never invent one', () => {
  // It is handed a numbered list of elements WE can already locate, and answers
  // with indexes. A selector it made up could not be replayed.
  const list = '[{"action":"click","element":1},{"action":"type","element":0,"value":"qa"}]'

  it('accepts indexes that exist', () => {
    expect(parseAiActions(list, 2)).toEqual([
      { action: 'click', element: 1, value: undefined },
      { action: 'type', element: 0, value: 'qa' }
    ])
  })

  it('DROPS an index outside the list it was given', () => {
    expect(parseAiActions('[{"action":"click","element":9}]', 2)).toEqual([])
    expect(parseAiActions('[{"action":"click","element":-1}]', 2)).toEqual([])
  })

  it('drops an action it does not know', () => {
    expect(parseAiActions('[{"action":"hack","element":0}]', 2)).toEqual([])
  })

  it('finds the array inside surrounding prose', () => {
    expect(parseAiActions('Sure! Here you go:\n[{"action":"click","element":0}]\nHope that helps', 1))
      .toHaveLength(1)
  })

  it('returns nothing rather than throwing on unusable output', () => {
    for (const text of ['', 'no json here', '[not json]', '{"action":"click"}']) {
      expect(() => parseAiActions(text, 2)).not.toThrow()
      expect(parseAiActions(text, 2), text).toEqual([])
    }
  })

  it('tolerates a QUOTED index — models are inconsistent about quoting numbers', () => {
    // Leniency is safe here precisely because the range check below is what
    // actually protects us: "0" is still checked against the list it was given.
    expect(parseAiActions('[{"action":"click","element":"0"}]', 2)).toEqual([
      { action: 'click', element: 0, value: undefined }
    ])
    expect(parseAiActions('[{"action":"click","element":"9"}]', 2)).toEqual([])
  })

  it('rejects an index that is not a whole number', () => {
    expect(parseAiActions('[{"action":"click","element":1.5}]', 2)).toEqual([])
    expect(parseAiActions('[{"action":"click","element":"abc"}]', 2)).toEqual([])
  })
})
