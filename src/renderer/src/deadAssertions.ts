// =====================================================================
// DEAD-ASSERTION DETECTOR (F6)
// A test can be full of green checkmarks and still verify nothing, if its
// assertions are "dead" — always true no matter what the app does. This
// statically scans the step model (no run needed) and flags assertions
// that are useless or weak, with a plain reason and a fix hint.
//
// It's the piece F5's trust score can't judge on its own: F5 COUNTS
// assertions; F6 tells you which of them are actually worth counting.
//
//   dead — always passes regardless of the app (e.g. contains "") → useless
//   weak — technically valid but low value (e.g. re-checking a value you
//          just typed, or "is visible" right after clicking the same thing)
// =====================================================================

export interface WeakAssertion {
  index: number // index in the steps array passed in
  severity: 'dead' | 'weak'
  reason: string // why it's weak + what it fails to prove
}

const INTERACTIONS = new Set(['click', 'type', 'select', 'hover', 'press'])

export function findWeakAssertions(steps: RecorderStep[]): WeakAssertion[] {
  const out: WeakAssertion[] = []
  steps.forEach((step, i) => {
    if (step.disabled || step.type !== 'assert') return
    const kind = step.assertKind ?? 'visible'
    const value = (step.value ?? '').trim()
    const prev = i > 0 ? steps[i - 1] : undefined

    // DEAD (F19): an AI check with no claim verifies nothing — there's nothing for
    // the model to judge (and it fails loudly at replay). The claim IS the check.
    if (kind === 'nl' && value === '') {
      out.push({
        index: i,
        severity: 'dead',
        reason:
          'This AI check has no claim, so it verifies nothing (and fails at replay). Type what the page should show, e.g. "an order confirmation number is shown".'
      })
      return
    }

    // DEAD: "contains empty string" is true for every element — verifies nothing.
    if ((kind === 'text-contains' || kind === 'class') && value === '') {
      out.push({
        index: i,
        severity: 'dead',
        reason: `"${kind === 'class' ? 'Has class' : 'Contains text'} — empty" is always true; it proves nothing. Enter the actual text/class to check.`
      })
      return
    }

    // DEAD: url-contains something present on literally any page.
    if (kind === 'url-contains' && (value === '' || /^(https?:?\/*|\/)$/i.test(value))) {
      out.push({
        index: i,
        severity: 'dead',
        reason: `URL contains "${value}" is true on any page — verifies nothing. Check a path unique to this screen (e.g. "/checkout").`
      })
      return
    }

    // WEAK: a valued check whose expected value was left empty (placeholder).
    if (['text-equals', 'value', 'attribute', 'count'].includes(kind) && value === '') {
      out.push({
        index: i,
        severity: 'weak',
        reason:
          'Expected value is empty — looks like a placeholder that checks nothing meaningful. Fill in what it should be.'
      })
      return
    }

    // WEAK: re-checking a value you just typed into the SAME field is circular —
    // it tests the input box echoing back, not the app's behaviour.
    if (
      kind === 'value' &&
      prev &&
      prev.type === 'type' &&
      prev.selector === step.selector &&
      (prev.value ?? '').trim() === value
    ) {
      out.push({
        index: i,
        severity: 'weak',
        reason:
          'Checks a field equals the value you just typed into it — circular; it tests the input, not the app. Assert an OUTCOME instead (a result, a message).'
      })
      return
    }

    // WEAK: "is visible" right after interacting with the SAME element — replay
    // already had to see it to click/type it, so the assert adds little.
    if (
      kind === 'visible' &&
      prev &&
      !prev.disabled &&
      INTERACTIONS.has(prev.type) &&
      prev.selector &&
      prev.selector === step.selector
    ) {
      out.push({
        index: i,
        severity: 'weak',
        reason:
          'Asserts an element is visible right after interacting with it — it already had to be visible to be clicked/typed, so this barely checks anything.'
      })
      return
    }
  })
  return out
}
