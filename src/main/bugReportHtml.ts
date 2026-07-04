// =====================================================================
// VISUAL BUG REPORT (HTML) — the second output of the Day-13 bug report.
// The renderer's bugReport.ts renders the SAME evidence as markdown (for
// pasting into a ticket); this renders it as a self-contained, print-to-PDF
// web page whose killer difference is the failure SCREENSHOT embedded
// inline (the markdown can only name the file). Includes the AI/rule triage
// verdict, repro steps, expected-vs-actual, and console/network evidence.
//
// Lives in main because it embeds a screenshot read from disk — the same
// reason all file access is backstage. Fed by FailureEvidence (+ the
// optional FailureAnalysis) exactly like the markdown generator.
// =====================================================================
import type { FailureEvidence, FailureAnalysis, FailureVerdict } from './translator'

const VERDICT_TITLES: Record<FailureVerdict, string> = {
  'app-bug': 'Application bug (the product is misbehaving)',
  'test-bug': 'Test maintenance needed (the app looks healthy; the test is stale)',
  timing: 'Timing / flakiness (the app is slower than the test)',
  environment: 'Environment problem (the site could not be reached)',
  unknown: 'Unclassified — needs human triage'
}

function escapeHtml(s: string): string {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  )
}

// "Expected element to have text "Products" — actual: "Productz"" splits into
// the Expected / Actual rows a bug template wants. Mirrors bugReport.ts.
function expectedVsActual(error: string): { expected: string; actual: string } {
  const m = /^Expected (.*?) — actual: (.*)$/s.exec(error)
  if (m) return { expected: m[1].trim(), actual: m[2].trim() }
  return { expected: 'The step completes successfully', actual: error }
}

