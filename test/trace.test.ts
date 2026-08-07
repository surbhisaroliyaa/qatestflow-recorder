import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/Users/test/Documents' } }))

const { generateReportHtml, generateTraceHtml, isSafeTraceId } = await import('../src/main/trace')
type Manifest = Parameters<typeof generateReportHtml>[0]

// =====================================================================
// THE RUN TRACE and THE SHAREABLE REPORT.
//
// Both are HTML files built from the run — and almost everything in them
// comes from the SITE UNDER TEST: its error messages, its console output,
// its URLs, its page text. That is untrusted content being pasted into a
// document you then hand to a developer or a PM.
//
// A test site whose error message contains markup should produce a report
// that says so. It must not produce a report that RUNS it, and it must not
// produce a broken page that hides the failure it was written to explain.
// =====================================================================

const step = (o: Partial<Manifest['steps'][number]> = {}): Manifest['steps'][number] =>
  ({
    index: 0,
    type: 'click',
    text: 'Click "Checkout"',
    status: 'done',
    durationMs: 120,
    consoleErrors: [],
    networkErrors: [],
    ...o
  }) as Manifest['steps'][number]

const manifest = (o: Partial<Manifest> = {}): Manifest =>
  ({
    id: 'trace-123',
    testName: 'Checkout flow',
    at: '2026-08-08T00:00:00.000Z',
    ok: true,
    stepCount: 1,
    steps: [step()],
    ...o
  }) as Manifest

const HOSTILE = '<script>alert(1)</script>'

describe('a trace id can only ever be one of our own folders', () => {
  it('accepts the ids we generate', () => {
    expect(isSafeTraceId('trace-1786087311623')).toBe(true)
    expect(isSafeTraceId('trace-abc_DEF-123')).toBe(true)
  })

  it('refuses anything that could point outside the traces folder', () => {
    // This guards the IPC that opens trace files.
    for (const bad of [
      '../secrets',
      'trace-1/../../etc/passwd',
      'trace-1/sub',
      'trace-1\\..\\x',
      '/etc/passwd',
      'C:\\Windows',
      'trace-',
      'nottrace-1',
      '',
      'trace-1.json'
    ]) {
      expect(isSafeTraceId(bad), bad).toBe(false)
    }
  })
})

describe('the shareable report escapes what the site gave it', () => {
  it('renders a hostile test name as text, not as markup', () => {
    const html = generateReportHtml(manifest({ testName: HOSTILE }))
    expect(html).not.toContain(HOSTILE)
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes an error message — the most likely place for site markup', () => {
    // The error is quoted verbatim from the page or the runner.
    const html = generateReportHtml(
      manifest({ ok: false, failedAt: 0, steps: [step({ status: 'error', error: HOSTILE })] })
    )
    expect(html).not.toContain(HOSTILE)
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes step text, console lines and network lines', () => {
    const html = generateReportHtml(
      manifest({
        steps: [
          step({
            text: `Click "${HOSTILE}"`,
            consoleErrors: [`[step 1] ${HOSTILE}`],
            networkErrors: [`[step 1] HTTP 500 on ${HOSTILE}`]
          })
        ]
      })
    )
    expect(html).not.toContain(HOSTILE)
  })

  it('escapes a quote so it cannot break out of an attribute', () => {
    const html = generateReportHtml(manifest({ testName: 'a" onload="alert(1)' }))
    expect(html).not.toContain('onload="alert(1)"')
    expect(html).toContain('&quot;')
  })

  it('still says the true thing about the run', () => {
    // Escaping must not cost the report its meaning.
    const html = generateReportHtml(
      manifest({ ok: false, failedAt: 0, steps: [step({ status: 'error', error: 'Element not found' })] })
    )
    expect(html).toContain('Element not found')
    expect(html).toContain('Checkout flow')
  })
})

describe('the trace viewer escapes it too', () => {
  it('does not paste a hostile error straight into the page', () => {
    const html = generateTraceHtml(
      manifest({ ok: false, steps: [step({ status: 'error', error: HOSTILE })] })
    )
    // The viewer inlines the manifest as DATA rather than markup, so the
    // dangerous string must not appear as live markup either way.
    expect(html).not.toContain(`>${HOSTILE}<`)
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('closes an inlined </script> so the payload cannot end our own tag', () => {
    // The manifest is embedded inside a <script> block. A string containing
    // "</script>" would terminate it early and everything after becomes markup.
    const html = generateTraceHtml(manifest({ testName: 'a</script><img src=x onerror=alert(1)>' }))
    expect(html).not.toContain('</script><img src=x onerror=alert(1)>')
  })
})

describe('what the report says about the run', () => {
  it('counts each outcome separately', () => {
    const html = generateReportHtml(
      manifest({
        ok: false,
        failedAt: 1,
        stepCount: 4,
        steps: [
          step({ index: 0, status: 'done' }),
          step({ index: 1, status: 'error', error: 'boom' }),
          step({ index: 2, status: 'skipped' }),
          // 'pending' means the run stopped before reaching it — NOT a failure,
          // and not a pass. Merging it into either would misreport the run.
          step({ index: 3, status: 'pending' })
        ]
      })
    )
    expect(html).toMatch(/skipped/i)
    expect(html).toMatch(/pending|did not run|never ran/i)
  })

  it('reports a passing run as passing', () => {
    expect(generateReportHtml(manifest({ ok: true }))).toMatch(/pass/i)
  })

  it('produces a self-contained document', () => {
    // It is emailed and opened offline; a reference to a loose file would show
    // a broken image where the evidence should be.
    const html = generateReportHtml(manifest())
    expect(html).toMatch(/<html/i)
    expect(html).toMatch(/<\/html>/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href="http/i)
  })

  it('embeds a screenshot given to it, rather than linking a path', () => {
    const html = generateReportHtml(
      manifest({ steps: [step({ screenshotFile: 'step-0.png' })] }),
      { 'step-0.png': 'data:image/png;base64,AAAA' }
    )
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('survives a run with no steps at all', () => {
    expect(() => generateReportHtml(manifest({ steps: [], stepCount: 0 }))).not.toThrow()
  })

  it('survives a step with no evidence of any kind', () => {
    expect(() =>
      generateReportHtml(manifest({ steps: [step({ screenshotFile: undefined, error: undefined })] }))
    ).not.toThrow()
  })
})
