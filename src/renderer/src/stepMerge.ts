// =====================================================================
// WHEN A RUN OF SCROLLS IS ONE ACTION  (Phase 4)
// =====================================================================
// Two scrolls in a row can mean two completely different things:
//
//   · READING DOWN A PAGE — wheel, read a paragraph, wheel again. The
//     intermediate positions are not something a test needs to reproduce, only
//     where the reader ended up. Kept separate, a long article fills the step
//     list with noise.
//   · AN INFINITE-SCROLL LIST — each scroll FETCHES the next page. Merged,
//     the test replays one load where the user did three, so it covers a third
//     of what it was recorded to cover.
//
// TIMING CANNOT TELL THESE APART. Both are "wheel, pause, wheel", and two
// attempts to guess from the length of the pause each broke one of the cases
// (Surbhi, Round 2a and its retest: first seventeen steps from one gesture,
// then one step from two gestures). So this uses a FACT instead of a guess —
// `loadedMore`, which the recorder sets when the page GREW during that scroll.
// That is precisely "this scroll loaded something".
//
// == Why this is its own module ==
//
// It used to be four lines inside a React effect, where the only thing that
// could test it was a browser test of the recorder — and that test asserted
// what the RECORDER emitted, one layer below where the merging happened. So it
// sat green while the app did the opposite of what its name claimed. A rule
// with two opposed failure modes needs to be directly testable, so it lives
// here and App.tsx calls it.
// =====================================================================

/** The bit of a step this decision looks at. Deliberately tiny — anything more
 *  would invite this rule to grow opinions about steps it has no business
 *  having opinions about. */
export interface MergeableStep {
  type: string
  /** Set by the recorder when the page grew during this scroll. */
  loadedMore?: boolean
  /** Which way this scroll went. */
  scrollDir?: 'up' | 'down'
}

/**
 * Should this newly recorded step REPLACE the one before it?
 *
 * True only when all of these hold:
 *   · both are scrolls, and adjacent — nothing happened in between;
 *   · neither loaded any content;
 *   · and they go the SAME WAY.
 *
 * That last one is what makes "merge" mean "continued", rather than merely
 * "happened next". Reading down a page is one direction from start to finish.
 * Scrolling down and then back up is two things: you went somewhere and came
 * back, and merging them throws away the fact you ever went down (Surbhi,
 * Round 2b Part 1).
 */
export function supersedesPrevious(
  previous: MergeableStep | undefined,
  step: MergeableStep
): boolean {
  if (step.type !== 'scroll') return false
  if (previous?.type !== 'scroll') return false
  // Either side having loaded content makes both worth keeping: the earlier one
  // because it fetched something, the later one because it is where we ended.
  if (step.loadedMore || previous.loadedMore) return false
  // A reversal is a new action. Steps recorded before direction was captured
  // have no `scrollDir` at all; those are treated as the same direction, which
  // is how they already behaved.
  if (step.scrollDir && previous.scrollDir && step.scrollDir !== previous.scrollDir) return false
  return true
}

/** Apply that decision to the step list. */
export function appendRecordedStep<T extends MergeableStep>(steps: T[], step: T): T[] {
  return supersedesPrevious(steps[steps.length - 1], step)
    ? [...steps.slice(0, -1), step]
    : [...steps, step]
}
