// =====================================================================
// F40 — SHAREABLE LIBRARY BUNDLE
//
// Your test library is a folder on your machine. A teammate can't run it, and
// nobody can review a change to a test the way they'd review a change to code.
// A bundle is the portable form: a plain folder tree you can commit to git (so
// tests turn up in PRs, diffable) or zip and hand over.
//
// == What travels, and why (decided with Surbhi 2026-07-28) ==
//
// TRAVELS — because the tests are BROKEN without it:
//   tests/      the test JSON itself (secrets placeholdered, data rows scrubbed)
//   blocks/     a test with a 🧩 live-link step is broken without its block
//   uploads/    an upload step needs its actual file
//   acceptance-criteria.json   (F31) the team's shared definition of done
//
// DOES NOT TRAVEL — and each for a specific reason, not just size:
//   _sessions    a saved session IS a credential, and it expires anyway
//   environments F25 deliberately keeps these in userData; they hold secrets
//   _drafts      your unfinished work, not a shared artefact
//   _traces / _failures   83 MB of evidence from YOUR runs; means nothing to them
//   _baselines   a visual baseline is screen- and DPI-specific. Shipped, it
//                false-FAILS on a different monitor. Not shipped, their first
//                run creates one and passes — a false PASS. We chose the second
//                and then removed its sting by WARNING loudly on import, because
//                a visible false fail beats a silent false pass. The snapshot
//                SETTINGS (masks, threshold) do travel — those are portable.
//   run history / versions / trust scores
//                an F5 grade of "A" is computed from YOUR runs on YOUR machine.
//                Showing it to someone whose machine has never run the test is
//                the false-green problem F5 exists to prevent, reintroduced
//                through the back door. "New / untested" is the truth for them.
//   monitors     a schedule pinned to YOUR environments, firing YOUR webhook URL
// =====================================================================

import { mkdir, readFile, writeFile, readdir, copyFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { placeholderSecrets, scrubDataRows } from './secrets'
import { portableBasename } from '../shared/portablePath'

export const BUNDLE_VERSION = 1

export interface BundleManifest {
  bundleVersion: number
  createdAt: string
  testCount: number
  /** Tests whose secret values were replaced with {{env:PASSWORD}}. */
  secretsPlaceholdered: string[]
  /** Data columns that were scrubbed, per test. */
  dataScrubbed: { test: string; columns: string[] }[]
  /** Tests carrying a visual snapshot whose baseline was NOT shipped. */
  visualWithoutBaseline: string[]
  blocks: string[]
  uploads: string[]
  hasAcceptanceCriteria: boolean
}

export interface BundleExportResult {
  ok: boolean
  path?: string
  manifest?: BundleManifest
  error?: string
}

/** Steps that reference a live-link block, so its file travels too. */
export function blockRefsIn(steps: unknown[]): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(steps) ? steps : []) {
    const s = raw as Record<string, unknown>
    if (s?.type === 'block' && typeof s.blockRef === 'string') out.push(s.blockRef)
  }
  return out
}

/** An upload step's file paths. A multi-file pick is stored one path per line,
 *  so the value is a LIST — reading it as one path took the basename of the
 *  whole block, which is the last file's name, and shipped only that file. */
export function uploadPathsOf(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Upload steps' fixture files, so the exported test can actually run. */
export function uploadFilesIn(steps: unknown[]): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(steps) ? steps : []) {
    const s = raw as Record<string, unknown>
    // QF-005: the step's path was serialized by whichever OS RECORDED it, which
    // is not necessarily the one reading it now — so the separator rule can't
    // come from this platform's `basename`.
    if (s?.type !== 'upload') continue
    for (const p of uploadPathsOf(s.value)) {
      const base = portableBasename(p)
      if (base) out.push(base)
    }
  }
  return out
}

