// =====================================================================
// ACCESSIBILITY SCAN (F13) — WCAG A/AA violations, zero extra authoring.
//
// We inject the industry-standard axe-core engine into the LIVE page and
// run it against the WCAG 2.0/2.1 A & AA rule tags, then trim the (large)
// raw result down to what the panel shows. This finds a whole class of
// real bugs the behavioural checks are blind to — missing labels, colour
// contrast, keyboard traps, broken ARIA — on ANY site, with no steps to
// author.
//
// axe ships its whole library as a string on `axe.source`, meant exactly
// for injection into a page under test (that's how Selenium/Playwright do
// it). We run it in the page's main world via executeJavaScript, so it
// sees the real, rendered DOM.
// =====================================================================
import axe from 'axe-core'

// One offending element inside a violation.
export interface A11yNode {
  target: string // CSS selector path to the element (axe's `target`, joined)
  html: string // a truncated outerHTML snippet, so the user can spot it
  summary: string // axe's failureSummary — the plain "how to fix" text
}

// One rule that failed, with every element that broke it.
export interface A11yViolation {
  id: string // rule id, e.g. "color-contrast"
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | string
  help: string // short human title, e.g. "Buttons must have discernible text"
  description: string // longer description of the rule
  helpUrl: string // deque docs link (how to fix, in depth)
  tags: string[] // wcag2a / wcag2aa / … — which standard it maps to
  nodes: A11yNode[] // the elements that violated it (capped)
}

export interface A11yScanResult {
  url: string
  title: string
  at: string // ISO timestamp of the scan
  violations: A11yViolation[]
  passCount: number // rules that PASSED — context for "how clean is this page"
  incompleteCount: number // rules axe couldn't decide (needs a human look)
  nodeCount: number // total elements flagged across all violations
  // Set when the scan couldn't run (e.g. the welcome screen, or a page that
  // navigated away mid-scan). The panel shows this instead of results.
  error?: string
}

// WCAG 2.0 + 2.1, levels A and AA — the standard "must comply" bar most
// teams are held to. (Deliberately NOT 'best-practice' — that adds noise
// that would drown the real, actionable violations.)
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// Cap how many offending elements we keep PER rule. A broken design system
// can flag hundreds of identical buttons; the first handful make the point
// and keep the IPC payload + panel sane. `nodeCount` still reports the real
// total so nothing is hidden.
const NODES_PER_RULE = 25

// Severity ranking — critical is the worst (0). Used by the a11y ASSERTION
// step to decide which violations count as a failure. Anything axe leaves
// unrated sorts last.
export const A11Y_LEVELS = ['critical', 'serious', 'moderate', 'minor'] as const
export function a11yImpactRank(impact: string): number {
  const i = (A11Y_LEVELS as readonly string[]).indexOf(impact)
  return i === -1 ? A11Y_LEVELS.length : i
}

// The a11y assertion step stores its budget in `value` — the LEAST severe
// impact that still fails the step (default "serious", so critical + serious
// fail while moderate/minor are tolerated). Normalises anything unexpected
// back to the safe default.
export function a11yThresholdLevel(value?: string): (typeof A11Y_LEVELS)[number] {
  return value && (A11Y_LEVELS as readonly string[]).includes(value)
    ? (value as (typeof A11Y_LEVELS)[number])
    : 'serious'
}

export async function scanAccessibility(wc: Electron.WebContents): Promise<A11yScanResult> {
  // The whole engine + the run, in one page-world program. axe is re-defined
  // only if it isn't already present (cheap re-scans after the first).
  const program = `(async () => {
    if (!window.axe) { ${axe.source} }
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_TAGS)} },
      resultTypes: ['violations']
    });
    const joinTarget = (t) => Array.isArray(t) ? t.map(String).join(' ') : String(t);
    let nodeCount = 0;
    const violations = result.violations.map((v) => {
      nodeCount += v.nodes.length;
      return {
        id: v.id,
        impact: v.impact,
        help: v.help,
        description: v.description,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes.slice(0, ${NODES_PER_RULE}).map((n) => ({
          target: joinTarget(n.target),
          html: (n.html || '').slice(0, 400),
          summary: n.failureSummary || ''
        }))
      };
    });
    return {
      url: location.href,
      title: document.title,
      violations,
      passCount: (result.passes || []).length,
      incompleteCount: (result.incomplete || []).length,
      nodeCount
    };
  })()`

  const raw = (await wc.executeJavaScript(program)) as Omit<A11yScanResult, 'at'>
  return { ...raw, at: new Date().toISOString() }
}
