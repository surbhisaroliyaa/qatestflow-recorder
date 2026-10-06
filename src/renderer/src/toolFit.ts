// =====================================================================
// How many toolbar buttons fit on ONE line  (audit QF-007, "More ⋯" menu)
// =====================================================================
// Pure arithmetic, kept out of the component so it can be unit-tested without
// a DOM. The component measures a hidden, never-wrapping copy of the row and
// hands the numbers in here.
//
// Why "right edges" and not widths: the row has gaps between buttons and a
// divider before each group, so the room N buttons need is not a sum of their
// widths. In the measuring copy every button sits exactly where it would sit
// if the first N were shown, so the right edge of button N-1 IS the room the
// first N buttons need — gaps and dividers included, nothing re-derived.
// =====================================================================

export interface FitInput {
  /** Right edge of each button, in order, measured from the row's left edge. */
  rights: number[]
  /** Width the row actually has. */
  available: number
  /** The "More ⋯" control's own width (its divider/padding included). */
  moreWidth: number
  /** Space between the last shown button and the More control. */
  moreLead: number
}

/**
 * The number of buttons (from the left) to show. Everything after them goes
 * into the More menu — so the RIGHTMOST buttons overflow first and the order
 * is never shuffled. Returns `rights.length` when all of them fit, in which
 * case no More control is needed at all.
 */
export function fitCount({ rights, available, moreWidth, moreLead }: FitInput): number {
  const n = rights.length
  // Half a pixel of slack: sub-pixel widths otherwise flip a button in and out
  // of the menu as the window is dragged across the boundary.
  const room = available + 0.5
  if (n === 0 || rights[n - 1] <= room) return n
  // Something must overflow, so the More control needs room too.
  for (let k = n - 1; k > 0; k--) {
    if (rights[k - 1] + moreLead + moreWidth <= room) return k
  }
  return 0
}
