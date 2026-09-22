// =====================================================================
// RUN VIDEO  (Phase 4, audit gap: "video artifact")
// =====================================================================
// WHAT IT IS
//
// A .webm recording of a replay, saved next to that run's trace. The trace's
// filmstrip already gives a screenshot per step, which answers "what did the
// page look like when step 7 ran". A video answers a different question, and
// it is the one that costs testers the most time: WHAT HAPPENED BETWEEN THE
// STEPS. A modal that flashed up and dismissed itself, an element that moved
// while it was being clicked, a redirect that bounced twice — none of those
// exist in any screenshot, because none of them are true at the moment a step
// starts or ends.
//
// == Why there is no ffmpeg here ==
//
// The obvious way to make a video is to collect frames and shell out to
// ffmpeg. This app is INSTALLED by people who are not developers; it cannot
// assume a binary on the PATH, and bundling one adds tens of megabytes to the
// installer plus its own CVE feed to the audit gate QF-006 left blocking.
//
// Chromium can already encode WebM. So the recording is done by the renderer,
// with MediaRecorder over a desktopCapturer stream of this window, and main
// only decides WHEN to record and WHETHER to keep the result. No new
// dependency, no binary, and the encoder is the same one the browser under
// test is running.
//
// == Why capture the WINDOW rather than just the page ==
//
// The page under test is a native view laid over the app's UI. Capturing only
// it would lose the step list scrolling alongside, which is most of what makes
// a run video readable — you can see which step was running as the page moved.
// Capturing the window gets both, and it is also what a person would have
// recorded by hand.
//
// == Failing soft, on purpose ==
//
// Screen capture can be refused: by an OS permission (macOS), by a policy, by
// a driver. Every failure path here ends in "no video", never in a failed run.
// A test run that went red because the camera didn't work would be a far worse
// bug than a missing video.
// =====================================================================

import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'

/** When to keep a run video. Deliberately the same three words as the trace
 *  policy — one idea, so one vocabulary. */
export type VideoMode = 'always' | 'failure' | 'off'

export interface VideoOptions {
  mode: VideoMode
}

/**
 * Does a run with this outcome get to keep its video?
 *
 * Pulled out as a pure function because it is the part with actual rules in
 * it, and because the rules are easy to get subtly wrong in a way no manual
 * test would catch — "retain on failure" quietly keeping every passing run's
 * video fills a user's disk with hundreds of megabytes of nothing, and the
 * inverse throws away the only recording of the failure they were chasing.
 */
export function shouldKeepVideo(
  mode: VideoMode,
  outcome: { ok: boolean; aborted?: boolean }
): boolean {
  if (mode === 'off') return false
  // An aborted run (the user pressed Home mid-pause) has no verdict, so there
  // is nothing to retain it FOR. Same rule the trace uses.
  if (outcome.aborted) return false
  if (mode === 'always') return true
  return !outcome.ok
}

/** The file one run's video lives in, inside that run's trace folder — so a
 *  video is deleted by the same prune that deletes the trace, and can never
 *  outlive the run it documents. */
export function videoPath(traceDir: string): string {
  return join(traceDir, 'run.webm')
}

/**
 * Write a finished recording into a run's trace folder.
 *
 * Returns the bare filename on success, or null on any failure — see "failing
 * soft" above. The caller is finishing a test run; nothing here is allowed to
 * throw into that path.
 */
export async function saveVideo(traceDir: string, data: Buffer): Promise<string | null> {
  // An empty recording is a failure wearing a success's clothes: MediaRecorder
  // produces zero bytes when the stream never started. Writing it would leave
  // a 0-byte run.webm that the UI would offer and no player would open.
  if (!data || data.length === 0) return null
  try {
    await mkdir(traceDir, { recursive: true })
    await writeFile(videoPath(traceDir), data)
    return 'run.webm'
  } catch {
    return null
  }
}

/** Drop a video we recorded but the policy says not to keep. */
export async function discardVideo(traceDir: string): Promise<void> {
  try {
    await rm(videoPath(traceDir), { force: true })
  } catch {
    // Nothing to remove, or a locked file — either way the run is over and
    // the trace prune will collect the folder eventually.
  }
}

/**
 * The recording instruction sent to the renderer.
 *
 * `maxMs` is a hard stop. Without one, a run that hangs — which is exactly the
 * kind of run someone turns video on to investigate — records until the
 * machine runs out of memory, because MediaRecorder buffers in RAM until it is
 * asked to stop. Ten minutes at this bitrate is tens of megabytes, which is a
 * cost worth paying; unbounded is not.
 */
export interface VideoRequest {
  sourceId: string
  maxMs: number
  /** Frames per second. Low on purpose: a test run is mostly a still page, and
   *  the thing being looked for (a flash, a bounce, a shift) is perfectly
   *  visible at this rate while the file stays small enough to attach to a
   *  bug report. */
  fps: number
}

export const VIDEO_DEFAULTS = { maxMs: 10 * 60 * 1000, fps: 10 }
