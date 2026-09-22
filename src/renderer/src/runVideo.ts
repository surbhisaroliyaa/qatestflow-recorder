// =====================================================================
// RUN VIDEO — the renderer half  (Phase 4)
// =====================================================================
// Main decides WHEN to record and whether to keep the result; the actual
// encoding happens here, because MediaRecorder only exists in a renderer.
// See src/main/video.ts for why it is done this way rather than with ffmpeg.
//
// Everything in this file fails soft. Screen capture can be refused by an OS
// permission, a group policy or a driver, and a test run that went red because
// the screen recorder didn't start would be a far worse bug than a run with no
// video attached to it.
// =====================================================================

/** The one recording that can be in flight at a time. A second replay cannot
 *  start while one is running, so a single slot is the honest model — and it
 *  means a stop that arrives with nothing recording is a no-op rather than an
 *  error. */
let active: {
  recorder: MediaRecorder
  chunks: Blob[]
  stream: MediaStream
  timer: number | null
} | null = null

/** MIME types in order of preference. VP9 is markedly smaller for the kind of
 *  content a test run produces (large flat areas that barely change), but it
 *  is not guaranteed, so the plain-webm fallback stays. */
const CODECS = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

function pickMimeType(): string | undefined {
  for (const type of CODECS) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      // isTypeSupported can throw on a malformed type string in some builds
    }
  }
  return undefined
}

/**
 * Start recording this window.
 *
 * Returns true if recording actually began. A false here is not an error to
 * report loudly — it means this run simply won't have a video.
 */
export async function startRunVideo(req: {
  sourceId: string
  maxMs: number
  fps: number
}): Promise<boolean> {
  if (active) return true // already recording this run
  try {
    // The chromeMediaSource constraints are Electron's desktop-capture form.
    // They are not in the standard MediaTrackConstraints type, hence the cast.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: req.sourceId,
          maxFrameRate: req.fps
        }
      }
    } as unknown as MediaStreamConstraints)

    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e): void => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    // A hard stop, so a hung run — exactly the kind someone turns video on to
    // investigate — cannot record until the machine runs out of memory.
    const timer = window.setTimeout(() => {
      try {
        if (active?.recorder.state === 'recording') active.recorder.stop()
      } catch {
        /* already stopped */
      }
    }, req.maxMs)

    active = { recorder, chunks, stream, timer }
    // A timeslice, so data arrives in chunks rather than one blob at the end:
    // if the app is killed mid-run, what was captured up to that point has
    // already left the encoder.
    recorder.start(1000)
    return true
  } catch {
    active = null
    return false
  }
}

/**
 * Stop recording and hand back the encoded bytes.
 *
 * Returns null when nothing was recording, or when the recording produced no
 * data — an empty video is worse than none, because the UI would offer it and
 * no player would open it.
 */
export async function stopRunVideo(): Promise<ArrayBuffer | null> {
  const current = active
  active = null
  if (!current) return null
  if (current.timer !== null) window.clearTimeout(current.timer)

  const done = new Promise<void>((resolve) => {
    current.recorder.onstop = (): void => resolve()
    // A recorder that is already inactive will never fire onstop, so resolve
    // immediately rather than hanging the end of the run waiting for it.
    if (current.recorder.state === 'inactive') resolve()
  })
  try {
    if (current.recorder.state === 'recording') current.recorder.stop()
  } catch {
    /* already stopped — `done` resolves via the inactive branch */
  }
  await done
  for (const track of current.stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* the track may already have ended with the stream */
    }
  }
  if (!current.chunks.length) return null
  const blob = new Blob(current.chunks, { type: current.chunks[0].type || 'video/webm' })
  if (blob.size === 0) return null
  return blob.arrayBuffer()
}

/** Abandon a recording without keeping anything — used when the policy says
 *  this run's video isn't wanted, so the bytes never leave the renderer. */
export function cancelRunVideo(): void {
  const current = active
  active = null
  if (!current) return
  if (current.timer !== null) window.clearTimeout(current.timer)
  try {
    if (current.recorder.state === 'recording') current.recorder.stop()
  } catch {
    /* nothing to stop */
  }
  for (const track of current.stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* already ended */
    }
  }
}
