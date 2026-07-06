// =====================================================================
// F8 — GREEN BASELINE STORE
// One snapshot-per-step of the page as it looked the last time a test ran
// GREEN, kept per test so a later failure can be diffed against "how it looked
// when it worked". Separate from the run traces (which are pruned / retain-on-
// failure) — this is the durable "last good" reference.
// Keyed by a slug of the test name; unsaved recordings (no name) get no baseline.
// =====================================================================
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { libraryDir, slugify } from './library'
import type { PageSnapshot } from './domDiff'

// F4 (self-heal 2.0): what the step's TARGET element looked like on the green
// run — its normalised position (rect as 0–1 fractions of the viewport) and a
// small pixel crop (base64 PNG). A later failure heals against these ("it was
// here, it looked like this"), not just the recorded name.
export interface ElementFingerprint {
  rect?: { x: number; y: number; w: number; h: number } // 0–1 of the viewport
  crop?: string // base64 PNG, canonically sized (see visual.toCropPng)
}

export interface Baseline {
  testName: string
  at: string // ISO time this green baseline was captured
  steps: Record<number, PageSnapshot> // page state going INTO each step index
  // F4: per-step target-element fingerprint (position + crop). Optional +
  // sparse — only healable element steps whose element we could locate get one.
  elements?: Record<number, ElementFingerprint>
}

function baselinesDir(): string {
  return join(libraryDir(), '_baselines')
}

// A test name → a safe file key. Null when there's nothing stable to key on.
export function baselineKeyFor(testName?: string): string | null {
  const s = (testName || '').trim()
  if (!s) return null
  const slug = slugify(s)
  return slug || null
}

export async function saveBaseline(key: string, b: Baseline): Promise<void> {
  try {
    await mkdir(baselinesDir(), { recursive: true })
    await writeFile(join(baselinesDir(), `${key}.json`), JSON.stringify(b), 'utf-8')
  } catch {
    // a baseline is best-effort evidence — never let it break a run
  }
}

export async function loadBaseline(key: string): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(join(baselinesDir(), `${key}.json`), 'utf-8')) as Baseline
  } catch {
    return null
  }
}
