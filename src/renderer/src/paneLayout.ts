// =====================================================================
// THE STEP PANE'S WIDTH  (audit findings QF-007 / QF-008)
// =====================================================================
// The pane used to be a fixed 340 px: long values and selectors wrapped into
// narrow columns (QF-008), and on a small window it stole width the toolbar
// and page needed (QF-007). It is now resizable and collapsible; these are the
// rules for how far, kept pure so they can be tested without a window.
// =====================================================================

export const PANE_DEFAULT = 340
export const PANE_MIN = 280
/** The page must keep at least this much width, or recording on it stops
 *  being practical — the pane can't be dragged wider than that allows. */
export const PAGE_MIN = 480
/** Arrow-key step for the keyboard-resizable divider. */
export const PANE_KEY_STEP = 24

/** A width the pane may actually take in a window this wide. */
export function clampPaneWidth(width: number, windowWidth: number): number {
  const max = Math.max(PANE_MIN, windowWidth - PAGE_MIN)
  if (!Number.isFinite(width)) return Math.min(PANE_DEFAULT, max)
  return Math.round(Math.min(max, Math.max(PANE_MIN, width)))
}

/** Read a remembered width. Storage can be missing or throw (private mode,
 *  cleared data) — the pane must still open at a sensible size. */
export function readStoredPaneWidth(raw: string | null | undefined): number {
  const n = raw == null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PANE_DEFAULT
}
