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

// F11: SHAREABLE RUN REPORT — a different artifact from generateTraceHtml above.
// Where the trace viewer is a two-pane *debugging* tool (click each step), this
// is a single top-to-bottom *report* you hand to a dev or PM: a PASS/FAIL
// verdict, a summary, the failure front-and-centre, then every step with its
// timing and evidence. Light theme, self-contained (screenshots embedded as
// data: URLs), and print-clean (prints/saves-to-PDF with all evidence open).
export function generateReportHtml(
  manifest: TraceManifest,
  // filename -> data: URL for embedded screenshots (same map shape as the trace
  // export). The report only references screenshotFile, so the caller need only
  // embed those (smaller file than the full trace).
  assets: Record<string, string> = {}
): string {
  const esc = escapeHtml
  const src = (f?: string): string => (f && assets[f]) || f || ''
  const steps = manifest.steps

  // Tally outcomes for the summary tiles.
  const count = (st: string): number => steps.filter((s) => s.status === st).length
  const passed = count('done')
  const failed = count('error')
  const skipped = count('skipped')
  const pending = count('pending')
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs || 0), 0)
  const maxMs = Math.max(1, ...steps.map((s) => s.durationMs || 0))
  const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's' : ms + 'ms')

  // The failing step (manifest.failedAt is the authoritative index; fall back to
  // the first errored step) — this is what the failure callout is built around.
  const failIdx =
    manifest.failedAt != null
      ? steps.findIndex((s) => s.index === manifest.failedAt)
      : steps.findIndex((s) => s.status === 'error')
  const failStep = failIdx >= 0 ? steps[failIdx] : undefined

  // Environment = the origin of the first step that has a URL. Best-effort — the
  // trace stores per-step URLs, not a single baseURL.
  let env = ''
  for (const s of steps) {
    if (s.url) {
      try {
        env = new URL(s.url).origin
      } catch {
        env = s.url
      }
      break
    }
  }

  const statusIcon = (st: string): string =>
    st === 'done' ? '✓' : st === 'error' ? '✗' : st === 'skipped' ? '⤼' : '○'

  const evidenceBlocks = (s: TraceStepRecord): string => {
    const parts: string[] = []
    if (s.screenshotFile && assets[s.screenshotFile]) {
      parts.push(`<img class="ev-shot" src="${src(s.screenshotFile)}" alt="Screenshot of step ${s.index + 1}">`)
    }
    for (const [lbl, arr] of [
      ['Console', s.consoleErrors],
      ['Network', s.networkErrors]
    ] as [string, string[]][]) {
      if (arr && arr.length) {
        parts.push(
          `<div class="ev-log"><div class="ev-lbl">${lbl}</div>` +
            arr.map((l) => `<div class="ev-line">${esc(l)}</div>`).join('') +
            `</div>`
        )
      }
    }
    return parts.join('')
  }

  const stepRows = steps
    .map((s) => {
      const hasEvidence =
        (s.screenshotFile && assets[s.screenshotFile]) || s.consoleErrors?.length || s.networkErrors?.length
      const barPct = Math.round(((s.durationMs || 0) / maxMs) * 100)
      const openAttr = s.status === 'error' ? ' open' : '' // failures are expanded by default
      const inner =
        `<summary class="step-head">` +
        `<span class="step-ic ${s.status}">${statusIcon(s.status)}</span>` +
        `<span class="step-num">${s.index + 1}</span>` +
        `<span class="step-text">${esc(s.text)}</span>` +
        `<span class="step-time">${fmtMs(s.durationMs || 0)}</span>` +
        `<span class="step-bar"><span class="step-bar-fill ${s.status}" style="width:${barPct}%"></span></span>` +
        `</summary>` +
        (s.error ? `<div class="step-err">${esc(s.error)}</div>` : '') +
        (hasEvidence ? `<div class="step-ev">${evidenceBlocks(s)}</div>` : '')
      // Steps with no evidence render as a plain (non-expandable) row.
      return hasEvidence || s.error
        ? `<details class="step"${openAttr}>${inner}</details>`
        : `<div class="step no-ev">${inner.replace('<summary', '<div').replace('</summary>', '</div>')}</div>`
    })
    .join('\n')

  const verdictClass = manifest.ok ? 'pass' : 'fail'
  const title = manifest.testName ? esc(manifest.testName) : 'Untitled test'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report — ${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:#f3f4f6; color:#1f2328; line-height:1.5; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 20px 48px; }
  .card { background:#fff; border:1px solid #e2e5e9; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.05); overflow:hidden; }
  /* Verdict banner */
  .verdict { padding:22px 26px; display:flex; align-items:center; gap:16px; border-bottom:1px solid #e2e5e9; }
  .verdict.pass { background:linear-gradient(90deg,#e9f7ef,#f4fbf6); }
  .verdict.fail { background:linear-gradient(90deg,#fdecea,#fdf4f3); }
  .badge { font-size:15px; font-weight:800; letter-spacing:.04em; padding:8px 14px; border-radius:999px; white-space:nowrap; }
  .verdict.pass .badge { background:#1a7f37; color:#fff; }
  .verdict.fail .badge { background:#c5303e; color:#fff; }
  .verdict h1 { font-size:20px; margin:0; }
  .verdict .sub { color:#6b7280; font-size:13px; margin-top:2px; }
  /* Summary tiles */
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; background:#e2e5e9; }
  .tile { background:#fff; padding:14px 18px; }
  .tile .k { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8a929c; margin-bottom:4px; }
  .tile .v { font-size:18px; font-weight:700; }
  .tile .v small { font-size:13px; font-weight:500; color:#8a929c; }
  .tile .v.pass { color:#1a7f37; } .tile .v.fail { color:#c5303e; }
  /* Failure callout */
  .failbox { margin:20px 0 0; border:1px solid #f1c1c1; border-left:4px solid #c5303e; border-radius:10px; background:#fff; overflow:hidden; }
  .failbox .fb-head { padding:12px 16px; background:#fdecea; font-weight:700; color:#a01722; }
  .failbox .fb-body { padding:14px 16px; }
  .failbox .fb-err { font-family:Consolas,ui-monospace,monospace; font-size:12.5px; background:#2b2b30; color:#ffb3ae; padding:10px 12px; border-radius:8px; white-space:pre-wrap; word-break:break-word; margin-bottom:12px; }
  .failbox img { width:100%; border:1px solid #e2e5e9; border-radius:8px; display:block; }
  /* Steps */
  h2.sec { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#6b7280; margin:28px 0 10px; }
  .steps { display:flex; flex-direction:column; gap:6px; }
  .step { background:#fff; border:1px solid #e2e5e9; border-radius:9px; }
  .step[open] { border-color:#cfd4da; }
  .step-head, .step > .step-head { display:flex; align-items:center; gap:10px; padding:9px 12px; cursor:pointer; list-style:none; }
  .step.no-ev .step-head { cursor:default; }
  .step-head::-webkit-details-marker { display:none; }
  .step-ic { width:20px; height:20px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; color:#fff; flex:0 0 auto; }
  .step-ic.done { background:#1a7f37; } .step-ic.error { background:#c5303e; } .step-ic.skipped { background:#d9a23b; } .step-ic.pending { background:#aeb4bd; }
  .step-num { color:#9aa0a8; font-size:12px; width:20px; text-align:right; flex:0 0 auto; }
  .step-text { flex:1; min-width:0; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step-time { font-size:12px; color:#6b7280; font-variant-numeric:tabular-nums; flex:0 0 auto; }
  .step-bar { width:80px; height:6px; background:#eef0f2; border-radius:3px; overflow:hidden; flex:0 0 auto; }
  .step-bar-fill { display:block; height:100%; background:#9aa0a8; }
  .step-bar-fill.error { background:#c5303e; } .step-bar-fill.done { background:#5aa877; }
  .step-err { margin:0 12px 10px; font-family:Consolas,ui-monospace,monospace; font-size:12px; color:#a01722; background:#fdecea; border-radius:7px; padding:8px 10px; white-space:pre-wrap; word-break:break-word; }
  .step-ev { padding:0 12px 12px; }
  .ev-shot { width:100%; border:1px solid #e2e5e9; border-radius:7px; display:block; margin-bottom:10px; background:#fafbfc; }
  .ev-log { background:#f7f8fa; border:1px solid #e6e8eb; border-radius:7px; padding:8px 10px; margin-bottom:8px; }
  .ev-lbl { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8a929c; margin-bottom:4px; }
  .ev-line { font-family:Consolas,ui-monospace,monospace; font-size:11.5px; color:#8a3a3a; word-break:break-word; }
  footer { text-align:center; color:#9aa0a8; font-size:12px; margin-top:28px; }
  @media print {
    body { background:#fff; }
    .wrap { max-width:none; padding:0; }
    .card, .step, .failbox { box-shadow:none; break-inside:avoid; }
    details.step { border:1px solid #ddd; }
    details.step:not([open]) > .step-ev { display:block; } /* open every step for the printout */
    .step[open], details.step { }
  }
  @media print { details.step > .step-ev, details.step > .step-err { display:block !important; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="verdict ${verdictClass}">
      <span class="badge">${manifest.ok ? '✓ PASSED' : '✗ FAILED'}</span>
      <div>
        <h1>${title}</h1>
        <div class="sub">${new Date(manifest.at).toLocaleString()}${env ? ' · ' + esc(env) : ''}</div>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Result</div><div class="v ${verdictClass}">${manifest.ok ? 'Passed' : 'Failed'}</div></div>
      <div class="tile"><div class="k">Duration</div><div class="v">${fmtMs(totalMs)}</div></div>
      <div class="tile"><div class="k">Steps</div><div class="v">${passed}<small> / ${steps.length} passed</small></div></div>
      <div class="tile"><div class="k">Issues</div><div class="v ${failed ? 'fail' : ''}">${failed}<small> failed${skipped + pending ? `, ${skipped + pending} not run` : ''}</small></div></div>
    </div>
  </div>

  ${
    failStep
      ? `<div class="failbox">
    <div class="fb-head">Failed at step ${failStep.index + 1} — ${esc(failStep.text)}</div>
    <div class="fb-body">
      ${failStep.error ? `<div class="fb-err">${esc(failStep.error)}</div>` : ''}
      ${failStep.screenshotFile && assets[failStep.screenshotFile] ? `<img src="${src(failStep.screenshotFile)}" alt="Failure screenshot">` : ''}
    </div>
  </div>`
      : ''
  }

  <h2 class="sec">All steps (${steps.length})</h2>
  <div class="steps">
    ${stepRows}
  </div>

  <footer>Generated by QATestFlow · ${new Date().toLocaleString()}</footer>
</div>
</body>
</html>
`
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
