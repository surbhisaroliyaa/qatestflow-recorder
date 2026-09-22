// =====================================================================
// VIDEO POLICY  (Phase 4 follow-up, 2026-09-22)
// =====================================================================
// A run's video is written INSIDE that run's trace folder, so that one prune
// deletes both and a video can never outlive the run it documents. That is a
// good rule, but it has a consequence that is invisible from the toolbar:
//
//   ⏺ on failure  +  🎬 always  +  a run that PASSES  =  no video.
//
// The trace policy kept nothing, so there was no folder to write the .webm
// into. The recording ran, the bytes came back, and they were dropped. From
// the outside that looks exactly like a broken feature — Surbhi reported it as
// one, which is the correct reaction to a setting that says "always" and means
// "sometimes".
//
// So the two policies are resolved into the one that will actually happen,
// here, in a pure function both the toolbar and the run path call. The toolbar
// then shows what will happen rather than what was asked for, and the run is
// told the same thing — one answer, not two that can disagree.
// =====================================================================

export type RetainMode = 'always' | 'failure' | 'off'

/**
 * What the video policy RESOLVES to, given the trace policy in force.
 *
 * - No trace at all: no video, because there is nowhere to put one.
 * - An on-failure trace: 'always' is not achievable, so it resolves to the
 *   nearest thing that is — a video on the runs that keep a trace.
 * - Otherwise the video policy stands as asked.
 *
 * Deliberately NOT written back into the stored setting. Resolving on read
 * means the user's 'always' survives a detour through an on-failure trace and
 * comes back when they choose ⏺ always again, instead of being silently
 * downgraded on disk and needing to be set a second time.
 */
export function resolveVideoMode(trace: RetainMode, video: RetainMode): RetainMode {
  if (trace === 'off') return 'off'
  if (trace === 'failure' && video === 'always') return 'failure'
  return video
}
