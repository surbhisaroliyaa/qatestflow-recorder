import { describe, expect, it } from 'vitest'
import { fitCount } from '../src/renderer/src/toolFit'

// QF-007 "More ⋯": how many toolbar buttons stay in the row. The DOM side
// (measuring, the menu itself) is covered by test-dom/compact-layout.spec.ts.

// Five 100-px buttons with 10 px gaps: right edges 100, 210, 320, 430, 540.
const rights = [100, 210, 320, 430, 540]
const more = { moreWidth: 80, moreLead: 10 }

describe('fitCount', () => {
  it('shows everything — and so no More button — when it all fits', () => {
    expect(fitCount({ rights, available: 540, ...more })).toBe(5)
    expect(fitCount({ rights, available: 2000, ...more })).toBe(5)
  })

  it('leaves room for the More button once anything overflows', () => {
    // 539 px: the last button misses by 1 px. Four buttons + More need
    // 430 + 10 + 80 = 520 — fits.
    expect(fitCount({ rights, available: 539, ...more })).toBe(4)
    // 519 px: four + More no longer fit, three + More (320 + 90 = 410) do.
    expect(fitCount({ rights, available: 519, ...more })).toBe(3)
  })

  it('overflows the RIGHTMOST buttons first, one at a time', () => {
    const counts = [540, 520, 410, 300, 190, 80].map((w) =>
      fitCount({ rights, available: w, ...more })
    )
    expect(counts).toEqual([5, 4, 3, 2, 1, 0])
  })

  it('tolerates sub-pixel widths at the boundary', () => {
    expect(fitCount({ rights: [100, 210.4], available: 210, ...more })).toBe(2)
  })

  it('handles an empty row', () => {
    expect(fitCount({ rights: [], available: 10, ...more })).toBe(0)
  })
})
