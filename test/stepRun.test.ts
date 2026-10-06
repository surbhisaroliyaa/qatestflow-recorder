import { describe, it, expect } from 'vitest'
import { planStepRun } from '../src/renderer/src/stepRun'

// ▶ Run this step / ▶ Run from here pick a SLICE of the expanded run plan. A
// wrong slice is a silent lie — the row goes green having run a different step
// — so the boundaries are pinned here.

const s = (type: string, extra: Record<string, unknown> = {}): { type: string } =>
  ({ type, ...extra }) as { type: string }
const identity = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

describe('planStepRun — one step', () => {
  it('runs exactly the chosen row', () => {
    const flat = [s('navigate'), s('fill'), s('click')]
    expect(planStepRun(flat, identity(3), 1, 'one')).toEqual({
      ok: true,
      start: 1,
      end: 1,
      map: [1]
    })
  })

  it('a linked block row runs every step inside the block, mapped back to that row', () => {
    // display: 0 navigate, 1 block(3 inner steps), 2 click
    const flat = [s('navigate'), s('fill'), s('fill'), s('click'), s('click')]
    const map = [0, 1, 1, 1, 2]
    expect(planStepRun(flat, map, 1, 'one')).toEqual({
      ok: true,
      start: 1,
      end: 3,
      map: [1, 1, 1]
    })
  })

  it('an if row runs its whole block, else branch included', () => {
    const flat = [s('navigate'), s('if'), s('click'), s('else'), s('click'), s('endIf'), s('fill')]
    const plan = planStepRun(flat, identity(7), 1, 'one')
    expect(plan).toMatchObject({ ok: true, start: 1, end: 5 })
  })

  it('a repeat row runs through its endRepeat', () => {
    const flat = [s('repeat'), s('click'), s('endRepeat'), s('fill')]
    expect(planStepRun(flat, identity(4), 0, 'one')).toMatchObject({ ok: true, start: 0, end: 2 })
  })

  it('a plain step INSIDE a loop body can run on its own', () => {
    const flat = [s('repeat'), s('click'), s('endRepeat')]
    expect(planStepRun(flat, identity(3), 1, 'one')).toMatchObject({ ok: true, start: 1, end: 1 })
  })

  it('refuses a closing marker on its own', () => {
    const flat = [s('if'), s('click'), s('else'), s('click'), s('endIf')]
    for (const row of [2, 4]) {
      const plan = planStepRun(flat, identity(5), row, 'one')
      expect(plan.ok).toBe(false)
    }
  })

  it('refuses a disabled step', () => {
    const plan = planStepRun([s('click', { disabled: true })], [0], 0, 'one')
    expect(plan).toMatchObject({ ok: false })
    if (!plan.ok) expect(plan.reason).toMatch(/turned off/)
  })

  it('refuses a row that expanded to nothing (a disabled or empty block)', () => {
    // display row 1 is a disabled block — buildRunPlan emits nothing for it.
    const plan = planStepRun([s('navigate'), s('click')], [0, 2], 1, 'one')
    expect(plan.ok).toBe(false)
  })
})

describe('planStepRun — from here to the end', () => {
  it('runs from the chosen row to the last step', () => {
    const flat = [s('navigate'), s('fill'), s('click'), s('assert')]
    expect(planStepRun(flat, identity(4), 1, 'toEnd')).toEqual({
      ok: true,
      start: 1,
      end: 3,
      map: [1, 2, 3]
    })
  })

  it('keeps the display map for blocks later in the slice', () => {
    const flat = [s('navigate'), s('click'), s('fill'), s('fill'), s('click')]
    const map = [0, 1, 2, 2, 3]
    expect(planStepRun(flat, map, 1, 'toEnd')).toMatchObject({
      ok: true,
      start: 1,
      end: 4,
      map: [1, 2, 2, 3]
    })
  })

  it('refuses to start half-way through an if-block (the engine would refuse it too)', () => {
    const flat = [s('if'), s('click'), s('else'), s('click'), s('endIf'), s('fill')]
    const plan = planStepRun(flat, identity(6), 1, 'toEnd')
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(/inside a loop or if-block/)
  })

  it('starting ON the if row is fine', () => {
    const flat = [s('navigate'), s('if'), s('click'), s('endIf'), s('fill')]
    expect(planStepRun(flat, identity(5), 1, 'toEnd')).toMatchObject({ ok: true, start: 1, end: 4 })
  })
})
