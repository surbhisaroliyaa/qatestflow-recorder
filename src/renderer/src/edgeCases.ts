// =====================================================================
// EDGE-CASE EXPLOSION (F20)
// A recorded test usually captures the HAPPY path — valid inputs, everything
// works. But most real bugs live in the unhappy paths: empty fields, over-long
// values, wrong formats, and malicious input (SQL/XSS). Hand-writing 20 negative
// cases per form is exactly the tedium this tool exists to remove.
//
// F20 takes the happy path and EXPLODES each text input into a family of
// variants — empty / boundary / invalid-format / injection — one variant per
// (field × nasty value). Each variant is the same flow with ONE field swapped
// for a hostile value; every other field keeps its happy value. The renderer
// runs the variants through the SAME replay engine as a data-driven run.
//
// This module is the pure GENERATOR: it finds the fields, holds the catalogue of
// hostile values, and builds the variant step-lists. It makes no judgement about
// outcomes — the renderer compares each variant to the happy-path baseline to
// decide "the app accepted this bad input" vs "the app rejected it".
// =====================================================================

// The four families the roadmap calls for. A QA can toggle whole families on/off
// to control how many variants get generated.
export type EdgeGroup = 'empty' | 'boundary' | 'invalid' | 'injection'

export const EDGE_GROUP_LABELS: Record<EdgeGroup, string> = {
  empty: 'Empty / blank',
  boundary: 'Boundary / length',
  invalid: 'Invalid format',
  injection: 'Injection / special'
}

// One hostile value to try in a field.
export interface EdgeValue {
  id: string
  group: EdgeGroup
  label: string // short human name, e.g. "SQL injection"
  value: string // what gets typed into the field
  hint: string // what a correct app SHOULD do — shown in the report
}

// A generated test case: the field it stresses + the value + the full flow.
export interface EdgeCase {
  id: string
  baseline: boolean // the untouched happy path — the reference run
  fieldIndex: number // index into the FLAT step list (-1 for the baseline)
  fieldLabel: string
  group: EdgeGroup | null
  edgeLabel: string // "Empty", "SQL injection", … ("Happy path" for the baseline)
  value: string
  hint: string
  steps: RecorderStep[]
}

const LONG_STRING = 'A'.repeat(256)

// Values tried on EVERY text field regardless of what it holds.
const GENERIC_EDGE_VALUES: EdgeValue[] = [
  {
    id: 'empty',
    group: 'empty',
    label: 'Empty',
    value: '',
    hint: 'A required field should be rejected when left blank.'
  },
  {
    id: 'whitespace',
    group: 'empty',
    label: 'Whitespace only',
    value: '   ',
    hint: 'Spaces-only should be treated as blank (trimmed) and rejected.'
  },
  {
    id: 'long',
    group: 'boundary',
    label: 'Very long (256 chars)',
    value: LONG_STRING,
    hint: 'The field should enforce a sane maximum length.'
  },
  {
    id: 'padded',
    group: 'boundary',
    label: 'Leading/trailing spaces',
    value: '  padded value  ',
    hint: 'Surrounding spaces should be trimmed or rejected, not stored verbatim.'
  },
  {
    id: 'special',
    group: 'injection',
    label: 'Special characters',
    value: `!@#$%^&*()<>?/\\|{}[]~\`;:'"`,
    hint: 'Special characters must be handled/escaped, not break the page.'
  },
  {
    id: 'sql',
    group: 'injection',
    label: 'SQL injection',
    value: `' OR '1'='1' --`,
    hint: 'MUST be rejected — never log in / return data. Accepting this is a serious vulnerability.'
  },
  {
    id: 'xss',
    group: 'injection',
    label: 'XSS script',
    value: `<script>alert('xss')</script>`,
    hint: 'Must be escaped and never executed or reflected as HTML.'
  }
]

// A field's likely data type, guessed from its label (and its recorded value) —
// so we can add format-specific "invalid" values (a bad email, a non-number).
type FieldKind = 'email' | 'number' | 'text'

