import { describe, it, expect } from 'vitest'
import { migrateLegacyCheckSteps, type LegacyStep } from '../src/shared/legacyCheckSteps'

// =====================================================================
// Repairing checkbox steps recorded before the QF-001 fix.
//
// The risk in a migration is never the case it was written for — it is
// everything ELSE in the file that it must leave completely alone. So the
// "doesn't touch" cases below matter more than the "converts" ones.
// =====================================================================

const step = (o: Partial<LegacyStep>): LegacyStep => ({ type: 'click', ...o }) as LegacyStep

describe('migrating pre-fix checkbox recordings', () => {
  it('collapses the click + type "on" pair into one check step', () => {
    const { steps, migrated } = migrateLegacyCheckSteps([
      step({ type: 'navigate', value: undefined }),
      step({ type: 'click', selector: "getByTestId('terms')", label: 'I agree' }),
      step({ type: 'type', selector: "getByTestId('terms')", label: 'I agree', value: 'on' })
    ])

    expect(migrated).toBe(1)
    expect(steps).toHaveLength(2)
    expect(steps[1]).toMatchObject({
      type: 'check',
      value: 'true',
      selector: "getByTestId('terms')",
      label: 'I agree'
    })
  })

  it('converts a lone type "on" — the keyboard Space toggle, which had no click', () => {
    const { steps, migrated } = migrateLegacyCheckSteps([
      step({ type: 'type', selector: "getByTestId('terms')", value: 'on' })
    ])
    expect(migrated).toBe(1)
    expect(steps[0].type).toBe('check')
    expect(steps[0].value).toBe('true')
  })

  it('keeps a click that targets a DIFFERENT element', () => {
    // Only the click belonging to this tick is the duplicate. Discarding an
    // unrelated preceding click would silently delete a real interaction.
    const { steps } = migrateLegacyCheckSteps([
      step({ type: 'click', selector: "getByText('Open form')", label: 'Open form' }),
      step({ type: 'type', selector: "getByTestId('terms')", label: 'I agree', value: 'on' })
    ])
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ type: 'click', label: 'Open form' })
    expect(steps[1].type).toBe('check')
  })

  it('keeps a click on the same selector in a DIFFERENT tab', () => {
    const { steps } = migrateLegacyCheckSteps([
      step({ type: 'click', selector: "getByTestId('terms')", label: 'I agree', windowId: 0 }),
      step({
        type: 'type',
        selector: "getByTestId('terms')",
        label: 'I agree',
        value: 'on',
        windowId: 1
      })
    ])
    expect(steps).toHaveLength(2)
  })

  it('leaves ordinary typing completely alone', () => {
    const original = [
      step({ type: 'click', selector: "getByTestId('username')", label: 'Username' }),
      step({
        type: 'type',
        selector: "getByTestId('username')",
        label: 'Username',
        value: 'standard_user'
      })
    ]
    const { steps, migrated } = migrateLegacyCheckSteps(original)
    expect(migrated).toBe(0)
    expect(steps).toEqual(original)
  })

  it('never touches a password step', () => {
    // A secret step carries a ref, not a literal — it can't be the legacy shape,
    // and rewriting one would strip the masking.
    const { migrated } = migrateLegacyCheckSteps([
      step({ type: 'type', selector: "getByTestId('password')", value: 'on', secret: true })
    ])
    expect(migrated).toBe(0)
  })

  it('leaves a value that merely CONTAINS "on" alone', () => {
    const { migrated } = migrateLegacyCheckSteps([
      step({ type: 'type', selector: "getByTestId('city')", value: 'London' }),
      step({ type: 'type', selector: "getByTestId('note')", value: ' on ' })
    ])
    expect(migrated).toBe(0)
  })

  it('is a no-op on an already-migrated test, however many times it runs', () => {
    const once = migrateLegacyCheckSteps([
      step({ type: 'click', selector: "getByTestId('terms')", label: 'I agree' }),
      step({ type: 'type', selector: "getByTestId('terms')", label: 'I agree', value: 'on' })
    ])
    const twice = migrateLegacyCheckSteps(once.steps)
    const thrice = migrateLegacyCheckSteps(twice.steps)

    expect(twice.migrated).toBe(0)
    expect(thrice.migrated).toBe(0)
    expect(thrice.steps).toEqual(once.steps)
  })

  it('does not modify the array it was given', () => {
    const original = [
      step({ type: 'click', selector: "getByTestId('terms')" }),
      step({ type: 'type', selector: "getByTestId('terms')", value: 'on' })
    ]
    const copy = JSON.parse(JSON.stringify(original))
    migrateLegacyCheckSteps(original)
    expect(original).toEqual(copy)
  })

  it('carries the rest of the step across untouched', () => {
    // A migrated step keeps its selector ladder, its frame, its optional flag —
    // everything that makes it replayable. Losing candidates here would turn a
    // self-healing step into a brittle one.
    const { steps } = migrateLegacyCheckSteps([
      step({
        type: 'type',
        selector: "getByTestId('terms')",
        label: 'I agree',
        value: 'on',
        optional: true,
        candidates: [{ kind: 'testId', locator: "getByTestId('terms')" }],
        frame: [{ url: 'https://example.com/form' }]
      })
    ])
    expect(steps[0]).toMatchObject({
      type: 'check',
      optional: true,
      candidates: [{ kind: 'testId', locator: "getByTestId('terms')" }],
      frame: [{ url: 'https://example.com/form' }]
    })
  })

  it('handles several checkboxes in one test', () => {
    const { migrated, steps } = migrateLegacyCheckSteps([
      step({ type: 'click', selector: "getByTestId('a')", label: 'A' }),
      step({ type: 'type', selector: "getByTestId('a')", label: 'A', value: 'on' }),
      step({ type: 'click', selector: "getByTestId('b')", label: 'B' }),
      step({ type: 'type', selector: "getByTestId('b')", label: 'B', value: 'on' }),
      step({ type: 'click', selector: "getByText('Submit')", label: 'Submit' })
    ])
    expect(migrated).toBe(2)
    expect(steps.map((s) => s.type)).toEqual(['check', 'check', 'click'])
  })

  it('survives an empty test', () => {
    expect(migrateLegacyCheckSteps([])).toEqual({ steps: [], migrated: 0 })
  })
})