/**
 * Where an upload fixture recorded as `recorded` lives on THIS machine.
 *
 * The step stores an ABSOLUTE path — the copy in the recorder's own `_uploads`
 * folder (see copyIntoUploads in index.ts). That path is only true on the
 * machine that recorded it: `C:\Users\sam\Documents\…\invoice.pdf` means
 * nothing on a Mac, or to another Windows user, even when the same file sits in
 * THEIR `_uploads` because a bundle brought it. So: the recorded path if it
 * exists here, else the same-named file in this library's `_uploads`, else the
 * recorded path unchanged — the run then fails naming the file that is really
 * missing, which is the truth.
 */
export function localUploadPath(
  recorded: string,
  uploadsDir: string,
  exists: (p: string) => boolean = existsSync
): string {
  if (exists(recorded)) return recorded
  const base = portableBasename(recorded)
  const local = base ? join(uploadsDir, base) : ''
  return local && exists(local) ? local : recorded
}

/** Point every upload step's path(s) at this machine's copy. `nameFor` maps a
 *  fixture's basename to the name it was stored under here, when an import had
 *  to rename it to avoid overwriting a different local file of the same name. */
export function relinkUploads(
  steps: unknown[],
  uploadsDir: string,
  nameFor: (base: string) => string | undefined = () => undefined,
  exists: (p: string) => boolean = existsSync
): unknown[] {
  return (Array.isArray(steps) ? steps : []).map((raw) => {
    const s = raw as Record<string, unknown>
    if (s?.type !== 'upload' || typeof s.value !== 'string') return raw
    const value = uploadPathsOf(s.value)
      .map((p) => {
        const renamed = nameFor(portableBasename(p))
        return renamed ? join(uploadsDir, renamed) : localUploadPath(p, uploadsDir, exists)
      })
      .join('\n')
    return { ...s, value }
  })
}

/** Same bytes? Used to tell "this library already has that fixture" from "a
 *  DIFFERENT file happens to share its name" — the second must not be reused,
 *  or the imported test silently uploads the wrong file. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)])
  if (sa.size !== sb.size) return false
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
  return ba.equals(bb)
}

export function hasVisualStep(steps: unknown[]): boolean {
  return (Array.isArray(steps) ? steps : []).some(
    (raw) => (raw as Record<string, unknown>)?.type === 'snapshot'
  )
}

/**
 * Write a bundle folder.
 *
 * `tests` are the relative library paths to include (so "export selected" and
 * "export everything" are the same code path).
 */
