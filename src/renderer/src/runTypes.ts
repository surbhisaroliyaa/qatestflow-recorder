// =====================================================================
// PER-RUN RESULT TYPES
//
// LocaleResult was module-level in App.tsx and DataRunEntry was declared INSIDE
// the component, so neither could be named from anywhere else — which is part of
// why the reports that use them had to live in App.tsx too. Moved verbatim.
// =====================================================================

/** One locale's outcome in an F28 localization sweep. */
export interface LocaleResult {
  locale: string
  ok: boolean
  error?: string
  failedAt?: number // which step failed — so the report says WHY, not just "failed"
  screenshotPath?: string
  traceId?: string
  dir: string
  overflowCount: number
  overflow: string[]
  unchanged: number // strings identical to the base locale (likely untranslated)
  totalTexts: number
}

/** One row's outcome in a data-driven run. */
export interface DataRunEntry {
  label: string
  status: 'passed' | 'failed'
  failedAt?: number
  error?: string
  screenshotPath?: string
  traceId?: string // Day 20: this row's run recording, openable per row
  consoleErrors?: string[] // this row's evidence — for per-row 💡 Explain
  networkErrors?: string[]
  category?: FailureCategory // F9 (Stage 2): this row's auto-classified failure type
}
