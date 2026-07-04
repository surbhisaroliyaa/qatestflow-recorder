// =====================================================================
// TRACE RECORDER (Day 18)
// A Playwright-style run "trace": during replay we capture, for every
// step, a screenshot (+ a small thumbnail for the filmstrip), a DOM
// snapshot, and that step's console/network — then bundle it per run.
// Like Playwright's `trace: 'retain-on-failure'`, the caller decides
// whether to keep it (always / only on failure / never).
//
// Storage: one folder per run under the library — `_traces/<id>/` with
// the image/HTML assets plus a `trace.json` manifest the viewer reads.
// =====================================================================
import { join } from 'path'
import { mkdir, writeFile, readFile, rm, readdir } from 'fs/promises'
import { libraryDir } from './library'

// One recorded step in a trace. `text` is the human sentence (computed by
// the renderer and handed in, so the trace is self-contained). Asset file
// names are relative to the trace folder; absent when capture failed.
export interface TraceStepRecord {
  index: number
  type: string
  text: string
  // 'pending' = a step that never ran (the run stopped before reaching it).
  status: 'done' | 'error' | 'skipped' | 'pending'
  durationMs: number
  error?: string
  url?: string // the page URL when the step ran (for the DOM snapshot's <base>)
  screenshotFile?: string
  thumbFile?: string
  domFile?: string
  consoleErrors: string[]
  networkErrors: string[]
}

export interface TraceManifest {
  id: string
  testName?: string
  at: string // ISO timestamp
  ok: boolean
  failedAt?: number
  stepCount: number
  steps: TraceStepRecord[]
}

export function tracesDir(): string {
  return join(libraryDir(), '_traces')
}

export function traceDir(id: string): string {
  return join(tracesDir(), id)
}

// An id can only be one of our own folder names — never a path. Guards the
// IPC that opens trace files from being pointed outside the traces folder.
export function isSafeTraceId(id: string): boolean {
  return /^trace-[a-zA-Z0-9_-]+$/.test(id)
}

