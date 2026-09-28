/**
 * A deadline on photographing the page.
 *
 * `WebContents.capturePage()` returns a promise Chromium settles once a frame
 * has been composited. Nothing guarantees that it ever IS — and on 2026-09-23 it
 * wasn't. A replayed step failed, the red failure banner was painted into the
 * page, and the `await` on the very next line never came back. The consequences
 * ran well past the missing picture:
 *
 *   · no failure screenshot was written
 *   · no trace folder was created
 *   · the banner was never erased, so it stayed burnt onto the live page
 *   · `recorder:replay-paused` — the message that opens the recovery panel —
 *     sits seventy lines further down, and was never sent
 *
 * So one failed step killed the whole run with no way out, which is the exact
 * failure mode this app exists to prevent.
 *
 * A `try/catch` is no defence here: a promise that never settles never throws.
 * The only defence is a deadline.
 *
 * The rule is one the code beside it already followed. buildFailureMarkScript
 * (replay.ts) ends with a 400ms fallback whose comment reads "this must never
 * hang a run for a decoration" — and the capture that decoration existed for had
 * no such guard. A screenshot is EVIDENCE: worth having, never worth the run.
 *
 * Kept in its own module, away from `electron`, so the guarantee can actually be
 * tested — a hang is not a return value, and the only way to prove this is to
 * hand it a capture that never finishes and watch it give up anyway.
 */

/** Just the part of Electron's WebContents this needs — so a test can pass a stub. */
export interface CapturableContents {
  capturePage: () => Promise<CapturedImage>
}

/** Just the part of Electron's NativeImage callers use. Deliberately loose. */
export interface CapturedImage {
  toPNG: () => Buffer
  resize: (opts: { width: number }) => CapturedImage
}

/**
 * Photograph the page, giving up after `ms`.
 *
 * Returns `null` on a timeout OR on a throw — a caller wants a picture or
 * nothing, and "the page is gone" and "the page never painted" lead to the same
 * decision. Callers are expected to SAY that the picture is missing rather than
 * swallow it: a gap nobody can see is how this stayed mysterious in the first
 * place.
 *
 * The losing capture is not cancelled — Electron offers no way to — so it may
 * still settle later, into nothing. That costs a frame's worth of work and is
 * the price of not hanging; said here rather than left to be rediscovered.
 */
export async function capturePageWithin<T extends CapturedImage>(
  wc: { capturePage: () => Promise<T> },
  ms: number,
  sleep: (ms: number) => Promise<void> = (d) => new Promise((r) => setTimeout(r, d))
): Promise<T | null> {
  try {
    return await Promise.race([wc.capturePage(), sleep(ms).then(() => null)])
  } catch {
    // The page navigated away or the window closed. No picture, no drama — the
    // same outcome as a timeout, reached a different way.
    return null
  }
}
