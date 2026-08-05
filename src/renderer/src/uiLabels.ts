// =====================================================================
// UI LABELS AND PRESETS
//
// The fixed vocabulary the interface uses: how each assertion kind, failure
// verdict, triage category and perf metric is named and explained. Pulled out of
// App.tsx, which had grown to 13,000+ lines with this sitting at the top of it.
//
// These are data, not behaviour — but several carry a MIRROR obligation to a
// counterpart in the main process, and those notes travel with them here rather
// than being left behind in a file nobody opens deliberately.
// =====================================================================

/** Offered on the welcome screen as one-click starting points. */
export const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Day 9: the checks offered by the assertion chooser, in display order.
// checked/unchecked only make sense on a checkbox/radio — the chooser hides
// them unless the picked element reported a live `checked` state (Day 11).
export const ASSERT_KINDS: AssertKind[] = [
  'visible',
  'hidden',
  'text-equals',
  'text-contains',
  'value',
  'empty',
  'count',
  'enabled',
  'disabled',
  'editable',
  'focused',
  'checked',
  'unchecked',
  'attribute',
  'class'
]

export const ASSERT_LABELS: Record<AssertKind, string> = {
  visible: 'Visible',
  hidden: 'Hidden',
  'text-equals': 'Text =',
  'text-contains': 'Contains',
  value: 'Value',
  empty: 'Empty',
  count: 'Count',
  enabled: 'Enabled',
  disabled: 'Disabled',
  editable: 'Editable',
  focused: 'Focused',
  checked: 'Checked',
  unchecked: 'Unchecked',
  attribute: 'Attribute',
  class: 'Has class',
  'url-contains': 'URL contains',
  title: 'Page title',
  nl: 'AI check'
}

// Day 13: how the analysis modal names each verdict.
export const VERDICT_LABELS: Record<FailureVerdict, string> = {
  'app-bug': 'App bug',
  'test-bug': 'Test bug',
  timing: 'Timing',
  environment: 'Environment',
  unknown: 'Unclassified'
}

// F9 (finer categories): the precise triage sub-type shown beside the verdict.
export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  'stale-selector': 'stale selector',
  'stale-data': 'stale data',
  'app-bug': 'app bug',
  timing: 'timing',
  environment: 'unreachable',
  authoring: 'weak selector',
  unknown: 'unclassified'
}

// WHY each label was chosen. Two tests can fail with the identical message
// ("Element not found") and be filed under DIFFERENT categories, because the
// classifier also weighs whether the page itself logged errors. Without the
// rule stated, that looks arbitrary — and "app bug" is a claim the reader may
// have to defend to a developer, so it has to be defensible on sight.
// MIRROR: these must match the branches in main/translator.ts ruleBasedExplain.
export const CATEGORY_WHY: Record<FailureCategory, string> = {
  'stale-selector':
    'the element was not found, and the page itself looked healthy (no console or network errors) — so the selector, not the app, is what changed',
  'stale-data':
    'the element was found; its value or state differs from what was recorded — either the app is wrong or the expected value is out of date',
  'app-bug':
    'the element was missing or never usable AND the page logged real console/network errors — so it is likely absent because the app failed to render it',
  timing:
    'the element was found but never became visible or enabled in time, on a page showing no errors — usually slower than the test, not broken',
  environment: 'the page could not be loaded at all — network, URL or the site being down',
  authoring:
    'the recorded element has no stable hooks (no id, role or text), so replay refused to guess rather than act on the wrong element',
  unknown: 'the error did not match any known pattern — read the screenshot and logs'
}

// F13: how severe axe considers each violation — drives the sort order (worst
// first) and the chip colour. Anything unrated sorts last.
export const A11Y_IMPACT_ORDER: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3
}

// F14: a one-line "what does this measure" for each perf metric, shown under
// its name in the panel so the numbers explain themselves. Lower is better for
// all of them.
export const PERF_METRIC_HELP: Record<string, string> = {
  lcp: 'How fast the main content appears',
  cls: 'How much the layout jumps around while loading',
  fcp: 'When the first pixels paint (context — no gate)',
  ttfb: 'How fast the server sends the first byte (context — no gate)',
  load: 'Everything finished loading (info only)',
  dcl: 'HTML parsed and ready (info only)'
}

// F28: locales the localization sweep can run the flow under. en-US is the base
// everything else is compared against (a string that DIDN'T change from base is a
// likely-untranslated candidate). ar is included to exercise RTL layout.
export const LOCALE_PRESETS: { code: string; label: string; rtl?: boolean }[] = [
  { code: 'en-US', label: 'English (US) — base' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'de-DE', label: 'German (long words)' },
  { code: 'fr-FR', label: 'French' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ar', label: 'Arabic (RTL)', rtl: true }
]
