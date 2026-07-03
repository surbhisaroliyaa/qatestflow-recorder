// =====================================================================
// PERFORMANCE / CORE WEB VITALS (F14)
// Measure how FAST the page is — the flip side of visual (how it looks)
// and a11y (who can use it). We read the browser's own Performance API in
// the live page (no external library) and grade each metric against
// Google's official Core Web Vitals thresholds.
//
// Like a11y, this is zero extra authoring: click ⚡ to measure the current
// page, or bank it as a "Performance check" step whose budget FAILS a
// replay when the page gets too slow.
//
// We measure the REAL session that just happened (field-style), not a
// fresh lab run — LCP/CLS come from the page as it actually loaded, which
// is exactly what we want to gate on.
// =====================================================================

export type PerfRating = 'good' | 'needs-improvement' | 'poor'

// One measured metric, already graded for the UI.
export interface PerfMetric {
  key: string
  label: string
  value: number | null // null = couldn't measure (e.g. SPA with no nav entry)
  unit: string // 'ms' or '' (CLS is unitless)
  rating: PerfRating | null // null = informational (no official threshold)
  core: boolean // true = a Core Web Vital (LCP/CLS) — these drive the gate
}

export interface PerfResult {
  url: string
  title: string
  at: string
  metrics: PerfMetric[]
  error?: string
}

// Google's Core Web Vitals thresholds: [good ceiling, poor floor].
// value ≤ good → "good"; value > poor → "poor"; in between → "needs-improvement".
// LCP/FCP/TTFB in ms; CLS is a unitless score.
const THRESHOLDS: Record<string, [number, number]> = {
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800]
}

export function ratePerf(key: string, value: number | null): PerfRating | null {
  if (value == null) return null
  const t = THRESHOLDS[key]
  if (!t) return null
  return value <= t[0] ? 'good' : value <= t[1] ? 'needs-improvement' : 'poor'
}

export const PERF_RATING_RANK: Record<PerfRating, number> = {
  good: 0,
  'needs-improvement': 1,
  poor: 2
}

// The gate budget = the WORST rating still allowed. 'good' is strict (anything
// worse than good fails); 'needs-improvement' (the default) only fails on poor.
export function perfBudgetRank(value?: string): number {
  return value === 'good' ? 0 : 1
}
export function perfBudgetLabel(value?: string): PerfRating {
  return value === 'good' ? 'good' : 'needs-improvement'
}

// The page-world program: read navigation + paint timing synchronously, then
// let buffered observers deliver the LCP + layout-shift entries that happened
// during load (buffered:true replays past entries), and sum CLS.
const MEASURE_PROGRAM = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcpEntry = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
  let lcp = null, cls = 0, sawShift = false;
  await new Promise((resolve) => {
    try {
      new PerformanceObserver((list) => {
        const es = list.getEntries();
        if (es.length) lcp = es[es.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) { cls += e.value; sawShift = true; }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
    setTimeout(resolve, 600);
  });
  return {
    url: location.href,
    title: document.title,
    lcp,
    cls: sawShift ? cls : (lcp != null ? 0 : null),
    fcp: fcpEntry ? fcpEntry.startTime : null,
    ttfb: nav ? nav.responseStart : null,
    load: nav && nav.loadEventEnd ? nav.loadEventEnd : null,
    dcl: nav && nav.domContentLoadedEventEnd ? nav.domContentLoadedEventEnd : null
  };
})()`

interface RawPerf {
  url: string
  title: string
  lcp: number | null
  cls: number | null
  fcp: number | null
  ttfb: number | null
  load: number | null
  dcl: number | null
}

export async function measurePerformance(wc: Electron.WebContents): Promise<PerfResult> {
  const raw = (await wc.executeJavaScript(MEASURE_PROGRAM)) as RawPerf
  const round = (v: number | null, d = 0): number | null =>
    v == null ? null : Math.round(v * 10 ** d) / 10 ** d
  const metrics: PerfMetric[] = [
    {
      key: 'lcp',
      label: 'Largest Contentful Paint',
      value: round(raw.lcp),
      unit: 'ms',
      rating: ratePerf('lcp', raw.lcp),
      core: true
    },
    {
      key: 'cls',
      label: 'Cumulative Layout Shift',
      value: round(raw.cls, 3),
      unit: '',
      rating: ratePerf('cls', raw.cls),
      core: true
    },
    {
      key: 'fcp',
      label: 'First Contentful Paint',
      value: round(raw.fcp),
      unit: 'ms',
      rating: ratePerf('fcp', raw.fcp),
      core: false
    },
    {
      key: 'ttfb',
      label: 'Time to First Byte',
      value: round(raw.ttfb),
      unit: 'ms',
      rating: ratePerf('ttfb', raw.ttfb),
      core: false
    },
    {
      key: 'load',
      label: 'Page load',
      value: round(raw.load),
      unit: 'ms',
      rating: null,
      core: false
    },
    {
      key: 'dcl',
      label: 'DOM content loaded',
      value: round(raw.dcl),
      unit: 'ms',
      rating: null,
      core: false
    }
  ]
  return { url: raw.url, title: raw.title, at: new Date().toISOString(), metrics }
}