function inferKind(step: RecorderStep): FieldKind {
  const label = (step.label ?? '').toLowerCase()
  if (/e-?mail/.test(label)) return 'email'
  if (/phone|mobile|zip|postal|age|amount|price|qty|quantity|number|count|year/.test(label)) {
    return 'number'
  }
  // Fall back to the recorded value: all-digits (non-empty) reads as numeric.
  const v = (step.value ?? '').trim()
  if (v && /^\d+$/.test(v)) return 'number'
  return 'text'
}

// Invalid-FORMAT values that only make sense for a typed field.
function invalidFor(kind: FieldKind): EdgeValue[] {
  if (kind === 'email') {
    return [
      {
        id: 'bademail',
        group: 'invalid',
        label: 'Malformed email',
        value: 'not-an-email',
        hint: 'A field labelled email should reject a value with no @ / domain.'
      }
    ]
  }
  if (kind === 'number') {
    return [
      {
        id: 'nonnumeric',
        group: 'invalid',
        label: 'Non-numeric',
        value: 'abc',
        hint: 'A numeric field should reject letters.'
      },
      {
        id: 'negative',
        group: 'invalid',
        label: 'Negative number',
        value: '-1',
        hint: 'A count/amount should reject or clamp negatives.'
      }
    ]
  }
  return []
}

// The text fields a QA can explode: `type` steps (free-text inputs). `select`
// is excluded — a dropdown can only hold its real options, so hostile values
// don't apply. Returns each field's flat-list index + its human label.
export function fillableFields(flat: RecorderStep[]): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = []
  flat.forEach((s, i) => {
    if (s.type === 'type' && !s.disabled) {
      out.push({ index: i, label: s.label || `field ${i + 1}` })
    }
  })
  return out
}

// All the hostile values that apply to one field, filtered to the chosen groups.
function valuesForField(step: RecorderStep, groups: Set<EdgeGroup>): EdgeValue[] {
  const all = [...GENERIC_EDGE_VALUES, ...invalidFor(inferKind(step))]
  return all.filter((v) => groups.has(v.group))
}

// How many variants a given selection WOULD produce (for the live count in the
// picker), NOT counting the baseline.
export function countEdgeCases(
  flat: RecorderStep[],
  fieldIndices: number[],
  groups: Set<EdgeGroup>
): number {
  return fieldIndices.reduce(
    (n, idx) => n + (flat[idx] ? valuesForField(flat[idx], groups).length : 0),
    0
  )
}

// Build the full run list: the happy-path baseline first (the reference), then
// one variant per (selected field × applicable hostile value). Each variant is
// a COPY of the flow with just that one field overwritten — so nothing mutates
// the saved test. A password field's `secret` flag is cleared on the perturbed
// step so the injected value is actually typed (and visible in the report).
export function generateEdgeCases(
  flat: RecorderStep[],
  fieldIndices: number[],
  groups: Set<EdgeGroup>
): EdgeCase[] {
  const baseline: EdgeCase = {
    id: 'baseline',
    baseline: true,
    fieldIndex: -1,
    fieldLabel: '',
    group: null,
    edgeLabel: 'Happy path',
    value: '',
    hint: 'The recorded valid inputs — the reference every variant is compared against.',
    steps: flat.map((s) => ({ ...s }))
  }
  const cases: EdgeCase[] = [baseline]
  for (const idx of fieldIndices) {
    const field = flat[idx]
    if (!field) continue
    const label = field.label || `field ${idx + 1}`
    for (const ev of valuesForField(field, groups)) {
      cases.push({
        id: `${idx}-${ev.id}`,
        baseline: false,
        fieldIndex: idx,
        fieldLabel: label,
        group: ev.group,
        edgeLabel: ev.label,
        value: ev.value,
        hint: ev.hint,
        steps: flat.map((s, i) =>
          i === idx ? { ...s, value: ev.value, secret: false } : { ...s }
        )
      })
    }
  }
  return cases
}