// Persist a trace: write every asset, then the manifest last (so a reader
// that finds trace.json knows the assets are already there).
export async function saveTrace(
  manifest: TraceManifest,
  assets: { file: string; data: Buffer }[]
): Promise<string> {
  const dir = traceDir(manifest.id)
  await mkdir(dir, { recursive: true })
  for (const a of assets) {
    await writeFile(join(dir, a.file), a.data)
  }
  await writeFile(join(dir, 'trace.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return dir
}

export async function loadTrace(id: string): Promise<TraceManifest | null> {
  if (!isSafeTraceId(id)) return null
  try {
    const raw = await readFile(join(traceDir(id), 'trace.json'), 'utf-8')
    return JSON.parse(raw) as TraceManifest
  } catch {
    return null
  }
}

// Read one trace asset (screenshot / thumbnail / DOM html) as a Buffer.
export async function readTraceAsset(id: string, file: string): Promise<Buffer | null> {
  if (!isSafeTraceId(id)) return null
  // Asset names are simple `step-3.png` style — refuse anything with a path.
  if (!/^[a-zA-Z0-9_.-]+$/.test(file)) return null
  try {
    return await readFile(join(traceDir(id), file))
  } catch {
    return null
  }
}

// Remove a trace (e.g. a pause-time trace whose run later recovered to a pass
// under the retain-on-failure policy).
export async function deleteTrace(id: string): Promise<void> {
  if (!isSafeTraceId(id)) return
  try {
    await rm(traceDir(id), { recursive: true, force: true })
  } catch {
    // already gone — fine
  }
}

// Build a STANDALONE HTML report for an exported recording (like Playwright's
// trace report): a self-contained index.html that references the sibling
// step-N.png / step-N.html files, so double-clicking it opens the whole run
// in any browser — filmstrip on the left, the selected step's screenshot +
// console/network on the right. No server, no app needed.
export function generateTraceHtml(
  manifest: TraceManifest,
  // filename -> data: URL. When provided, the report EMBEDS images/HTML so the
  // saved file is fully self-contained (one index.html, no loose assets).
  assets: Record<string, string> = {}
): string {
  // Inline the manifest as data (file:// can't fetch JSON), stripping any
  // inlined thumbnails — the report resolves assets from ASSETS by filename.
  const data = {
    ...manifest,
    steps: manifest.steps.map((s) => {
      const copy: TraceStepRecord & { thumbData?: string } = { ...s }
      delete copy.thumbData
      return copy
    })
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const assetsJson = JSON.stringify(assets).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Run recording${manifest.testName ? ' — ' + escapeHtml(manifest.testName) : ''}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, sans-serif; background:#1b1b1f; color:#ddd; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:#232329; border-bottom:1px solid #333; }
  header .title { font-weight:700; }
  header .res-ok { color:#5bd17e; font-weight:600; }
  header .res-fail { color:#ff7b72; font-weight:600; }
  header .when { color:#888; font-size:12px; margin-left:auto; }
  main { display:flex; height: calc(100vh - 44px); }
  .steps { width:320px; overflow-y:auto; border-right:1px solid #2c2c33; background:#18181c; padding:8px; }
  .step { display:flex; align-items:center; gap:8px; padding:6px; border-radius:7px; cursor:pointer; border:1px solid transparent; }
  .step:hover { background:#23232a; }
  .step.active { background:#26303d; border-color:#3d6ea5; }
  .step.pending { opacity:.55; }
  .step.skipped { opacity:.72; }
  .step .num { width:22px; text-align:right; color:#888; font-size:11px; }
  .step img, .step .nothumb { width:64px; height:40px; object-fit:cover; object-position:top left; border-radius:4px; border:1px solid #333; background:#000; }
  .step .txt { flex:1; min-width:0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step .dot { width:8px; height:8px; border-radius:50%; background:#6e7681; }
  .dot.done { background:#3fb950; } .dot.error { background:#f85149; } .dot.skipped { background:#d9a23b; } .dot.pending { background:#4a4a52; }
  .preview { flex:1; overflow-y:auto; padding:16px; }
  .preview h2 { font-size:15px; margin:0 0 4px; }
  .preview .meta { color:#888; font-size:12px; margin-bottom:12px; }
  .preview .err { background:#241317; border:1px solid #5a2a2a; color:#ffb3ae; padding:8px 10px; border-radius:7px; margin-bottom:12px; font-size:13px; }
  .preview img.shot { width:100%; border:1px solid #333; border-radius:8px; background:#0d0d10; }
  .ev { background:#1e1e24; border:1px solid #2e2e36; border-radius:7px; padding:8px 10px; margin-top:12px; }
  .ev .lbl { color:#9aa4b2; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px; }
  .ev .line { font-family: Consolas, monospace; font-size:11px; color:#d0a0a0; word-break:break-word; }
  .preview .links a { color:#79b8ff; font-size:12px; margin-right:14px; }
  .empty { color:#777; padding:24px; }
</style>
</head>
<body>
<header>
  <span class="title">⏺ Run recording${manifest.testName ? ' — ' + escapeHtml(manifest.testName) : ''}</span>
  <span class="${manifest.ok ? 'res-ok' : 'res-fail'}">${manifest.ok ? '✓ passed' : '✗ failed'}</span>
  <span class="when">${new Date(manifest.at).toLocaleString()}</span>
</header>
<main>
  <div class="steps" id="steps"></div>
  <div class="preview" id="preview"></div>
</main>
<script>
  const TRACE = ${json};
  const ASSETS = ${assetsJson};
  const src = (f) => (f && ASSETS[f]) || f || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  let sel = Math.max(0, TRACE.steps.findIndex(s => s.status === 'error'));
  function renderSteps() {
    document.getElementById('steps').innerHTML = TRACE.steps.map((s, i) =>
      '<div class="step ' + s.status + (i === sel ? ' active' : '') + '" onclick="select(' + i + ')">' +
        '<span class="num">' + (s.index + 1) + '</span>' +
        (s.thumbFile ? '<img src="' + src(s.thumbFile) + '">' : '<span class="nothumb"></span>') +
        '<span class="txt">' + esc(s.text) + '</span>' +
        '<span class="dot ' + s.status + '"></span>' +
      '</div>'
    ).join('');
  }
  function renderPreview() {
    const s = TRACE.steps[sel];
    if (!s) { document.getElementById('preview').innerHTML = ''; return; }
    let html = '<h2>Step ' + (s.index + 1) + ': ' + esc(s.text) + '</h2>' +
      '<div class="meta">' + s.durationMs + ' ms · ' + s.status + (s.url ? ' · ' + esc(s.url) : '') + '</div>';
    if (s.error) html += '<div class="err">' + esc(s.error) + '</div>';
    if (s.screenshotFile) html += '<img class="shot" src="' + src(s.screenshotFile) + '">';
    else html += '<div class="empty">' + (s.status === 'pending' ? "This step didn't run — the run stopped before reaching it." : s.status === 'skipped' ? 'This step was skipped — it did not run.' : 'No screenshot for this step') + '</div>';
    for (const [lbl, arr] of [['Console', s.consoleErrors], ['Network', s.networkErrors]]) {
      if (arr && arr.length) html += '<div class="ev"><div class="lbl">' + lbl + '</div>' + arr.map(l => '<div class="line">' + esc(l) + '</div>').join('') + '</div>';
    }
    const links = [];
    if (s.screenshotFile) links.push('<a href="' + src(s.screenshotFile) + '" target="_blank">Open full image</a>');
    if (s.domFile) links.push('<a href="' + src(s.domFile) + '" target="_blank">Open page HTML</a>');
    if (links.length) html += '<div class="links" style="margin-top:12px">' + links.join('') + '</div>';
    document.getElementById('preview').innerHTML = html;
  }
  function select(i) { sel = i; renderSteps(); renderPreview(); }
  renderSteps(); renderPreview();
</script>
</body>
</html>
`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

// Keep the traces folder from growing forever — drop the oldest beyond a cap.
// Folder names sort lexicographically by their trace-<timestamp> id, so the
// smallest names are the oldest.
export async function pruneTraces(keep = 40): Promise<void> {
  try {
    const entries = (await readdir(tracesDir())).filter(isSafeTraceId).sort()
    const excess = entries.slice(0, Math.max(0, entries.length - keep))
    for (const id of excess) {
      await rm(traceDir(id), { recursive: true, force: true })
    }
  } catch {
    // no traces dir yet, or a transient FS error — nothing to prune
  }
}