export async function exportBundle(
  libraryPath: string,
  destDir: string,
  tests: string[],
  // F31 stores acceptance criteria as one text blob, one AC per line.
  acceptanceCriteria: string | null
): Promise<BundleExportResult> {
  try {
    await mkdir(join(destDir, 'tests'), { recursive: true })
    const manifest: BundleManifest = {
      bundleVersion: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      testCount: 0,
      secretsPlaceholdered: [],
      dataScrubbed: [],
      visualWithoutBaseline: [],
      blocks: [],
      uploads: [],
      hasAcceptanceCriteria: !!acceptanceCriteria?.trim()
    }
    const wantBlocks = new Set<string>()
    // fixture basename → the path the step recorded (the fallback source).
    const wantUploads = new Map<string, string>()

    for (const rel of tests) {
      const src = join(libraryPath, rel)
      if (!existsSync(src)) continue
      const data = JSON.parse(await readFile(src, 'utf-8')) as Record<string, unknown>
      const steps = (data.steps as unknown[]) ?? []

      const hadSecret = steps.some((raw) => (raw as Record<string, unknown>)?.secret === true)
      const safeSteps = placeholderSecrets(steps)
      if (hadSecret) manifest.secretsPlaceholdered.push(rel)

      const { rows, scrubbed } = scrubDataRows(
        data.dataRows as Record<string, string>[] | undefined
      )
      if (scrubbed.length) manifest.dataScrubbed.push({ test: rel, columns: scrubbed })

      if (hasVisualStep(steps)) manifest.visualWithoutBaseline.push(rel)
      for (const b of blockRefsIn(steps)) wantBlocks.add(b)
      for (const raw of steps) {
        const st = raw as Record<string, unknown>
        if (st?.type !== 'upload') continue
        for (const p of uploadPathsOf(st.value)) {
          const base = portableBasename(p)
          if (base && !wantUploads.has(base)) wantUploads.set(base, p)
        }
      }

      // Strip everything local: run history, versions, trust inputs, the
      // session reference, and the visual baseline ids (their baselines aren't
      // shipped, so a retained id would point at nothing).
      const portable: Record<string, unknown> = {
        version: data.version ?? 1,
        name: data.name,
        baseURL: data.baseURL,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        viewport: data.viewport,
        deviceId: data.deviceId, // F36
        tags: data.tags, // F38
        dataRows: rows.length ? rows : undefined,
        steps: safeSteps.map((raw) => {
          const s = { ...(raw as Record<string, unknown>) }
          delete s.baselineId // the image isn't in the bundle
          return s
        })
      }
      const outPath = join(destDir, 'tests', rel.replace(/[\\/]/g, '__'))
      await writeFile(outPath, JSON.stringify(portable, null, 2), 'utf-8')
      manifest.testCount++
    }

    // Blocks a shipped test links. Without these the 🧩 steps are dangling.
    if (wantBlocks.size) {
      await mkdir(join(destDir, 'blocks'), { recursive: true })
      for (const b of wantBlocks) {
        const src = join(libraryPath, '_blocks', b)
        if (!existsSync(src)) continue
        await copyFile(src, join(destDir, 'blocks', b))
        manifest.blocks.push(b)
      }
    }
    // Fixture files an upload step needs.
    if (wantUploads.size) {
      await mkdir(join(destDir, 'uploads'), { recursive: true })
      for (const [u, recorded] of wantUploads) {
        // The library's own copy first; failing that, the file the step points
        // at (recording falls back to the original when its copy fails, and a
        // hand-edited test can name any file) — else it would silently not ship.
        const src = localUploadPath(recorded, join(libraryPath, '_uploads'))
        if (!existsSync(src)) continue
        await copyFile(src, join(destDir, 'uploads', u))
        manifest.uploads.push(u)
      }
    }
    if (acceptanceCriteria?.trim()) {
      // Plain text, not JSON — it's a human-authored list, and a .txt in a git
      // repo diffs line by line the way a reviewer wants it to.
      await writeFile(join(destDir, 'acceptance-criteria.txt'), acceptanceCriteria, 'utf-8')
    }

    await writeFile(join(destDir, 'qaflow-bundle.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    await writeFile(join(destDir, 'README.md'), readmeFor(manifest), 'utf-8')
    return { ok: true, path: destDir, manifest }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** A human-readable note in the bundle, so it explains itself without the app. */
export function readmeFor(m: BundleManifest): string {
  const lines = [
    '# QATestFlow test bundle',
    '',
    `${m.testCount} test${m.testCount === 1 ? '' : 's'}, exported ${m.createdAt.slice(0, 10)}.`,
    '',
    '## How to use it',
    '',
    'Open QATestFlow → **📦 Import bundle** and pick this folder.',
    '',
    '## What is NOT in here, on purpose',
    '',
    '- **Passwords.** Secret fields carry `{{env:PASSWORD}}`. Set it in your own',
    '  environment (🌐 Run against → manage) before running those tests.',
    '- **Saved sessions.** A session file is a credential and expires — record your own.',
    '- **Run history and trust scores.** Those describe the exporter’s machine, not yours.',
    '  Every test arrives as "new / untested", which is the truth for you.'
  ]
  if (m.visualWithoutBaseline.length) {
    const n = m.visualWithoutBaseline.length
    // "1 test(s) here take" — this file is read by a colleague, and clumsy
    // pluralisation is exactly what a reviewer notices first.
    const subject = n === 1 ? '1 test here takes' : `${n} tests here take`
    lines.push(
      '- **Visual baselines.** A baseline is specific to the screen and pixel density it',
      '  was captured on, so a shared one would fail on your monitor for no real reason.',
      `  ${subject} a visual snapshot: your FIRST run creates your own baseline and will`,
      '  pass without comparing anything. The second run is the first one that actually',
      '  checks.'
    )
  }
  if (m.dataScrubbed.length) {
    lines.push('', '## Scrubbed data columns', '')
    for (const d of m.dataScrubbed) {
      lines.push(`- \`${d.test}\`: ${d.columns.join(', ')} → \`{{env:…}}\``)
    }
  }
  return lines.join('\n') + '\n'
}

// =====================================================================
// IMPORT
// =====================================================================

export interface BundleTestPreview {
  /** File name inside the bundle. */
  file: string
  name: string
  suite: string
  stepCount: number
  tags?: string[]
  /** An existing library test this would collide with (relative path). */
  collidesWith?: string
  existingStepCount?: number
  existingUpdatedAt?: string
}

export interface BundleInspection {
  ok: boolean
  manifest?: BundleManifest
  tests: BundleTestPreview[]
  error?: string
}

/** Read a bundle and work out what importing it WOULD do — no writes. */
export async function inspectBundle(
  bundleDir: string,
  libraryPath: string
): Promise<BundleInspection> {
  try {
    const manifestPath = join(bundleDir, 'qaflow-bundle.json')
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        tests: [],
        error: 'That folder isn’t a QATestFlow bundle (no qaflow-bundle.json in it).'
      }
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as BundleManifest
    if (manifest.bundleVersion > BUNDLE_VERSION) {
      return {
        ok: false,
        tests: [],
        error: `This bundle was made by a newer version of QATestFlow (format ${manifest.bundleVersion}, this app reads ${BUNDLE_VERSION}).`
      }
    }
    const testsDir = join(bundleDir, 'tests')
    const files = existsSync(testsDir)
      ? (await readdir(testsDir)).filter((f) => f.endsWith('.json'))
      : []
    const tests: BundleTestPreview[] = []
    for (const file of files) {
      const data = JSON.parse(await readFile(join(testsDir, file), 'utf-8')) as Record<
        string,
        unknown
      >
      // "E2E__login-flow.json" → suite "E2E", file "login-flow.json"
      const parts = file.split('__')
      const suite = parts.length > 1 ? parts[0] : ''
      const bare = parts.length > 1 ? parts.slice(1).join('__') : file
      const target = suite ? `${suite}/${bare}` : bare
      const preview: BundleTestPreview = {
        file,
        name: String(data.name ?? bare),
        suite,
        stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
        tags: data.tags as string[] | undefined
      }
      const existing = join(libraryPath, target)
      if (existsSync(existing)) {
        preview.collidesWith = target
        try {
          const cur = JSON.parse(await readFile(existing, 'utf-8')) as Record<string, unknown>
          preview.existingStepCount = Array.isArray(cur.steps) ? cur.steps.length : 0
          preview.existingUpdatedAt = String(cur.updatedAt ?? '')
        } catch {
          // unreadable existing file — still report the collision
        }
      }
      tests.push(preview)
    }
    return { ok: true, manifest, tests }
  } catch (e) {
    return { ok: false, tests: [], error: e instanceof Error ? e.message : String(e) }
  }
}

export type ImportChoice = 'keep-both' | 'overwrite' | 'skip'

export interface ImportPlanEntry {
  file: string
  choice: ImportChoice
}

export interface BundleImportResult {
  ok: boolean
  imported: number
  skipped: number
  overwritten: number
  keptBoth: number
  blocks: number
  uploads: number
  error?: string
}

/** Apply an import plan. Every collision decision is already made by the user. */
export async function importBundle(
  bundleDir: string,
  libraryPath: string,
  plan: ImportPlanEntry[]
): Promise<BundleImportResult> {
  const result: BundleImportResult = {
    ok: true,
    imported: 0,
    skipped: 0,
    overwritten: 0,
    keptBoth: 0,
    blocks: 0,
    uploads: 0
  }
  try {
    // Blocks and uploads are shared assets — copy any the bundle brought that
    // this library doesn't already have. Never overwrite: a local block of the
    // same name may already feed other tests (F7's blast radius).
    //
    // Done BEFORE the tests, because a test's upload paths are rewritten to
    // where its fixtures landed here — which is not known until they have.
    const uploadsDir = join(libraryPath, '_uploads')
    const uploadNames = new Map<string, string>() // bundle name → name in _uploads
    for (const [dir, store, key] of [
      ['blocks', '_blocks', 'blocks'],
      ['uploads', '_uploads', 'uploads']
    ] as const) {
      const from = join(bundleDir, dir)
      if (!existsSync(from)) continue
      await mkdir(join(libraryPath, store), { recursive: true })
      for (const f of await readdir(from)) {
        const s = await stat(join(from, f))
        if (!s.isFile()) continue
        let name = f
        if (existsSync(join(libraryPath, store, f))) {
          // A block keeps the local one (see above). An upload keeps it only
          // when it is the SAME file; a different `invoice.pdf` already here is
          // someone else's fixture, so the bundle's lands beside it under a
          // free name — the same -imported suffix a kept-both test gets.
          if (key === 'blocks' || (await sameFile(join(from, f), join(uploadsDir, f)))) {
            if (key === 'uploads') uploadNames.set(f, f)
            continue
          }
          const dot = f.lastIndexOf('.')
          const [stem, ext] = dot > 0 ? [f.slice(0, dot), f.slice(dot)] : [f, '']
          name = `${stem}-imported${ext}`
          for (let n = 2; existsSync(join(uploadsDir, name)); n++) {
            name = `${stem}-imported-${n}${ext}`
          }
        }
        await copyFile(join(from, f), join(libraryPath, store, name))
        if (key === 'uploads') uploadNames.set(f, name)
        result[key]++
      }
    }

    for (const entry of plan) {
      if (entry.choice === 'skip') {
        result.skipped++
        continue
      }
      const src = join(bundleDir, 'tests', entry.file)
      if (!existsSync(src)) continue
      const data = JSON.parse(await readFile(src, 'utf-8')) as Record<string, unknown>
      const parts = entry.file.split('__')
      const suite = parts.length > 1 ? parts[0] : ''
      let bare = parts.length > 1 ? parts.slice(1).join('__') : entry.file
      if (suite) await mkdir(join(libraryPath, suite), { recursive: true })

      if (entry.choice === 'keep-both') {
        // Find a free name rather than clobbering: login.json → login-imported.json,
        // then -imported-2, and so on.
        const stem = bare.replace(/\.json$/i, '')
        let candidate = `${stem}-imported.json`
        let n = 2
        while (existsSync(join(libraryPath, suite ? `${suite}/${candidate}` : candidate))) {
          candidate = `${stem}-imported-${n++}.json`
        }
        bare = candidate
        data.name = `${data.name} (imported)`
        result.keptBoth++
      } else {
        result.overwritten++
      }
      const target = suite ? join(libraryPath, suite, bare) : join(libraryPath, bare)
      // QF-005 follow-up: an upload step still names the EXPORTER's absolute
      // path (`C:\Users\sam\…\_uploads\invoice.pdf`). The fixture travelled and
      // now sits in this library's _uploads, but replay hands step.value
      // straight to the browser — so every upload failed on any machine but
      // the one that recorded it. Repoint each path at the copy that is here.
      if (Array.isArray(data.steps)) {
        data.steps = relinkUploads(data.steps, uploadsDir, (b) => uploadNames.get(b))
      }
      // An imported test has NO history on this machine — that's deliberate, and
      // it's why runs/versions/lastRun are absent here rather than zeroed.
      await writeFile(
        target,
        JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8'
      )
      result.imported++
    }
    return result
  } catch (e) {
    return { ...result, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