export function generateBugReportHtml(
  ev: FailureEvidence,
  analysis: FailureAnalysis | null,
  // The failure screenshot as a data: URL (read + encoded by the caller in
  // main). Absent when no screenshot was captured.
  screenshotDataUrl?: string
): string {
  const esc = escapeHtml
  const { expected, actual } = expectedVsActual(ev.error)
  const title = `${ev.testName ? `[${esc(ev.testName)}] ` : ''}Step ${ev.stepIndex + 1} fails: ${esc(ev.stepText)}`

  const stepsList = ev.allSteps
    .map((s, i) => {
      const failing = i === ev.stepIndex
      return `<li class="${failing ? 'fails' : ''}"><span class="sn">${i + 1}</span><span class="st">${esc(s)}</span>${failing ? '<span class="here">← fails here</span>' : ''}</li>`
    })
    .join('')

  const logBlock = (lbl: string, arr: string[]): string => {
    if (!arr || !arr.length) return ''
    const shown = arr.slice(0, 15)
    const more = arr.length > 15 ? `<div class="line more">… and ${arr.length - 15} more</div>` : ''
    return `<div class="log"><div class="log-lbl">${lbl}</div>${shown
      .map((l) => `<div class="line">${esc(l)}</div>`)
      .join('')}${more}</div>`
  }
  const evidenceLogs =
    logBlock('Console errors', ev.consoleErrors) + logBlock('Network problems', ev.networkErrors)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bug report — ${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:#f3f4f6; color:#1f2328; line-height:1.5; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 20px 48px; }
  .card { background:#fff; border:1px solid #e2e5e9; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.05); overflow:hidden; }
  .head { padding:20px 24px; background:linear-gradient(90deg,#fdecea,#fdf4f3); border-bottom:1px solid #f1c1c1; display:flex; gap:14px; align-items:flex-start; }
  .badge { font-size:13px; font-weight:800; letter-spacing:.04em; padding:7px 13px; border-radius:999px; background:#c5303e; color:#fff; white-space:nowrap; }
  .head h1 { font-size:18px; margin:0; }
  .head .sub { color:#6b7280; font-size:13px; margin-top:3px; }
  .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1px; background:#e2e5e9; }
  .meta .m { background:#fff; padding:11px 16px; }
  .meta .k { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8a929c; margin-bottom:3px; }
  .meta .v { font-size:13px; word-break:break-word; }
  .meta .v code { font-family:Consolas,ui-monospace,monospace; font-size:12px; background:#f2f3f5; padding:1px 5px; border-radius:4px; }
  section { margin-top:20px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:#6b7280; margin:0 0 8px; }
  .triage { border:1px solid #e6d8a8; border-left:4px solid #d9a23b; background:#fffdf5; border-radius:10px; padding:14px 16px; }
  .triage .verdict { font-weight:700; margin-bottom:6px; }
  .triage .src { font-weight:400; color:#8a929c; font-size:12px; }
  .triage p { margin:6px 0 0; font-size:14px; }
  .triage .next { margin-top:10px; font-size:14px; }
  .triage .next b { color:#a06d12; }
  ol.repro { list-style:none; margin:0; padding:0; background:#fff; border:1px solid #e2e5e9; border-radius:10px; overflow:hidden; }
  ol.repro li { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid #eef0f2; font-size:14px; }
  ol.repro li:last-child { border-bottom:none; }
  ol.repro li.fails { background:#fdecea; }
  ol.repro .sn { color:#9aa0a8; font-size:12px; width:20px; text-align:right; }
  ol.repro .st { flex:1; }
  ol.repro .here { color:#c5303e; font-weight:700; font-size:12px; }
  .ea { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .ea .box { background:#fff; border:1px solid #e2e5e9; border-radius:10px; padding:12px 14px; }
  .ea .box.exp { border-left:4px solid #1a7f37; } .ea .box.act { border-left:4px solid #c5303e; }
  .ea .box .k { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8a929c; margin-bottom:5px; }
  .ea .box .v { font-size:14px; word-break:break-word; }
  .err { font-family:Consolas,ui-monospace,monospace; font-size:12.5px; background:#2b2b30; color:#ffb3ae; padding:10px 12px; border-radius:8px; white-space:pre-wrap; word-break:break-word; }
  .shot { width:100%; border:1px solid #e2e5e9; border-radius:10px; display:block; background:#fafbfc; }
  .log { background:#f7f8fa; border:1px solid #e6e8eb; border-radius:9px; padding:10px 12px; margin-top:10px; }
  .log-lbl { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#8a929c; margin-bottom:5px; }
  .log .line { font-family:Consolas,ui-monospace,monospace; font-size:11.5px; color:#8a3a3a; word-break:break-word; }
  .log .line.more { color:#8a929c; }
  .noevidence { color:#8a929c; font-size:13px; font-style:italic; }
  footer { text-align:center; color:#9aa0a8; font-size:12px; margin-top:28px; }
  @media (max-width:560px) { .ea { grid-template-columns:1fr; } }
  @media print {
    body { background:#fff; }
    .wrap { max-width:none; padding:0; }
    .card, section, .card * { box-shadow:none; }
    section { break-inside:avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <span class="badge">🐞 BUG</span>
      <div>
        <h1>${title}</h1>
        <div class="sub">Found by QATestFlow (automated replay) · ${new Date().toLocaleString()}</div>
      </div>
    </div>
    <div class="meta">
      <div class="m"><div class="k">Page</div><div class="v">${esc(ev.pageUrl)}${ev.pageTitle ? ` — "${esc(ev.pageTitle)}"` : ''}</div></div>
      <div class="m"><div class="k">Failing step</div><div class="v">${ev.stepIndex + 1} of ${ev.allSteps.length} — ${esc(ev.stepType)}</div></div>
      ${ev.selector ? `<div class="m"><div class="k">Selector</div><div class="v"><code>${esc(ev.selector)}</code></div></div>` : ''}
    </div>
  </div>

  ${
    analysis
      ? `<section>
    <h2>Triage</h2>
    <div class="triage">
      <div class="verdict">${esc(VERDICT_TITLES[analysis.verdict] ?? analysis.verdict)} <span class="src">(${analysis.source === 'ai' ? 'analyzed by Claude' : 'rule-based analysis'})</span></div>
      <p>${esc(analysis.explanation)}</p>
      ${analysis.suggestion ? `<div class="next"><b>Suggested next action:</b> ${esc(analysis.suggestion)}</div>` : ''}
    </div>
  </section>`
      : ''
  }

  <section>
    <h2>Steps to reproduce</h2>
    <ol class="repro">${stepsList}</ol>
  </section>

  <section>
    <h2>Expected vs actual</h2>
    <div class="ea">
      <div class="box exp"><div class="k">Expected</div><div class="v">${esc(expected)}</div></div>
      <div class="box act"><div class="k">Actual</div><div class="v">${esc(actual)}</div></div>
    </div>
  </section>

  <section>
    <h2>Error</h2>
    <div class="err">${esc(ev.error)}</div>
  </section>

  ${
    screenshotDataUrl
      ? `<section>
    <h2>Screenshot at the moment of failure</h2>
    <img class="shot" src="${screenshotDataUrl}" alt="Failure screenshot">
  </section>`
      : ''
  }

  ${
    evidenceLogs
      ? `<section><h2>Console &amp; network</h2>${evidenceLogs}</section>`
      : `<section><h2>Console &amp; network</h2><div class="noevidence">No console or network errors were observed during the run.</div></section>`
  }

  <footer>Generated by QATestFlow · ${new Date().toLocaleString()}</footer>
</div>
</body>
</html>
`
}
