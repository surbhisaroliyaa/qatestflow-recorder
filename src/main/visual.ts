// =====================================================================
// VISUAL REGRESSION (Day 19)
// A "snapshot" step captures a BASELINE image of the page; every replay
// re-captures and pixel-diffs against that baseline. This catches VISUAL
// regressions the behavioural checks are blind to — a working-but-broken
// layout, a recoloured button, a shifted element.
//
// No external diff library: Electron's NativeImage gives us the raw BGRA
// bitmap (toBitmap) and can rebuild an image from one (createFromBitmap),
// so we compare pixels and draw the diff ourselves.
// =====================================================================
import { nativeImage, type NativeImage } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { libraryDir } from './library'

export function baselinesDir(): string {
  return join(libraryDir(), '_baselines')
}

// Ids are our own `snap-<ts>` names — never a path. Guards the IPC that
// reads/serves baseline files from being pointed outside the folder.
export function isSafeBaselineId(id: string): boolean {
  return /^snap-[a-zA-Z0-9_-]+$/.test(id)
}

function baselinePath(id: string): string {
  return join(baselinesDir(), `${id}.png`)
}

export async function saveBaseline(id: string, png: Buffer): Promise<void> {
  if (!isSafeBaselineId(id)) return
  await mkdir(baselinesDir(), { recursive: true })
  await writeFile(baselinePath(id), png)
}

export async function loadBaseline(id: string): Promise<Buffer | null> {
  if (!isSafeBaselineId(id)) return null
  try {
    return await readFile(baselinePath(id))
  } catch {
    return null
  }
}

export async function deleteBaseline(id: string): Promise<void> {
  if (!isSafeBaselineId(id)) return
  try {
    await rm(baselinePath(id), { force: true })
  } catch {
    // already gone — fine
  }
}

export interface DiffResult {
  // Fraction of pixels that differ (0–1). 1 when the dimensions don't match.
  ratio: number
  // The baseline and the current capture were different SIZES — always a fail
  // (the page/viewport changed shape), and we can't pixel-diff across sizes.
  sizeMismatch?: boolean
  baseSize?: { width: number; height: number }
  curSize?: { width: number; height: number }
  // A PNG visualising the difference: changed pixels bright red over a dimmed
  // copy of the current capture. Absent on a size mismatch.
  diffPng?: Buffer
}

// Compare a stored baseline PNG against a fresh capture. A pixel "differs"
// when its biggest channel change exceeds `colorTol` (ignores sub-perceptual
// noise + light anti-aliasing). Returns the changed ratio + a diff image.
export function diffImages(
  baselinePng: Buffer,
  current: NativeImage,
  colorTol = 24
): DiffResult {
  const base = nativeImage.createFromBuffer(baselinePng)
  const bSize = base.getSize()
  const cSize = current.getSize()
  if (bSize.width !== cSize.width || bSize.height !== cSize.height) {
    return { ratio: 1, sizeMismatch: true, baseSize: bSize, curSize: cSize }
  }
  const b = base.toBitmap() // BGRA
  const c = current.toBitmap()
  const { width, height } = cSize
  const total = width * height || 1
  const diff = Buffer.alloc(c.length)
  let changed = 0
  for (let i = 0; i < c.length; i += 4) {
    const db = Math.abs(b[i] - c[i])
    const dg = Math.abs(b[i + 1] - c[i + 1])
    const dr = Math.abs(b[i + 2] - c[i + 2])
    if (Math.max(db, dg, dr) > colorTol) {
      changed++
      diff[i] = 0 // B
      diff[i + 1] = 0 // G
      diff[i + 2] = 255 // R — highlight the change
      diff[i + 3] = 255
    } else {
      // Dimmed greyscale of the current pixel, so the red pops.
      const grey = (((c[i] + c[i + 1] + c[i + 2]) / 3) * 0.35) | 0
      diff[i] = grey
      diff[i + 1] = grey
      diff[i + 2] = grey
      diff[i + 3] = 255
    }
  }
  return {
    ratio: changed / total,
    diffPng: nativeImage.createFromBitmap(diff, { width, height }).toPNG()
  }
}
