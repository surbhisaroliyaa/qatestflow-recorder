import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  generatePlaywrightTest,
  generatePageObjectTest,
  generateCiWorkflow,
  generatePlaywrightConfig,
  generateEdgeSuite,
  stepText,
  osEnvCollisions
} from './playwrightExport'
import { generateBugReport, bugReportFileName, jiraSummary } from './bugReport'
import { dataColumns, substituteSteps, resolveRow, envVarNames, toColumnName } from './dataDriven'
import {
  retargetSteps,
  retargetHostMismatch,
  apiHostsOutsideEnv,
  suppressedChoice,
  retargetWarnKey
} from './environments'
import {
  fillableFields,
  generateEdgeCases,
  countEdgeCases,
  EDGE_GROUP_LABELS,
  type EdgeGroup,
  type EdgeCase
} from './edgeCases'
import { generateSuiteDoc, type DocMeta } from './livingDocs'
import { classifyRuns, type FlakyTag } from './flaky'
import { trustScore } from './trust'
import { findWeakAssertions } from './deadAssertions'
import { diffSteps, diffCounts } from './stepDiff'
import { DEVICES, deviceById, resolveDevice, deviceSummary } from './devices'
// F37: loops + branching. Shared with the replay engine so the step list, the
// export and the run all agree on how markers pair up.
import { analyzeControlFlow, isControlStep, type ConditionKind } from '../../shared/controlFlow'
import { saveSpecWarning } from '../../shared/apiSaveSpec'
import { collidesWithOsEnv } from '../../shared/osEnvNames'
import { SUGGESTED_TAGS, parseTags, normalizeTag, allTags, matchesTags } from './tags'
import { headlessBlockers, blockerSummary, defaultWorkers, headlessCategory } from './headless'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Day 16(+): human-friendly byte size for the download toast.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Shorten text but break at a word boundary — a blunt slice() ends messages
 * mid-word ("…8 × loca"), which reads as broken rather than trimmed. Mirrors
 * clip() in main/xbrowser.ts, which trims the same errors upstream.
 */
function clip(s: string, max = 300): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

// Day 9: the checks offered by the assertion chooser, in display order.
// checked/unchecked only make sense on a checkbox/radio — the chooser hides
// them unless the picked element reported a live `checked` state (Day 11).
const ASSERT_KINDS: AssertKind[] = [
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
const ASSERT_LABELS: Record<AssertKind, string> = {
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
// Day 13: network evidence lines carry [site] / [third-party] tags (whose
// server failed — stamped at capture in main). Third-party noise is shown
// DIMMED and sorted last, never hidden: the tag is a fact, not a judgment.
// MIRROR WARNING: tag text + ordering must match relationTag (main/index.ts)
// and siteFirst (main/translator.ts).
const isThirdPartyLine = (l: string): boolean => l.includes('[third-party]')
const siteFirstLines = (lines: string[]): string[] =>
  [...lines].sort((a, b) => Number(isThirdPartyLine(a)) - Number(isThirdPartyLine(b)))

// Day 13: how the analysis modal names each verdict.
const VERDICT_LABELS: Record<FailureVerdict, string> = {
  'app-bug': 'App bug',
  'test-bug': 'Test bug',
  timing: 'Timing',
  environment: 'Environment',
  unknown: 'Unclassified'
}

// F9 (finer categories): the precise triage sub-type shown beside the verdict.
const CATEGORY_LABELS: Record<FailureCategory, string> = {
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
const CATEGORY_WHY: Record<FailureCategory, string> = {
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
const A11Y_IMPACT_ORDER: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3
}
const a11yImpactRank = (impact: string): number => A11Y_IMPACT_ORDER[impact] ?? 4

// F14: a one-line "what does this measure" for each perf metric, shown under
// its name in the panel so the numbers explain themselves. Lower is better for
// all of them.
const PERF_METRIC_HELP: Record<string, string> = {
  lcp: 'How fast the main content appears',
  cls: 'How much the layout jumps around while loading',
  fcp: 'When the first pixels paint (context — no gate)',
  ttfb: 'How fast the server sends the first byte (context — no gate)',
  load: 'Everything finished loading (info only)',
  dcl: 'HTML parsed and ready (info only)'
}

// These kinds compare against an expected value the user can edit.
const assertNeedsValue = (kind: AssertKind): boolean =>
  kind === 'text-equals' ||
  kind === 'text-contains' ||
  kind === 'value' ||
  kind === 'count' ||
  kind === 'attribute' ||
  kind === 'class' ||
  kind === 'url-contains' ||
  kind === 'title' ||
  kind === 'nl'

// The candidate the step's primary selector points at. After a hand-pick the
// primary is no longer necessarily the top-scored candidates[0].
function primaryCandidate(step: RecorderStep): SelectorCandidate | undefined {
  return step.candidates?.find((c) => c.locator === step.selector) ?? step.candidates?.[0]
}

// Map a stability score (0–100) to a traffic-light class for the dot.
function stabilityClass(score: number | undefined): string {
  if (score === undefined) return ''
  if (score >= 80) return 'high'
  if (score >= 50) return 'med'
  return 'low'
}

// F28: locales the localization sweep can run the flow under. en-US is the base
// everything else is compared against (a string that DIDN'T change from base is a
// likely-untranslated candidate). ar is included to exercise RTL layout.
const LOCALE_PRESETS: { code: string; label: string; rtl?: boolean }[] = [
  { code: 'en-US', label: 'English (US) — base' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'de-DE', label: 'German (long words)' },
  { code: 'fr-FR', label: 'French' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'ar', label: 'Arabic (RTL)', rtl: true }
]

interface LocaleResult {
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

/**
 * F39.1 — the blocking screen shown while a parallel batch runs.
 *
 * A parallel run has nothing to watch: it's a headless Playwright process, so
 * the embedded browser sits idle and the only feedback used to be a one-line
 * status at the very top of the library — nowhere near the button you pressed.
 * The honest reading of that was "nothing happened", so you click other things,
 * during a run that is writing to your test files.
 *
 * So: a banner pinned to the window, not to the page. `position: fixed` is the
 * whole point — the old status line was in the library's normal flow at the very
 * top, so by the time you'd scrolled down to the button that starts the run, the
 * only thing telling you it HAD started was off-screen.
 *
 * It does NOT block the app, and `pointer-events: none` means it can never eat a
 * click — it reports, nothing more. Deliberately no elapsed clock and no counter:
 * a number invites you to read something into it, and Playwright tells us nothing
 * until the whole batch returns. Spinner says "alive", sentence says what's
 * happening, and that's the entire message.
 */
function ParallelRunBanner({
  count,
  workers
}: {
  count: number
  workers: number
}): React.JSX.Element {
  return (
    <div className="run-banner" role="status" aria-live="polite">
      <span className="run-banner-spinner" aria-hidden="true" />
      <span>
        <strong>
          Running {count} test{count === 1 ? '' : 's'}…
        </strong>{' '}
        {workers} at a time, in the background. This takes a couple of minutes — your results appear
        when it finishes.
      </span>
    </div>
  )
}

function App(): React.JSX.Element {
  const [urlInput, setUrlInput] = useState('')
  // The page the embedded browser is ACTUALLY on, as a ref. `urlInput` is the
  // address-bar text — the user can type in it without navigating — and a state
  // value read inside the edge-case loop's async closure would be stale anyway.
  // F20 reads this after each variant to learn where that variant ended up.
  const liveUrlRef = useRef('')
  const [hasNavigated, setHasNavigated] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [steps, setSteps] = useState<RecorderStep[]>([])
  // Day 17 (multiple windows): the open browser tabs. Empty/one = strip hidden.
  const [tabs, setTabs] = useState<TabInfo[]>([])
  // The generated Playwright code shown in the export modal (null = closed).
  const [exportCode, setExportCode] = useState<string | null>(null)
  // {{env:…}} names the OS also defines (USERNAME, PATH, TEMP…). Warned about in
  // the export modal, where the token can still be renamed.
  const [exportEnvWarning, setExportEnvWarning] = useState<string[]>([])
  const [savedPath, setSavedPath] = useState<string | null>(null)
  // Files an export wrote BESIDES the spec (page class, CI workflow, config).
  // The save dialog names only the spec, so without this they look unwritten.
  const [savedExtras, setSavedExtras] = useState<string[]>([])
  // A different page class already lived at that path — the class name comes from
  // the TEST name, so two same-named tests silently replace each other's.
  const [savedPageOverwritten, setSavedPageOverwritten] = useState(false)
  // Day 17 (page-object export): toggle between inline and full POM output.
  const [poExport, setPoExport] = useState(false)
  // F33 (CI export): also write a GitHub Actions workflow beside the spec.
  const [exportCi, setExportCi] = useState(false)
  // F17 (cross-browser): also write a playwright.config.ts (chromium/firefox/
  // webkit projects) beside the spec.
  const [exportXbrowser, setExportXbrowser] = useState(false)
  // POM mode produces a SECOND file (the page class). Null = inline (one file).
  const [exportPage, setExportPage] = useState<string | null>(null)
  const [exportPageFileName, setExportPageFileName] = useState('')
  const [exportTab, setExportTab] = useState<'spec' | 'page'>('spec')
  // Replay state: which step is running, which finished, which failed + why.
  const [isReplaying, setIsReplaying] = useState(false)
  const [replayingIndex, setReplayingIndex] = useState<number | null>(null)
  const [doneIndices, setDoneIndices] = useState<Set<number>>(new Set())
  const [failedIndex, setFailedIndex] = useState<number | null>(null)
  const [whatChanged, setWhatChanged] = useState<DomDiff | null>(null) // F8
  const [whatChangedOpen, setWhatChangedOpen] = useState(false) // F8: panel toggle
  const [replayError, setReplayError] = useState<string | null>(null)
  // Step editor: which step's value is being edited inline (null = none) + its
  // working text. Editing is only allowed when not recording / not replaying.
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  // Candidate transparency (Day 10c): which step's full selector ladder is
  // expanded under its row (null = all collapsed).
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  // Day 9: element picking + assertion authoring. `insertAt` is where the new
  // step will land (null = append at the end); `pickedElement` being non-null
  // opens the assertion chooser panel.
  const [isPicking, setIsPicking] = useState(false)
  const [pickedElement, setPickedElement] = useState<PickedElement | null>(null)
  // F37: when set, the next picked element BINDS to this existing step index
  // (a for-each loop's collection / an if's condition target) rather than
  // creating a new step. A ref because the pick listener is registered once at
  // mount and would capture a state value stale.
  const pickBindRef = useRef<number | null>(null)
  // Found by Surbhi while testing F37: you click ＋ on a step in the MIDDLE of
  // the list, pick an element — and the check panel opens somewhere else on
  // screen. Your attention is at the insertion point; the response isn't. It
  // reads as "nothing happened". Longer lists (which loops encourage) make it
  // worse. Bring the panel to you instead.
  const checkPanelRef = useRef<HTMLDivElement | null>(null)
  const [assertKind, setAssertKind] = useState<AssertKind>('visible')
  const [nlClaim, setNlClaim] = useState('') // F19: the plain-English AI-check claim being typed
  const [assertValue, setAssertValue] = useState('')
  // For the two-part 'attribute' check: WHICH attribute to read (e.g. href).
  const [assertAttr, setAssertAttr] = useState('')
  const [insertAt, setInsertAt] = useState<number | null>(null)
  // Which row's "insert here" mini-menu is open (null = none).
  const [insertMenuIndex, setInsertMenuIndex] = useState<number | null>(null)
  // Day 11 — test library. The current test's identity (empty/null = an
  // unsaved recording) + the saved-tests list shown on the welcome screen.
  const [savedTests, setSavedTests] = useState<SavedTestSummary[]>([])
  // F9 (Stage 2): when set, the library shows ONLY the currently-failing tests of
  // this category — the drill-in from the failure-breakdown strip.
  const [failureFilter, setFailureFilter] = useState<FailureCategory | null>(null)
  // F9 (Stage 2): the breakdown lives at the BOTTOM of the library and is
  // COLLAPSED by default (a quiet toggle) — failures shouldn't dominate on open.
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  // A1 (scalable library): free-text search + a status filter, so a big library
  // (hundreds of tests) stays navigable. Compose with the F9 category drill-in.
  const [librarySearch, setLibrarySearch] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'failing' | 'passing' | 'flaky'>(
    'all'
  )
  // A2 (scalable library): fileNames ticked for a bulk action (run / delete).
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set())
  // Day 18 — auto-saved drafts (unsaved in-progress recordings). `draftIdRef`
  // is the current recording's draft id; the timer debounces the auto-save.
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const draftIdRef = useRef<string | null>(null)
  const draftSaveTimer = useRef<number | null>(null)
  const [draftDismissed, setDraftDismissed] = useState(false)
  // Welcome screen: which test's last-run error detail is expanded (by fileName).
  const [errorOpenFor, setErrorOpenFor] = useState<string | null>(null)
  const [testName, setTestName] = useState('')
  const [testFileName, setTestFileName] = useState<string | null>(null)
  const [baseURL, setBaseURL] = useState('')
  // Day 17 — session reuse: the storageState file attached to this test (start
  // logged in), and the list of saved sessions to pick from.
  const [storageState, setStorageState] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<string[]>([])
  // F39.2: per-session expiry, keyed by file name. Drives the "expired" labels
  // and the run-report warning — see refreshSessions.
  const [sessionStatus, setSessionStatus] = useState<
    Record<string, { expiresAt: number | null; expired: boolean }>
  >({})
  // F1 (HAR): the capture toggle, how many responses the last capture kept, the
  // loaded test's saved HAR (replayed against when present), and the last run's
  // HAR usage (served vs live) for the readout.
  const [captureNetwork, setCaptureNetwork] = useState(false)
  const [harCount, setHarCount] = useState(0)
  const [harField, setHarField] = useState<string | undefined>(undefined)
  // F12: past edits of the loaded test + the history modal state (which version
  // is selected for the diff).
  const [testVersions, setTestVersions] = useState<TestVersion[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIdx, setHistoryIdx] = useState(0)
  const [lastHarUsage, setLastHarUsage] = useState<{ served: number; passthrough: number } | null>(
    null
  )
  // Keep main's capture flag in sync with the toggle, and learn the count when
  // a recording that captured network stops.
  useEffect(() => {
    window.api.har.setEnabled(captureNetwork)
  }, [captureNetwork])
  useEffect(() => window.api.har.onCaptured(({ count }) => setHarCount(count)), [])
  // Day 17(+): seed a saved session into the LIVE browser so a NEW recording
  // starts already logged in. `useSessionSel` = the chosen session on the welcome
  // screen; `applyingSession` gates the button while it seeds.
  const [useSessionSel, setUseSessionSel] = useState('')
  const [applyingSession, setApplyingSession] = useState(false)
  const [useSessionError, setUseSessionError] = useState<string | null>(null)
  // Day 17 — viewport emulation: the device viewport this test renders at
  // (undefined = desktop / fill the window).
  const [viewport, setViewport] = useState<{ width: number; height: number } | undefined>(undefined)
  // F36 — which DEVICE profile that viewport came from. Kept beside `viewport`
  // rather than replacing it: `viewport` stays the source of truth for size (so
  // pre-F36 tests are untouched) and this adds the UA/touch/density signals.
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined)
  // F38 — cross-cutting labels on the CURRENT test (@smoke, @regression). One
  // suite, many tags.
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  // F38 — which tags the library list is filtered to (AND across them).
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  // F39 — run a batch through headless Playwright, several at a time. OFF by
  // default and always opt-in: it's faster but it runs the EXPORTED spec, which
  // has no self-heal and no recovery pause. Sequential in-app stays the default
  // because it's the more faithful run, not because it's the older one.
  const [parallelMode, setParallelMode] = useState(false)
  const [parallelWorkers, setParallelWorkers] = useState(defaultWorkers())
  // Why a given test was pushed out of the parallel batch (per fileName), so the
  // report can explain it rather than just showing a slower run.
  const parallelSkipReasons = useRef<Map<string, string>>(new Map())
  const [parallelNote, setParallelNote] = useState<string | null>(null)
  // === F40: shareable bundles ===
  const [bundleBusy, setBundleBusy] = useState(false)
  const [bundleResult, setBundleResult] = useState<{
    path: string
    manifest: BundleManifest
  } | null>(null)
  // An inspected bundle awaiting a per-collision decision. Nothing is written
  // until the user applies the plan.
  const [importPlan, setImportPlan] = useState<{
    bundleDir: string
    manifest?: BundleManifest
    tests: BundleTestPreview[]
    choices: Record<string, 'keep-both' | 'overwrite' | 'skip'>
  } | null>(null)
  const [importDone, setImportDone] = useState<string | null>(null)
  // F40: what the one-time plaintext-secret migration moved, if anything.
  const [secretMigration, setSecretMigration] = useState<{
    migrated: number
    tests: string[]
  } | null>(null)
  const [savePanelOpen, setSavePanelOpen] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState('')
  // Pillar 4 — reusable step blocks: named, saved step sequences you record once
  // and insert into other tests. `blocks` = the saved list; the panel both SAVES
  // a range of the current steps as a block and INSERTS a chosen block. When
  // opened from a row's ＋ menu, `blockInsertAt` says where inserted steps land
  // (null = append). `blockFrom`/`blockTo` are the 1-based range to save.
  const [blocks, setBlocks] = useState<BlockSummary[]>([])
  const [blocksPanelOpen, setBlocksPanelOpen] = useState(false)
  // Which block's ✕ delete is "armed" — deleting a block is destructive and had
  // no confirm, so the first click arms it ("Sure?") and a second click within a
  // few seconds actually deletes. Auto-disarms so a stray arm never lingers.
  const [pendingDeleteBlock, setPendingDeleteBlock] = useState<string | null>(null)
  const [blockNameInput, setBlockNameInput] = useState('')
  const [blockInsertAt, setBlockInsertAt] = useState<number | null>(null)
  const [blockFrom, setBlockFrom] = useState(1)
  const [blockTo, setBlockTo] = useState(1)
  // Live-link blocks (v2): a `block` step is a REFERENCE. `blockCache` maps a
  // block's file name → its steps, loaded on demand, so the UI can show a linked
  // block's contents and derive its data columns. `editingBlockRef` is set while
  // a block's steps are loaded into the editor to update the block itself.
  const [blockCache, setBlockCache] = useState<Record<string, RecorderStep[]>>({})
  const [editingBlockRef, setEditingBlockRef] = useState<string | null>(null)
  // F7 (blast-radius): block fileName → the saved tests that live-link it, so the
  // panel can show "used by N tests" and warn before an edit changes them all.
  const [blockUsage, setBlockUsage] = useState<Record<string, BlockLink[]>>({})
  // F7: minimise the blocks panel (▾/▸) to hand the whole sidebar to the step
  // list — needed when editing a block with many steps.
  const [blocksCollapsed, setBlocksCollapsed] = useState(false)
  // The user's OWN test steps, stashed while they detour into editing a block.
  // Editing a block loads its steps into the editor; this holds their recording
  // so it's restored (never discarded) when the block edit finishes or cancels.
  const [stashedSteps, setStashedSteps] = useState<RecorderStep[] | null>(null)
  // Replace each linked `block` step with the block's CACHED steps (a disabled
  // block expands to nothing). Identity for a test with no block steps, so normal
  // tests are unaffected. Used for display/data-columns (run uses expandForRun).
  const expandSteps = (list: RecorderStep[]): RecorderStep[] =>
    list.flatMap((s) =>
      s.type === 'block' ? (s.disabled || !s.blockRef ? [] : (blockCache[s.blockRef] ?? [])) : [s]
    )
  // Day 17 (session reuse): the name to save the current browser session under.
  const [sessionNameInput, setSessionNameInput] = useState('')
  // Inline editing of the test's base URL (the environment switch).
  const [editingBase, setEditingBase] = useState(false)
  const [baseEditValue, setBaseEditValue] = useState('')
  // F25 (environment manager): named { baseURL + credentials } environments, one
  // active at a time — so the WHOLE suite can run against dev / staging / prod
  // without editing (or duplicating) a single test. The active env re-points
  // navigations at run time AND supplies the {{env:NAME}} credential values.
  const [envState, setEnvState] = useState<EnvState>({
    version: 1,
    activeId: null,
    environments: [],
    retargetSuppress: {}
  })
  const [envManagerOpen, setEnvManagerOpen] = useState(false)
  // F25+: switch the active environment straight from the workspace chip, so you
  // never have to go Home (which drops an unsaved recording) just to change it.
  const [envSwitchOpen, setEnvSwitchOpen] = useState(false)
  // F32 — scheduled monitors. The list, the dashboard modal, a busy-guard so two
  // headless runs never overlap, and the "promote a test" form. The scheduler
  // itself ticks in an effect further down (it reuses xbrowser.run).
  const [monitors, setMonitors] = useState<Awaited<ReturnType<typeof window.api.monitors.list>>>(
    []
  )
  const [monitorsOpen, setMonitorsOpen] = useState(false)
  const monitorBusyRef = useRef(false)
  // F32b: optional Slack/Discord/Teams webhook — alerts reach you off-machine.
  const [monWebhook, setMonWebhook] = useState(() => localStorage.getItem('monitor.webhookUrl') || '')
  const [monTestSel, setMonTestSel] = useState('') // fileName to promote
  const [monInterval, setMonInterval] = useState(15) // minutes
  const [monAlert, setMonAlert] = useState(true)
  const [monEnvId, setMonEnvId] = useState('') // pinned env for a NEW monitor ('' = recorded URLs)
  const [monHistoryFor, setMonHistoryFor] = useState<string | null>(null) // expanded monitor id
  const [monRunningId, setMonRunningId] = useState<string | null>(null) // a run in progress (UI)
  // F23 — coverage gap map: the crawl result + which pages the saved tests cover.
  const [coverageOpen, setCoverageOpen] = useState(false)
  const [coverageRun, setCoverageRun] = useState<{
    running: boolean
    found: number
    result: Awaited<ReturnType<typeof window.api.coverage.crawl>> | null
    coveredExact: Set<string>
    // each url-contains assert remembers the origin(s) of the test it came from,
    // so coverage credit is scoped to the site actually crawled (not cross-site).
    coveredContains: { value: string; origins: string[] }[]
  } | null>(null)
  // Offer the browser somewhere sensible to break a long URL in the steps panel.
  //
  // `.step-text` is already `word-break: break-word`, which breaks mid-word only
  // when a word genuinely cannot fit — and in a narrow panel a URL cannot, so
  // "https://www.saucedemo.com/login" came out as "https://www." / "saucedemo.c"
  // / "om/login". No CSS property says "prefer to break at a slash", so the
  // break opportunities are inserted here: a zero-width <wbr> after each
  // separator. The text itself is unchanged — copying the step still yields the
  // original URL, since <wbr> contributes no characters.
  //
  // Done at the RENDER site, not in stepText(): that string also feeds living
  // docs (markdown) and the exported spec's comments, where markup would be
  // wrong.
  const withUrlBreaks = (text: string): React.ReactNode => {
    if (!/[/.?&=_-]/.test(text)) return text
    const parts = text.split(/(?<=[/.?&=_-])/)
    if (parts.length < 2) return text
    return parts.map((p, i) => (
      <span key={i}>
        {p}
        {i < parts.length - 1 && <wbr />}
      </span>
    ))
  }

  // Normalise a URL path for coverage matching (drop query/hash + trailing slash).
  const normCovPath = (p: string): string => {
    const q = (p || '/').split('?')[0].split('#')[0].replace(/\/+$/, '')
    return q || '/'
  }
  // The environment being edited in the manager (null = the list view).
  const [envDraft, setEnvDraft] = useState<Environment | null>(null)
  // F20 (edge-case explosion): the picker (choose fields + families to explode),
  // and the run/report that follows. `edgeFlat`/`edgeMap` are the flattened steps
  // the variants are built from (blocks expanded once, like a data run).
  const [edgeModalOpen, setEdgeModalOpen] = useState(false)
  const [edgeFlat, setEdgeFlat] = useState<RecorderStep[]>([])
  const [edgeMap, setEdgeMap] = useState<number[]>([])
  const [edgeFields, setEdgeFields] = useState<Set<number>>(new Set())
  const [edgeGroups, setEdgeGroups] = useState<Set<EdgeGroup>>(
    new Set<EdgeGroup>(['empty', 'boundary', 'invalid', 'injection'])
  )
  // F20 export: path of the last saved negative-suite .spec.ts (for the "saved
  // to…" note in the report), null until exported.
  const [edgeSuiteSaved, setEdgeSuiteSaved] = useState<string | null>(null)
  // F20 (Option 2): the report is a modal you can CLOSE without discarding the
  // run — `edgeReportOpen` gates the modal (and the browser-hide) separately
  // from `edgeRun` (the data), so closing keeps the run re-openable. Persisted
  // batches for the loaded test are listed in `edgeRunHistory`; `edgeViewingHistory`
  // is true when the open report came from history (no steps → hide Export).
  const [edgeReportOpen, setEdgeReportOpen] = useState(false)
  const [edgeViewingHistory, setEdgeViewingHistory] = useState(false)
  const [edgeRunHistory, setEdgeRunHistory] = useState<EdgeRunSummary[]>([])
  // F17 (cross-browser): the runner modal — pick engines, run real Playwright,
  // show per-browser pass/fail. `xbInstalled` null = not checked yet.
  const [xbOpen, setXbOpen] = useState(false)
  const [xbSel, setXbSel] = useState<Set<string>>(
    new Set(['chromium', 'firefox', 'webkit'])
  )
  const [xbRunning, setXbRunning] = useState(false)
  const [xbInstalled, setXbInstalled] = useState<boolean | null>(null)
  // The app ships Playwright's RUNNER but not its ~400 MB of browser binaries,
  // so a fresh install can run nothing headlessly until they're downloaded.
  // `xbBrowsers` = which engines are present; the modal offers to fetch them and
  // `xbInstallLog` shows the last progress line so a long download isn't silent.
  const [xbBrowsers, setXbBrowsers] = useState<{ chromium: boolean; all: boolean } | null>(null)
  const [xbInstalling, setXbInstalling] = useState(false)
  const [xbInstallLog, setXbInstallLog] = useState('')
  // Set when a run refuses for want of an engine. Needed as well as the check
  // above because the PARTIAL case exists: Chromium downloaded but WebKit not,
  // so `chromium: true` while a WebKit run still can't start.
  const [xbNeedDownload, setXbNeedDownload] = useState(false)
  // F25 guard: pending host-mismatch warning. `resolve` settles the promise the
  // run is awaiting, so the modal's buttons drive the run's next move.
  // One entry per DISTINCT recorded host the active env would retarget. A single
  // replay yields one; a suite spanning several sites yields several.
  const [envWarn, setEnvWarn] = useState<{
    mismatches: { from: string; to: string; tests: string[] }[]
    // F24: hosts this run's API steps will call that the environment does NOT
    // cover — they are NOT retargeted and will hit those hosts as recorded.
    apiHosts: { host: string; tests: string[] }[]
    resolve: (choice: 'run' | 'noenv' | 'cancel') => void
  } | null>(null)
  const [envWarnRemember, setEnvWarnRemember] = useState(false)
  const [warnsReset, setWarnsReset] = useState(false)
  // F24 (API test step): the step index being edited + a working draft. The
  // editor commits on Save, so an abandoned edit doesn't mutate the step.
  const [apiEditIndex, setApiEditIndex] = useState<number | null>(null)
  const [apiDraft, setApiDraft] = useState<RecorderStep | null>(null)
  // F24: the LAST run's HTTP exchange per API step (display index → evidence),
  // captured on pass as well as fail. `apiPanelIndex` is the row whose response
  // panel is expanded. Without this a green API step is unverifiable: "body
  // contains id" passes on {"id": null, "status": "FAILED"} and you'd never know.
  const [apiResponses, setApiResponses] = useState<Record<number, ApiEvidence>>({})
  const [apiPanelIndex, setApiPanelIndex] = useState<number | null>(null)
  // F15 (smarter visual diffing): snapshot step being edited + its draft, plus a
  // transient status for the "re-capture baseline" action.
  const [snapEditIndex, setSnapEditIndex] = useState<number | null>(null)
  const [snapDraft, setSnapDraft] = useState<RecorderStep | null>(null)
  const [snapStatus, setSnapStatus] = useState<string>('')
  // The re-capture runs AFTER the modal closes (so the native browser doesn't flash
  // up over it), so its progress shows in a top-right toast instead of in the modal.
  const [snapToast, setSnapToast] = useState<'busy' | 'ok' | 'fail' | null>(null)
  // F18 (plain-English AI Prompt step): the intent prompt, busy state, and any note.
  const [aiPromptOpen, setAiPromptOpen] = useState(false)
  const [aiPromptText, setAiPromptText] = useState('')
  const [aiPromptNote, setAiPromptNote] = useState('')
  // F22 (draft from story / PR diff): the story text, an optional loaded repo diff,
  // busy/note state, and the generated draft (title + steps) shown for review before
  // it's inserted into the test.
  const [draftOpen, setDraftOpen] = useState(false)
  const [draftStory, setDraftStory] = useState('')
  const [draftDiff, setDraftDiff] = useState<{ text: string; summary: string } | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftNote, setDraftNote] = useState('')
  const [draftResult, setDraftResult] = useState<{
    title: string
    steps: RecorderStep[]
    guessed: number[] // navigate steps whose URL was guessed — shown ⚠ for review
  } | null>(null)
  // F35 (Mock Studio): edit a captured API response into a scenario mock (force a
  // 500, empty a list, flip a flag) and export the Playwright route/fulfill. The
  // entries come from the last HAR capture; mockSel indexes into mockEntries.
  const [mockOpen, setMockOpen] = useState(false)
  const [mockEntries, setMockEntries] = useState<
    Awaited<ReturnType<typeof window.api.har.mockList>>['entries']
  >([])
  const [mockSel, setMockSel] = useState<number | null>(null)
  const [mockStatus, setMockStatus] = useState('200')
  const [mockBody, setMockBody] = useState('')
  const [mockNote, setMockNote] = useState('')
  // F35: brief "✓ Copied!" flash ON the copy button (the old note rendered at the
  // bottom of the modal, below the fold, so the click felt dead).
  const [mockCopied, setMockCopied] = useState(false)
  // F21 (bug → regression test): paste a bug's repro + expected result; AI reproduces
  // it and appends a plain-English assertion of the expected behaviour.
  const [bugPromptOpen, setBugPromptOpen] = useState(false)
  const [bugReproText, setBugReproText] = useState('')
  const [bugExpectedText, setBugExpectedText] = useState('')
  // Generation runs AFTER the modal closes (so the native browser we must show to
  // read the page doesn't flash up over it), so its progress/result shows in a
  // top-right toast instead of inside the modal.
  const [aiToast, setAiToast] = useState<{ tone: 'progress' | 'ok' | 'warn' | 'fail'; msg: string } | null>(null)
  // F27 (creates-data): which step is being labelled, and the draft label. Electron
  // does not implement window.prompt() — it shows nothing and returns null — so the
  // label has to be collected by a real modal like every other dialog here.
  const [createsDataIndex, setCreatesDataIndex] = useState<number | null>(null)
  const [createsDataDraft, setCreatesDataDraft] = useState('')
  // F31 (living docs): a generated plain-English doc of the current test.
  const [docOpen, setDocOpen] = useState(false)
  const [docContent, setDocContent] = useState('')
  const [docSavedPath, setDocSavedPath] = useState<string | null>(null)
  // F31 (AC checklist): acceptance criteria (one per line) + their AI coverage map.
  const [acOpen, setAcOpen] = useState(false)
  const [acText, setAcText] = useState('')
  const [acResult, setAcResult] = useState<{ ac: string; tests: string[] }[] | null>(null)
  const [acBusy, setAcBusy] = useState(false)
  const [acFailed, setAcFailed] = useState(false) // Claude was unavailable
  // F28 (localization sweep): the picker, selected locales, and the run + report.
  const [localeOpen, setLocaleOpen] = useState(false)
  const [localeSel, setLocaleSel] = useState<Set<string>>(
    () => new Set(['en-US', 'es-ES', 'de-DE', 'ar'])
  )
  const [localeRun, setLocaleRun] = useState<{
    total: number
    current: number
    currentLabel: string
    running: boolean
    results: LocaleResult[]
  } | null>(null)
  const [localeReportOpen, setLocaleReportOpen] = useState(false)
  const [xbResult, setXbResult] = useState<Awaited<
    ReturnType<typeof window.api.xbrowser.run>
  > | null>(null)
  // The streaming edge-case run + its per-variant outcomes (null = not running).
  const [edgeRun, setEdgeRun] = useState<{
    total: number
    current: number
    currentLabel: string
    running: boolean
    hasAssertion: boolean // did the test have a success check? (drives the verdict)
    // The user's explicit success rule ('' = judge automatically), and the page
    // the flow starts on — the automatic verdict needs it to know whether
    // "success moves the page" is even true for this app.
    successUrl: string
    startUrl: string
    results: {
      case: EdgeCase
      ok: boolean
      failedAt?: number
      error?: string
      screenshotPath?: string
      traceId?: string // F20: each variant keeps its OWN run recording
      finalUrl?: string // where this variant ended — drives the inferred verdict
    }[]
  } | null>(null)
  // F20: an explicit success rule, typed in the 🧨 modal. Empty = judge
  // automatically (the test's ✓ check, else the baseline's final URL).
  const [edgeSuccessUrl, setEdgeSuccessUrl] = useState('')
  // Day 11.5 — sections (suites). The section list, the current test's
  // section, and the save panel's chosen/typed section.
  const [suites, setSuites] = useState<string[]>([])
  const [testSuite, setTestSuite] = useState('')
  const [saveSuite, setSaveSuite] = useState('Daily')
  const [newSuiteInput, setNewSuiteInput] = useState('')
  // Day 11.5 — failure screenshot of the LAST replay (📷 in the banner).
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(null)
  // Day 18 — run trace. `traceMode` mirrors Playwright's retain policy; the
  // viewer opens a saved trace (manifest + the selected step's full image).
  const [traceMode, setTraceMode] = useState<'always' | 'failure' | 'off'>(
    () => (localStorage.getItem('qaflow.traceMode') as 'always' | 'failure' | 'off') || 'failure'
  )
  const [lastTraceId, setLastTraceId] = useState<string | null>(null)
  // F29 (chaos): replay under a throttled (~Slow 3G) network to test resilience /
  // surface timing flakiness. Off by default.
  const [chaosSlowNet, setChaosSlowNet] = useState(false)
  // Day 20: every failed step of the last replay (Continue can bypass several),
  // so the banner can surface each one's screenshot/explanation. `failDetail`
  // is which inline list is expanded ('shots' | 'explain' | null) — only when
  // more than one step failed.
  const [lastFailures, setLastFailures] = useState<
    { index: number; error: string; screenshotPath?: string; apiEvidence?: ApiEvidence }[]
  >([])
  const [failDetail, setFailDetail] = useState<'shots' | 'explain' | null>(null)
  const [traceView, setTraceView] = useState<TraceManifest | null>(null)
  const [traceStepIdx, setTraceStepIdx] = useState(0)
  const [traceImg, setTraceImg] = useState<string | null>(null)
  const [traceSavedAt, setTraceSavedAt] = useState<string | null>(null)
  // F13 (accessibility scan): the last scan's result (null = panel closed) and
  // whether a scan is in flight (the panel opens immediately, showing a spinner).
  const [a11yScan, setA11yScan] = useState<A11yScanResult | null>(null)
  const [a11yScanning, setA11yScanning] = useState(false)
  // F13: the budget chosen when adding the scan as a reusable test step — the
  // least severe impact that still fails the check (default critical+serious).
  const [a11yAddLevel, setA11yAddLevel] = useState('serious')
  // F14 (performance): the last Core Web Vitals measurement (null = panel
  // closed), whether a measure is in flight, and the budget for the added step.
  const [perfResult, setPerfResult] = useState<PerfResult | null>(null)
  const [perfMeasuring, setPerfMeasuring] = useState(false)
  const [perfAddLevel, setPerfAddLevel] = useState('needs-improvement')
  // Day 11.5 — suite runner: which section is running, per-test outcomes so
  // far, and whether the run has finished (summary shows then).
  interface SuiteRunEntry {
    fileName: string
    name: string
    status: 'passed' | 'failed'
    failedAt?: number
    error?: string
    screenshotPath?: string
    category?: FailureCategory // B: failure type (for the by-category breakdown)
    healed?: number // B: selectors auto-healed in this test's run
    // F25: {{env:NAME}} tokens that resolved to NOTHING for this test. A suite
    // run is `silent`, so the workspace panel that normally reports this is never
    // touched — and the reader is looking at the suite report anyway. Without it
    // here, a test that typed an empty username fails several steps later as
    // "stale data", an explanation that points at the test rather than the
    // environment. Carried per-test because a suite can mix tests that need
    // different variables.
    unresolvedEnv?: string[]
    // F39: this result came from the headless parallel batch, not the in-app
    // replay engine. Shown in the report because the two aren't equivalent —
    // no self-heal, no recovery pause — so the reader should know which ran it.
    ranParallel?: boolean
  }
  // B: a test whose selectors auto-healed this run, with the repaired steps ready
  // to persist — "Save all healed" in the report writes them all at once.
  interface HealedSave {
    fileName: string
    name: string
    saveInput: {
      name: string
      baseURL: string
      suite: string
      steps: RecorderStep[]
      storageState?: string
      viewport?: { width: number; height: number }
      deviceId?: string // F36: a healed save must not drop the test's device
      tags?: string[] // F38: …nor its labels
      dataRows?: Record<string, string>[]
    }
  }
  // Option 2: a failed test whose selector self-heal COULD fix (found but not
  // confident) — surfaced in the report for human review & one-click accept.
  interface HealableFail {
    fileName: string
    name: string
    suite: string
    hasBlocks: boolean // block tests: index may not map to display steps — review only
    healable: { index: number; label: string; signals: string[]; score: number; step: RecorderStep }
  }
  const [suiteRun, setSuiteRun] = useState<{
    suite: string
    total: number
    current: number // 1-based index of the test running now
    currentName: string
    results: SuiteRunEntry[]
    running: boolean
    healedSaves?: HealedSave[] // B: healed tests captured this run (for Save all)
    healedSaved?: boolean // B: the user already clicked Save all healed
    healables?: HealableFail[] // Option 2: failed-but-healable tests to review
    accepted?: string[] // Option 2: fileNames whose healable fix was accepted
    // F39: how many tests are in flight in the parallel batch. While this is
    // set, the "X of Y" counter is meaningless — one Playwright process runs
    // them ALL AT ONCE and reports back only at the end, so there is no
    // step-by-step progress to show. Displaying "0 of 4" the whole time reads
    // as "nothing is happening", so the progress line switches wording instead.
    parallelBatch?: number
  } | null>(null)

  // Day 20 — data-driven runs. The table of rows this test runs against (each
  // row = a { column: value } map; columns are DERIVED from the {{tokens}} in
  // the steps, so they're never stored separately). `dataPanelOpen` toggles the
  // grid; `dataRun` mirrors suiteRun for the per-row run summary.
  const [dataRows, setDataRows] = useState<Record<string, string>[]>([])
  const [dataPanelOpen, setDataPanelOpen] = useState(false)
  interface DataRunEntry {
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
  const [dataRun, setDataRun] = useState<{
    total: number
    current: number // 1-based index of the row running now
    currentLabel: string
    results: DataRunEntry[]
    running: boolean
  } | null>(null)
  // Which inline tab is expanded under the data-run banner (null = just the
  // banner). The tabs + their content live IN the steps panel, not a modal:
  // 'evidence' = each failed row's screenshot + recording; 'explain' = each
  // failed row, opened one by one for a diagnosis.
  const [dataTab, setDataTab] = useState<'evidence' | 'explain' | 'reports' | null>(null)
  // The overview popup that auto-appears when a data run finishes (the quick
  // "X passed, Y failed" summary). Dismissing it leaves the inline panel tabs.
  const [dataPopupDismissed, setDataPopupDismissed] = useState(false)

  // Welcome-screen accordion: which sections are EXPANDED. Starts empty, so
  // every launch begins compact — section headers only (Surbhi's call);
  // whatever you open stays open for the rest of the session.
  const [openSuites, setOpenSuites] = useState<Set<string>>(new Set())
  // While a filter is on, sections default to OPEN so matches aren't hidden.
  // That used to be absolute — `isOpen = filtering ? true : …` — so clicking a
  // header did nothing at all: the state changed and the render discarded it.
  // An explicit click has to beat an implicit rule, so a section you collapse
  // BY HAND during a filter is remembered here and stays shut.
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set())
  const toggleSuite = (key: string, filtering: boolean): void => {
    if (filtering) {
      setFilterCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      return
    }
    const next = new Set(openSuites)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpenSuites(next)
  }

  // Day 13 — failure translator + bug report. Console/network evidence of the
  // LAST failed run (from main's replay-time capture); the analysis modal's
  // state: open, thinking, the diagnosis, and the generated report (non-null
  // = the modal is showing the report view instead of the analysis view).
  const [lastConsoleErrors, setLastConsoleErrors] = useState<string[]>([])
  const [lastNetworkErrors, setLastNetworkErrors] = useState<string[]>([])
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<FailureAnalysis | null>(null)
  // F9 Stage 3: the current analysis came from Deep RCA (whole-trace) — badges it
  // and swaps the waiting message (it takes longer).
  const [isDeep, setIsDeep] = useState(false)
  // The evidence bundle the open analysis was built from — the bug report
  // generator reuses it so both documents describe the same failure.
  const [lastEvidence, setLastEvidence] = useState<FailureEvidence | null>(null)
  const [bugReport, setBugReport] = useState<string | null>(null)
  const [reportSavedPath, setReportSavedPath] = useState<string | null>(null)
  // F34: Jira ticket modal. Site/email/project persist (convenience); the API
  // token is entered per session and never stored (it's a credential).
  const [jiraOpen, setJiraOpen] = useState(false)
  const [jiraSummaryText, setJiraSummaryText] = useState('')
  const [jiraDescText, setJiraDescText] = useState('')
  const [jiraBaseUrl, setJiraBaseUrl] = useState(() => localStorage.getItem('jira.baseUrl') || '')
  const [jiraEmail, setJiraEmail] = useState(() => localStorage.getItem('jira.email') || '')
  const [jiraProject, setJiraProject] = useState(() => localStorage.getItem('jira.project') || '')
  const [jiraToken, setJiraToken] = useState('')
  const [jiraBusy, setJiraBusy] = useState(false)
  const [jiraNote, setJiraNote] = useState('')

  // Day 12 — recovery. Non-null while a replay is PAUSED at a failed step
  // (main's loop is holding for our decision: retry / re-pick / skip / stop).
  const [recovery, setRecovery] = useState<ReplayPaused | null>(null)
  // F30: replay is paused at a manual (wait-for-human) step — its instruction.
  const [manualPause, setManualPause] = useState<{ index: number; message: string } | null>(null)
  // F21b: the "add checks along a replay" ride paused on a page. You can add
  // MULTIPLE checks per page; they're placed BEFORE the page navigates away (so
  // they verify the page's final state, after its actions). `pendingClaimsRef`
  // holds the current page's checks until we know where the page ends (the next
  // navigation, or the run's end); `rideChecksRef` is the positioned result,
  // spliced into the test at the ride's end so live index-shuffling can't corrupt it.
  const [checkOffer, setCheckOffer] = useState<{ afterIndex: number; url: string } | null>(null)
  const [rideClaim, setRideClaim] = useState('')
  const [ridePending, setRidePending] = useState<string[]>([]) // current page's checks, for display
  const pendingClaimsRef = useRef<string[]>([])
  const rideChecksRef = useRef<{ afterIndex: number; claim: string }[]>([])
  const rideListLenRef = useRef(0) // run length, so the LAST page's checks land at the end
  // Which step a re-pick is healing (null = the picker is for an assertion).
  const [repickIndex, setRepickIndex] = useState<number | null>(null)
  // Steps bypassed via Skip THIS run (amber rows) — cleared on the next run.
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(new Set())
  // Steps whose selector was healed by a re-pick and not yet saved (🔧 hint).
  const [healedIndices, setHealedIndices] = useState<Set<number>>(new Set())
  // F4 (self-heal 2.0): steps main AUTO-healed this run (🤖 "fixed by AI"). Kept
  // for the live count + badge; the fix also rides on the step (healedByAi) so it
  // shows even after a 💾 save/reload.
  const [aiHealedIndices, setAiHealedIndices] = useState<Set<number>>(new Set())
  // F37: notes about branches/loops that didn't run in the last replay.
  const [branchNotes, setBranchNotes] = useState<string[]>([])
  // F25: {{env:NAME}} tokens the last run couldn't resolve — surfaced in the
  // panel so an empty substitution can't masquerade as a test-data problem.
  const [unresolvedEnv, setUnresolvedEnv] = useState<string[]>([])
  // F19: how many AI checks the CURRENTLY-RUNNING step is judging in one model
  // call. An AI check costs ~7-12s per CALL regardless of how many claims ride
  // in it, so the first check of a run pays for the whole group and the rest
  // return instantly. Unannounced, that looks like one step hanging.
  const [nlBatchCount, setNlBatchCount] = useState<number | null>(null)
  // A re-pick landed on an element with no stable hooks — explain why the
  // heal was refused (shown inside the recovery panel).
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null)
  // A re-pick whose element looks DIFFERENT from the original step — held back
  // for a "heal anyway?" confirm so a wrong pick can't silently heal (Day 17).
  const [repickPending, setRepickPending] = useState<{
    picked: PickedElement
    healIndex: number
    message: string
  } | null>(null)
  // Day 16(+): a transient download toast (record + replay). 'downloading' is
  // shown immediately on start; it resolves to 'done' (ok/empty/failed).
  const [downloadToast, setDownloadToast] = useState<
    { name: string; phase: 'downloading' } | (DownloadInfo & { phase: 'done' }) | null
  >(null)
  // Mirrors for the onPicked subscription: it's registered once (empty deps),
  // so it reads CURRENT values through refs instead of stale closed-over state.
  const repickIndexRef = useRef<number | null>(null)
  const stepsRef = useRef<RecorderStep[]>([])
  // Live-link blocks: a run executes the EXPANDED step list (blocks flattened),
  // but the UI shows the collapsed list. This maps each expanded index → its
  // display-row index, so progress/failure marks land on the right row (a
  // block's inner steps all map to the block's single row). null / identity for
  // a test with no linked blocks.
  const runPlanRef = useRef<number[] | null>(null)
  // F25: {{env:NAME}} tokens the last applyEnv could not resolve. A ref, not
  // state — applyEnv runs inside the run's async flow and a state write wouldn't
  // be visible to the code that reports the outcome.
  const unresolvedEnvRef = useRef<string[]>([])
  const toDisplayIdx = (i: number): number => runPlanRef.current?.[i] ?? i

  // A1 (scalable library): the flaky tag for a test (from its run history) + a
  // single predicate that answers "does this test pass ALL the active library
  // filters" — name search + status filter + the F9 category drill-in, ANDed.
  const testFlakyTag = (t: SavedTestSummary): FlakyTag => {
    const runs = t.runs?.length ? t.runs : t.lastRun ? [t.lastRun] : []
    return classifyRuns(runs).tag
  }
  const anyLibraryFilter = (): boolean =>
    librarySearch.trim() !== '' ||
    libraryFilter !== 'all' ||
    failureFilter !== null ||
    tagFilter.size > 0 // F38
  // A2 (bulk actions): tests ticked for a bulk operation (run / delete).
  const toggleSelect = (fileName: string): void =>
    setSelectedTests((prev) => {
      const n = new Set(prev)
      if (n.has(fileName)) n.delete(fileName)
      else n.add(fileName)
      return n
    })
  const handleRunSelected = (): void => {
    const tests = savedTests.filter((t) => selectedTests.has(t.fileName))
    if (tests.length) handleRunSuite(`${tests.length} selected tests`, tests)
  }
  const handleDeleteSelected = async (): Promise<void> => {
    const tests = savedTests.filter((t) => selectedTests.has(t.fileName))
    if (!tests.length) return
    if (
      !window.confirm(
        `Delete ${tests.length} selected test${tests.length > 1 ? 's' : ''}? This can’t be undone.`
      )
    ) {
      return
    }
    for (const t of tests) await window.api.library.remove(t.fileName)
    setSelectedTests(new Set())
    setSavedTests(await window.api.library.list())
  }
  const matchesLibraryFilters = (t: SavedTestSummary): boolean => {
    const q = librarySearch.trim().toLowerCase()
    if (q && !t.name.toLowerCase().includes(q)) return false
    if (libraryFilter === 'failing' && t.lastRun?.status !== 'failed') return false
    if (libraryFilter === 'passing' && t.lastRun?.status !== 'passed') return false
    if (libraryFilter === 'flaky' && testFlakyTag(t) !== 'flaky') return false
    // F38: AND across selected tags, composed with every other filter — so
    // "@smoke + ✗ Failing" narrows to exactly the smoke tests that are red.
    if (!matchesTags(t, tagFilter)) return false
    if (
      failureFilter &&
      !(
        t.lastRun?.status === 'failed' &&
        ((t.lastRun.category as string) || 'unknown') === failureFilter
      )
    ) {
      return false
    }
    return true
  }
  // Mirror state into the refs AFTER render (React forbids touching refs
  // during render). The onPicked subscriber only reads them when an IPC
  // event arrives, which is always after the effect has run.
  useEffect(() => {
    repickIndexRef.current = repickIndex
    stepsRef.current = steps
  }, [repickIndex, steps])

  // Steps left ON (disabled steps are skipped by replay + export).
  const enabledCount = steps.filter((s) => !s.disabled).length
  // Day 18: is this a multi-tab recording? If so, EVERY step shows which tab it
  // runs on (incl. the original "main tab") — otherwise the original tab is the
  // only one with no badge, which reads as missing/confusing.
  const multiWindow = steps.some((s) => (s.windowId ?? 0) > 0 || s.opensWindow !== undefined)
  // Day 20: the data columns this test references (derived from the {{tokens}}
  // in step values / URLs). Non-empty = this is a data-driven test.
  const dataCols = dataColumns(expandSteps(steps))
  const isDataDriven = dataCols.length > 0

  // The test's base URL when none was set yet: the ORIGIN of the first
  // navigation (https://site.com/login -> https://site.com).
  const deriveBaseURL = (list: RecorderStep[]): string => {
    const nav = list.find((s) => s.type === 'navigate' && s.url)
    if (!nav?.url) return ''
    try {
      return new URL(nav.url).origin
    } catch {
      return ''
    }
  }

  // Refresh the library list + section list + drafts whenever welcome shows.
  useEffect(() => {
    if (!hasNavigated) {
      window.api.library.list().then(setSavedTests)
      window.api.library.listSuites().then(setSuites)
      window.api.drafts.list().then(setDrafts)
    }
  }, [hasNavigated])

  // F40: move any plaintext password left in a test file into the userData
  // secret store. Runs ONCE at startup and is idempotent — a library with
  // nothing to move does nothing and says nothing. It rewrites real test files,
  // so main backs the whole library up first. Reported rather than silent,
  // because changing someone's files without telling them is not on.
  useEffect(() => {
    let cancelled = false
    window.api.xbrowser
      .migrateSecrets()
      .then((res) => {
        if (cancelled || !res?.migrated) return
        setSecretMigration(res)
      })
      .catch(() => {
        // a failed migration must never block startup — the old plaintext form
        // still runs fine, it's just less shareable.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // On mount, tell main what we're actually showing. The renderer can reload
  // (HMR in dev, a crash in production) and come back on the welcome screen
  // while main still believes a page is open — leaving the native browser view
  // painted over the library. Declaring it once at startup keeps the two in step.
  useEffect(() => {
    window.api.browser.syncNavigated(false)
  }, [])

  // Scroll the check panel into view the moment an element is picked (see
  // checkPanelRef). `block: 'nearest'` so an already-visible panel doesn't jump.
  useEffect(() => {
    if (!pickedElement) return
    checkPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [pickedElement])

  // F25: load the saved environments once (they persist in userData, app-wide).
  useEffect(() => {
    window.api.environments.list().then(setEnvState)
  }, [])

  // F32: load monitors once (app-wide, so the scheduler runs even while a test is
  // open in the workspace, not just on the welcome screen).
  useEffect(() => {
    window.api.monitors.list().then(setMonitors)
  }, [])

  // The active environment (null = run against each test's recorded URLs +
  // process.env — the pre-F25 behavior).
  const activeEnv = envState.environments.find((e) => e.id === envState.activeId) ?? null

  // F25 mutations — each resolves the whole new state, so the UI stays in sync.
  const setActiveEnv = async (id: string | null): Promise<void> =>
    setEnvState(await window.api.environments.setActive(id))
  const saveEnv = async (env: Environment): Promise<void> =>
    setEnvState(await window.api.environments.save(env))
  const deleteEnv = async (id: string): Promise<void> =>
    setEnvState(await window.api.environments.delete(id))

  // F25: apply the active environment to a run, on a COPY of the steps —
  // (1) resolve {{env:NAME}} credential tokens (main merges the env's vars over
  // process.env), and (2) re-point navigations from `fromBase` to the env's base
  // URL. The saved test is never rewritten. A no-op when there's nothing to do
  // (no env tokens AND no active base URL), so plain tests are unaffected.
  // `skipRetarget`: resolve {{env:}} vars as usual, but leave navigations on the
  // host they were recorded against. Used when the host-mismatch warning offers
  // "run without environment" — the creds are still wanted, the retarget isn't.
  const applyEnv = async (
    flat: RecorderStep[],
    fromBase: string,
    skipRetarget = false
  ): Promise<RecorderStep[]> => {
    let list = flat
    const names = envVarNames(flat, [])
    if (names.length) {
      const res = await window.api.recorder.resolveEnv(names)
      // A token with no value used to be substituted as '' in silence — the run
      // typed nothing and failed several steps later with a message pointing
      // nowhere near the cause. Record it so the run can say which name is
      // missing; the substitution still happens, so nothing else changes.
      unresolvedEnvRef.current = res.unresolved
      list = substituteSteps(list, {}, res.values)
    } else {
      unresolvedEnvRef.current = []
    }
    if (activeEnv?.baseURL && !skipRetarget) {
      list = retargetSteps(list, fromBase || deriveBaseURL(flat), activeEnv.baseURL)
    }
    return list
  }

  // F25 guard: an active environment re-points every navigation at its own host.
  // When that host differs from the one this test was recorded on, ask first —
  // otherwise the run silently hits 404s while the steps panel still displays
  // the recorded URL. Resolves to the user's choice; null = no warning needed.
  // `entries`: every test about to run, with the base URL it was RECORDED on.
  // A single replay passes one; Run All passes all 33. Tests are grouped by
  // recorded host, so a suite spanning three sites asks once, listing all three
  // — not once per test.
  const confirmRetargetFor = (
    entries: { name: string; fromBase: string; steps?: RecorderStep[] }[]
  ): Promise<'run' | 'noenv' | 'cancel'> => {
    const to = activeEnv?.baseURL
    if (!to || !activeEnv) return Promise.resolve('run')
    const byHost = new Map<string, { from: string; to: string; tests: string[] }>()
    // F24 × F25: an API step's URL only follows the environment when it sits on
    // the recorded base's OWN origin. Anything else keeps calling the host it was
    // recorded with — fine for a public/third-party API, DANGEROUS when it's the
    // app's own API on a separate host (api.shop.com beside www.shop.com), because
    // a "staging" run would then still POST to the PRODUCTION API. Both look
    // identical from here, so we name the hosts instead of guessing.
    const byApiHost = new Map<string, { host: string; tests: string[] }>()
    for (const e of entries) {
      const m = retargetHostMismatch(e.fromBase, to)
      if (m) {
        const hit = byHost.get(m.from) ?? { ...m, tests: [] }
        hit.tests.push(e.name)
        byHost.set(m.from, hit)
      }
      for (const host of apiHostsOutsideEnv(e.steps ?? [], e.fromBase, to)) {
        const hit = byApiHost.get(host) ?? { host, tests: [] }
        if (!hit.tests.includes(e.name)) hit.tests.push(e.name)
        byApiHost.set(host, hit)
      }
    }
    const mismatches = [...byHost.values()]
    const apiHosts = [...byApiHost.values()]
    if (mismatches.length === 0 && apiHosts.length === 0) return Promise.resolve('run')
    // Auto-resolve ONLY when every host pair was remembered AND they all agree.
    // A suite where one host says "run anyway" and another says "run without
    // environment" has no single answer — ask, rather than silently pick one.
    const suppress = envState.retargetSuppress
    const choices = [
      ...mismatches.map((m) => suppressedChoice(suppress, activeEnv.id, m.from, m.to)),
      // API hosts get their own remembered key (prefixed so it can never collide
      // with a navigation host pair) — silencing "my tests call jsonplaceholder"
      // must not also silence "this suite is retargeted to another site".
      ...apiHosts.map((a) => suppressedChoice(suppress, activeEnv.id, `api:${a.host}`, to))
    ]
    if (choices.every((c) => c !== null) && new Set(choices).size === 1) {
      return Promise.resolve(choices[0]!)
    }
    return new Promise((resolve) => setEnvWarn({ mismatches, apiHosts, resolve }))
  }

  const confirmRetarget = (
    fromBase: string,
    runSteps?: RecorderStep[]
  ): Promise<'run' | 'noenv' | 'cancel'> =>
    confirmRetargetFor([{ name: testName || 'this test', fromBase, steps: runSteps }])

  // Day 18: auto-save the current UNSAVED recording as a draft (debounced), so
  // a forgotten Save never loses work. Saved tests persist via the library, so
  // they're skipped here. Once steps exist, a draft id is minted and reused.
  useEffect(() => {
    if (testFileName !== null || steps.length === 0) return
    if (!draftIdRef.current) draftIdRef.current = `draft-${Date.now()}`
    const id = draftIdRef.current
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = window.setTimeout(() => {
      window.api.drafts.save({
        id,
        name: testName,
        baseURL,
        suite: testSuite,
        storageState,
        viewport,
        deviceId, // F36
        tags, // F38
        dataRows,
        steps
      })
    }, 700)
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    }
  }, [steps, testFileName, testName, baseURL, testSuite, storageState, viewport, deviceId, dataRows])

  // Sync the URL bar whenever the embedded browser navigates.
  // Mark hasNavigated true so we switch from welcome -> chrome view.
  useEffect(() => {
    const unsubscribe = window.api.browser.onUrlChange((url) => {
      if (!url.startsWith('data:')) {
        setUrlInput(url)
        liveUrlRef.current = url
        setHasNavigated(true)
        // A navigation reloads the page — and with it, the observer's pick
        // flag. Whatever we were pointing at no longer exists; end pick mode.
        setIsPicking(false)
      }
    })
    return unsubscribe
  }, [])

  // Day 17 (multiple windows): keep the tab strip in sync with main.
  useEffect(() => {
    const unsubscribe = window.api.browser.onTabsChanged((t) => setTabs(t))
    return unsubscribe
  }, [])

  // Day 17 (session reuse): load the saved-session list once.
  const refreshSessions = (): void => {
    window.api.session.list().then(setSessions)
    // F39.2: and how stale each one is. A saved login expires silently, and the
    // embedded browser keeps the test green long after the FILE stopped working
    // — so the app has to say the expiry out loud or it reports a pass for a
    // test that fails everywhere else.
    window.api.session.status().then((rows) => {
      const next: Record<string, { expiresAt: number | null; expired: boolean }> = {}
      for (const r of rows) next[r.file] = { expiresAt: r.expiresAt, expired: r.expired }
      setSessionStatus(next)
    })
  }
  useEffect(() => {
    refreshSessions()
  }, [])

  // F39.2: "expired 3 days ago" / "expires in 8 minutes" for a saved session.
  // Returns null when there's nothing worth saying — no file, no dated cookie,
  // or an expiry comfortably far off. Silence is the right output for healthy.
  //
  // Minutes matter, not just days: SauceDemo's login cookie lives about TEN
  // MINUTES. A day-granularity label would have called that "expires today",
  // which reads as "fine for now" when the honest answer is "already gone by the
  // time you finish reading this".
  const sessionAge = (file?: string): { expired: boolean; text: string } | null => {
    if (!file) return null
    const st = sessionStatus[file]
    if (!st || st.expiresAt === null) return null
    const ms = st.expiresAt - Date.now()
    const span = (abs: number): string => {
      const mins = Math.round(abs / 60_000)
      if (mins < 60) return `${Math.max(1, mins)} minute${mins === 1 ? '' : 's'}`
      const hrs = Math.round(mins / 60)
      if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'}`
      return `${Math.round(hrs / 24)} days`
    }
    if (ms <= 0) return { expired: true, text: `expired ${span(-ms)} ago` }
    // Only warn about a session that's about to die — a login good for another
    // three months is not news, and a label on everything trains you to skip it.
    if (ms <= 3 * 86_400_000) return { expired: false, text: `expires in ${span(ms)}` }
    return null
  }

  // Apply a re-pick heal: same step, new eyes — keep what it DOES (type/value/
  // check), replace how it FINDS the element (label + ladder + frame), and retry.
  const applyHeal = (picked: PickedElement, healIndex: number): void => {
    const next = stepsRef.current.map((s, idx) =>
      idx === healIndex
        ? {
            ...s,
            label: picked.label,
            selector: picked.selector,
            candidates: picked.candidates,
            // Day 15: the re-picked element may now live in a different frame
            // (or none) — carry its frame so replay routes correctly.
            frame: picked.frame
          }
        : s
    )
    setSteps(next)
    setHealedIndices((prev) => new Set(prev).add(healIndex))
    setRecovery(null)
    setRepickPending(null)
    window.api.recorder.recovery({ action: 'retry', step: next[healIndex] })
  }

  // Day 17: does the re-picked element look DIFFERENT from the original step's
  // element? A click succeeds on almost anything, so without this a wrong pick
  // would silently "heal" + pass. Compare visible label (unrelated words) and
  // ARIA role. Returns a warning to confirm, or null when it's a clean match.
  const repickMismatch = (original: RecorderStep, picked: PickedElement): string | null => {
    const norm = (s?: string): string =>
      (s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    const a = norm(original.label)
    const b = norm(picked.label)
    // A clean heal needs a STRONG label match — not just one shared word (the
    // page is full of links like "Dynamic Loading" that share "Dynamic" with
    // "Dynamic Controls"). Clean = exact, OR one contains the other, OR most of
    // the original's words appear in the pick. Everything else (a different
    // element, or an empty/unrelated pick) is a mismatch → confirm before heal.
    let labelDiffers = false
    if (a) {
      const exactOrContains = !!b && (a === b || a.includes(b) || b.includes(a))
      if (!exactOrContains) {
        const aTokens = a.split(' ').filter(Boolean)
        const bTokens = new Set(b.split(' ').filter(Boolean))
        const shared = aTokens.filter((t) => bTokens.has(t)).length
        labelDiffers = aTokens.length === 0 ? !!b : shared / aTokens.length < 0.6
      }
    }
    const oRole = primaryCandidate(original)?.role
    const pRole = picked.candidates.find((c) => c.locator === picked.selector)?.role
    const roleDiffers = !!oRole && !!pRole && oRole !== pRole
    if (!labelDiffers && !roleDiffers) return null
    const origDesc = original.label ? `"${original.label}"${oRole ? ` (${oRole})` : ''}` : 'it'
    const gotDesc = picked.label ? `"${picked.label}"${pRole ? ` (${pRole})` : ''}` : 'that element'
    return `You picked ${gotDesc}, but the original step targeted ${origDesc} — they look different. Heal anyway?`
  }

  // Day 9: a picked element arrives — close pick mode, open the assertion
  // chooser prefilled with the element's live text.
  // Day 12: unless this pick is a RE-PICK for a paused replay — then it heals
  // the failed step's selector ladder and retries it, no chooser involved.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onPicked((picked) => {
      setIsPicking(false)
      const healIndex = repickIndexRef.current
      if (healIndex !== null) {
        setRepickIndex(null)
        // A bare element can't heal anything — its ladder is the same bare
        // tag replay just refused. Stay paused and explain.
        if (picked.unreliable) {
          setRecoveryWarning(
            `"${picked.label}" has no stable hooks (no id / role / text) — ` +
              'replay would refuse it too. Try a more specific element.'
          )
          return
        }
        // Day 17: if the pick looks different from the original element, hold it
        // for a "heal anyway?" confirm instead of silently healing.
        const original = stepsRef.current[healIndex]
        const mismatch = original ? repickMismatch(original, picked) : null
        if (mismatch) {
          setRepickPending({ picked, healIndex, message: mismatch })
          return
        }
        applyHeal(picked, healIndex)
        return
      }
      // F37: a `repeat for each` / `if` marker is picking the element it tests
      // or iterates over. It BINDS to a step that already exists rather than
      // creating a new one, so it skips the check panel entirely — pick and done.
      if (pickBindRef.current !== null) {
        const at = pickBindRef.current
        pickBindRef.current = null
        setIsPicking(false)
        window.api.recorder.setPicking(false)
        const next = stepsRef.current.slice()
        if (next[at]) {
          next[at] = {
            ...next[at],
            label: picked.label,
            selector: picked.selector,
            candidates: picked.candidates,
            frame: picked.frame
          }
          editSteps(next)
        }
        return
      }
      setPickedElement(picked)
      setAssertKind('visible')
      setAssertValue(picked.text ?? '')
      setAssertAttr('')
    })
    return unsubscribe
  }, [])

  // The user pressed Esc inside the page — pick mode ended without a pick.
  // If it was a re-pick, fall back to the recovery panel's buttons.
  useEffect(
    () =>
      window.api.recorder.onPickCancel(() => {
        setIsPicking(false)
        setRepickIndex(null)
      }),
    []
  )

  // Day 12: a replay hit a failed step and is now paused, waiting on us.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onReplayPaused((info) => {
      setRecovery(info)
      setRecoveryWarning(null)
      setRepickPending(null)
    })
    return unsubscribe
  }, [])

  // Append every recorded step to the live list as it arrives from main.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onStep((step) => {
      setSteps((prev) => [...prev, step])
    })
    return unsubscribe
  }, [])

  // Day 17 (multiple windows): main tells us a click opened a new tab AFTER the
  // step was already sent — patch that step (matched by id) with `opensWindow`.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onStepPatch((patch) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === patch.id ? { ...s, opensWindow: patch.opensWindow } : s))
      )
    })
    return unsubscribe
  }, [])

  // Day 16(+): download toast — show "downloading…" the instant it starts, then
  // resolve to the finished state. Works during record AND replay. A finished
  // toast auto-dismisses; the in-progress one stays until 'done' arrives.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const unsubStart = window.api.recorder.onDownloadStart((info) => {
      clearTimer()
      setDownloadToast({ name: info.name, phase: 'downloading' })
    })
    const unsubDone = window.api.recorder.onDownloadDone((info) => {
      clearTimer()
      setDownloadToast({ ...info, phase: 'done' })
      timer = setTimeout(() => setDownloadToast(null), 4500)
    })
    return () => {
      clearTimer()
      unsubStart()
      unsubDone()
    }
  }, [])

  // The embedded browser is a native pane that paints over our UI, so while
  // any full-window overlay is open (export modal, suite summary) we ask main
  // to hide it (else it covers the modal).
  const suiteSummaryOpen = suiteRun !== null && !suiteRun.running
  // F39.1: a parallel batch is running. Nothing about it is watchable — it's a
  // headless Playwright process, the embedded browser sits idle — so the app
  // shows a blocking overlay instead of a one-line status the user has to go
  // looking for. Surbhi clicked ▶ Run selected, saw no change where she was
  // looking (the status line renders at the TOP of the library, far above the
  // button), and concluded nothing had happened. Worse, the app stayed fully
  // clickable during a run that rewrites test files underneath you.
  const parallelRunning = !!(suiteRun?.running && suiteRun.parallelBatch)
  // Day 20: the overview popup auto-appears when a data run finishes; the
  // detailed tabs live inline in the panel (no overlay needed for those).
  const dataPopupOpen = dataRun !== null && !dataRun.running && !dataPopupDismissed
  // F6: statically flag dead/weak assertions in the current test, keyed by
  // step index for a quick per-row lookup in the step list.
  const weakByIndex = new Map(findWeakAssertions(steps).map((w) => [w.index, w]))
  // === F40: bundle handlers =========================================
  // Export the CURRENT filtered/selected view, so "share the smoke suite" is
  // just: filter by @smoke → 📦 Export. No separate selection concept.
  const handleExportBundle = async (): Promise<void> => {
    const chosen = selectedTests.size
      ? savedTests.filter((t) => selectedTests.has(t.fileName))
      : savedTests.filter(matchesLibraryFilters)
    if (!chosen.length) return
    setBundleBusy(true)
    const res = await window.api.xbrowser.exportBundle(
      chosen.map((t) => t.fileName),
      true
    )
    setBundleBusy(false)
    if (res.ok && res.path && res.manifest) {
      setBundleResult({ path: res.path, manifest: res.manifest })
    } else if (res.error && res.error !== 'cancelled') {
      window.alert(`Couldn’t export the bundle: ${res.error}`)
    }
  }

  const handleInspectBundle = async (): Promise<void> => {
    setBundleBusy(true)
    const res = await window.api.xbrowser.inspectBundle()
    setBundleBusy(false)
    if (!res.ok) {
      if (res.error && res.error !== 'cancelled') window.alert(res.error)
      return
    }
    // Default every collision to keep-both: the only choice that can't destroy
    // work the user hasn't looked at yet.
    const choices: Record<string, 'keep-both' | 'overwrite' | 'skip'> = {}
    for (const t of res.tests) choices[t.file] = t.collidesWith ? 'keep-both' : 'overwrite'
    setImportPlan({
      bundleDir: res.bundleDir ?? '',
      manifest: res.manifest,
      tests: res.tests,
      choices
    })
  }

  const handleApplyImport = async (): Promise<void> => {
    if (!importPlan) return
    setBundleBusy(true)
    const res = await window.api.xbrowser.importBundle(
      importPlan.bundleDir,
      importPlan.tests.map((t) => ({ file: t.file, choice: importPlan.choices[t.file] }))
    )
    setBundleBusy(false)
    setImportPlan(null)
    if (!res.ok) {
      window.alert(`Import failed: ${res.error}`)
      return
    }
    setSavedTests(await window.api.library.list())
    const bits = [`${res.imported} test${res.imported === 1 ? '' : 's'} imported`]
    if (res.keptBoth) bits.push(`${res.keptBoth} kept alongside an existing one`)
    if (res.overwritten) bits.push(`${res.overwritten} overwritten`)
    if (res.skipped) bits.push(`${res.skipped} skipped`)
    if (res.blocks) bits.push(`${res.blocks} block${res.blocks === 1 ? '' : 's'}`)
    if (res.uploads) bits.push(`${res.uploads} upload file${res.uploads === 1 ? '' : 's'}`)
    setImportDone(bits.join(' · '))
  }

  // F37: pair up loop / if markers for the current test — gives the step list
  // its indentation and surfaces a broken structure BEFORE you hit Replay
  // (replay refuses to start on one, so catching it here saves a failed run).
  const controlFlow = analyzeControlFlow(steps)

  // F13: the a11y panel is open while a scan runs (spinner) or a result is shown.
  const a11yPanelOpen = a11yScanning || a11yScan !== null
  // F14: same for the performance panel.
  const perfPanelOpen = perfMeasuring || perfResult !== null
  useEffect(() => {
    window.api.browser.setOverlay(
      exportCode !== null ||
        suiteSummaryOpen ||
        dataPopupOpen ||
        analysisOpen ||
        traceView !== null ||
        a11yPanelOpen ||
        perfPanelOpen ||
        historyOpen ||
        envManagerOpen ||
        edgeModalOpen ||
        // F28: hide the browser behind the locale picker + the finished sweep report
        // (but NOT while the sweep runs — capturePage/inspect need the page visible).
        localeOpen ||
        (localeRun !== null && !localeRun.running && localeReportOpen) ||
        // F20: hide the browser only while the finished report modal is OPEN.
        // While the batch RUNS, keep the browser visible (like a data-driven run)
        // so you can watch each variant AND so capturePage() works — a hidden view
        // is zero-sized and its failure screenshots come back empty. And once you
        // close the report (report closed, run kept), the browser comes back.
        (edgeRun !== null && !edgeRun.running && edgeReportOpen) ||
        xbOpen ||
        docOpen ||
        // F25 guard: the run is BLOCKED awaiting this modal's answer, so the
        // browser view must come down or the dialog is invisible underneath it
        // and the replay hangs forever.
        envWarn !== null ||
        // F24 / F15 / F18: step editors are modals too. Any modal MISSING from
        // this list renders underneath the native browser pane — the backdrop
        // still eats clicks, so the app looks frozen. F15 re-capture and F18 step
        // generation close their modal FIRST, then read the page with the browser
        // shown normally (main leaves it shown) — no flash over the modal.
        apiDraft !== null ||
        snapDraft !== null ||
        aiPromptOpen ||
        // F21 / F27 / F31: the newest modals. Same rule as every entry above —
        // without this the dialog renders under the native pane and the app just
        // looks black and frozen.
        bugPromptOpen ||
        createsDataIndex !== null ||
        acOpen ||
        monitorsOpen || // F32 dashboard
        coverageOpen || // F23 coverage map
        draftOpen || // F22 draft-from-story
        mockOpen || // F35 mock studio
        jiraOpen || // F34 Jira ticket
        // F40: the newest three. They're triggered from the LIBRARY (the welcome
        // screen, where the browser is hidden anyway), so today they can't hit
        // the under-the-pane bug — but they now render in BOTH views, and the
        // comment above exists precisely because "it can't happen yet" is how
        // this trap gets laid for the next feature.
        secretMigration !== null ||
        bundleResult !== null ||
        importPlan !== null ||
        // F39.1: while a parallel batch runs. Not a modal — the app stays fully
        // usable — but the embedded browser is idle for the whole batch (it's a
        // headless Playwright process), and a native pane paints straight over
        // the running banner. Keeping it down for the duration costs nothing and
        // is what guarantees the banner is actually visible.
        parallelRunning ||
        apiPanelIndex !== null
    )
  }, [
    exportCode,
    suiteSummaryOpen,
    dataPopupOpen,
    analysisOpen,
    traceView,
    a11yPanelOpen,
    perfPanelOpen,
    historyOpen,
    envManagerOpen,
    edgeModalOpen,
    edgeRun,
    edgeReportOpen,
    localeOpen,
    localeRun,
    localeReportOpen,
    xbOpen,
    docOpen,
    envWarn,
    apiDraft,
    snapDraft,
    aiPromptOpen,
    bugPromptOpen,
    createsDataIndex,
    acOpen,
    monitorsOpen,
    coverageOpen,
    draftOpen,
    mockOpen,
    jiraOpen,
    secretMigration, // F40
    bundleResult, // F40
    importPlan, // F40
    parallelRunning, // F39.1
    apiPanelIndex
  ])

  // Day 18: remember the trace policy across sessions.
  useEffect(() => {
    localStorage.setItem('qaflow.traceMode', traceMode)
  }, [traceMode])

  // Follow replay progress so we can highlight running / done / failed steps.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onReplayProgress((p) => {
      // Map the expanded run index onto the collapsed display row (identity when
      // the test has no linked blocks).
      const idx = runPlanRef.current?.[p.index] ?? p.index
      if (p.status === 'running') {
        setReplayingIndex(idx)
        // F19 batching: this step is judging several AI checks in ONE model call
        // (the rest of its run then return instantly). Say so, or a ~10s pause on
        // one step looks like a hang.
        setNlBatchCount(p.nlBatch?.count ?? null)
        // A recovery retry re-runs a step that just failed — drop its red mark.
        setFailedIndex((prev) => (prev === idx ? null : prev))
      } else if (p.status === 'done') {
        setNlBatchCount(null)
        setDoneIndices((prev) => new Set(prev).add(idx))
      }
      else if (p.status === 'error') setFailedIndex(idx)
      else if (p.status === 'skipped') {
        setSkippedIndices((prev) => new Set(prev).add(idx))
        setFailedIndex((prev) => (prev === idx ? null : prev))
      }
    })
    return unsubscribe
  }, [])

  // F24: an API step's HTTP exchange arrived (pass or fail) — key it by DISPLAY
  // row, like replay progress, so a linked block's expanded index lands on the
  // row you can actually see.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onApiResponse(({ index, evidence }) => {
      const idx = runPlanRef.current?.[index] ?? index
      setApiResponses((prev) => ({ ...prev, [idx]: evidence }))
    })
    return unsubscribe
  }, [])

  // F30: replay hit a manual (wait-for-human) step — show the "do it, then
  // continue" prompt; the run is holding until we send manualContinue.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onManualPause((info) => {
      setManualPause(info as { index: number; message: string })
    })
    return unsubscribe
  }, [])

  // F21b: the ride landed on a new page and is holding. First finalize the page
  // we just LEFT — its checks go right before the step that navigated here (so
  // they run after that page's actions, before it leaves). Then open the offer
  // for the new page (you can add several before Continue).
  useEffect(() => {
    const unsubscribe = window.api.recorder.onCheckOffer((info) => {
      const offer = info as { afterIndex: number; url: string }
      const prev = pendingClaimsRef.current
      if (prev.length) {
        const at = Math.max(0, offer.afterIndex - 1)
        for (const claim of prev) rideChecksRef.current.push({ afterIndex: at, claim })
      }
      pendingClaimsRef.current = []
      setRidePending([])
      setRideClaim('')
      setCheckOffer(offer)
    })
    return unsubscribe
  }, [])

  // F4 (self-heal 2.0): main auto-healed a broken selector mid-run. Swap the
  // healed step into our list (so 💾 save keeps the repaired ladder) and flag it
  // for the "fixed by AI" badge + live count. Skip a linked block row — we can't
  // rewrite a block's selector from here without breaking the live link.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onAutoHealed((info) => {
      const h = info as { index: number; step: RecorderStep }
      const idx = runPlanRef.current?.[h.index] ?? h.index
      setAiHealedIndices((prev) => new Set(prev).add(idx))
      // The healed step just re-ran successfully — clear any red mark on it.
      setFailedIndex((prev) => (prev === idx ? null : prev))
      setSteps((prev) => {
        const target = prev[idx]
        if (!target || target.blockRef) return prev
        const next = prev.slice()
        next[idx] = {
          ...target,
          label: h.step.label,
          selector: h.step.selector,
          candidates: h.step.candidates,
          frame: h.step.frame,
          healedByAi: h.step.healedByAi
        }
        return next
      })
    })
    return unsubscribe
  }, [])

  // Toggle recording. We no longer wipe on start — if steps already exist we
  // RESUME (append new steps to the end). Use the 🗑 Clear button to start over.
  // Starting any recording clears the previous replay's pass/fail marks.
  const handleRecordToggle = async (): Promise<void> => {
    const resume = !isRecording && steps.length > 0
    if (!isRecording) {
      setDoneIndices(new Set())
      setFailedIndex(null)
      setReplayError(null)
      setReplayingIndex(null)
      setEditingIndex(null)
    }
    const nowRecording = await window.api.recorder.toggle(resume)
    setIsRecording(nowRecording)
  }

  // Wipe the whole step list for a genuinely fresh start (asks first, since
  // it can't be undone). Only offered when not recording / replaying.
  const handleClearSteps = (): void => {
    if (steps.length === 0) return
    if (!window.confirm(`Clear all ${steps.length} steps and start over?`)) return
    editSteps([])
    // Day 20: clearing the steps drops the data table with them.
    setDataRows([])
    setDataPanelOpen(false)
    // Day 18: "start over" discards the current draft too.
    if (draftIdRef.current) {
      window.api.drafts.delete(draftIdRef.current)
      draftIdRef.current = null
    }
  }

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setHasNavigated(true)
    window.api.browser.navigate(trimmed)
  }

  // Click a suggested example chip to navigate immediately
  const handleExampleClick = (url: string): void => {
    setUrlInput(url)
    setHasNavigated(true)
    window.api.browser.navigate(url)
  }

  // Smart back: if the embedded browser has no more history, go to welcome
  const handleBack = async (): Promise<void> => {
    const didGoBack = await window.api.browser.goBack()
    if (!didGoBack) {
      setHasNavigated(false)
      setUrlInput('')
    }
  }

  // Home: one click straight back to the welcome screen — a fresh start, so
  // stop recording and clear the captured steps too.
  const handleHome = async (): Promise<void> => {
    // Day 18: flush the current unsaved recording to its draft NOW (the
    // debounced auto-save may not have fired yet), so leaving never loses it.
    // It then lives in the Recent list; mint a fresh draft for the next take.
    if (draftIdRef.current && steps.length > 0 && testFileName === null) {
      window.api.drafts.save({
        id: draftIdRef.current,
        name: testName,
        baseURL,
        suite: testSuite,
        storageState,
        viewport,
        deviceId, // F36
        tags, // F38
        dataRows,
        steps
      })
    }
    draftIdRef.current = null
    setDraftDismissed(true) // don't nag with the recover banner after an explicit Home
    await window.api.browser.home()
    setHasNavigated(false)
    setUrlInput('')
    setIsRecording(false)
    setSteps([])
    // Fresh start drops the current test identity too (steps are gone).
    setTestName('')
    setTestFileName(null)
    setBaseURL('')
    setStorageState(undefined)
    setHarField(undefined) // F1: drop the previous test's HAR link
    setHarCount(0)
    setLastHarUsage(null)
    setTestVersions([]) // F12: no history for a brand-new recording
    setHistoryOpen(false)
    // F24: the previous test's API responses must not follow us to a new one.
    setApiResponses({})
    setApiPanelIndex(null)
    // F20 (Option 2): a fresh start has no test, so no edge-run history/run.
    setEdgeRun(null)
    setEdgeReportOpen(false)
    setEdgeRunHistory([])
    applyViewport(undefined)
    setTags([]) // F38: a fresh test starts untagged
    setTagInput('')
    setTestSuite('')
    setSavePanelOpen(false)
    setSuiteRun(null)
    // Day 20: drop the data table + any data-run state on a fresh start.
    setDataRows([])
    setDataPanelOpen(false)
    setDataRun(null)
    setLastScreenshotPath(null)
    // Day 12: main answers any paused replay with a silent abort on Home —
    // mirror that here so no recovery UI survives the trip to welcome.
    setRecovery(null)
    setRecoveryWarning(null)
    setRepickPending(null)
    setRepickIndex(null)
    setSkippedIndices(new Set())
    setHealedIndices(new Set())
    setAiHealedIndices(new Set())
    setBranchNotes([]) // F37: notes describe the run that just ended
    // Day 13: the analysis described a run that no longer exists.
    closeAnalysis()
    setLastEvidence(null)
    setLastConsoleErrors([])
    setLastNetworkErrors([])
  }

  // Export: generate the Playwright code and open the preview modal. The
  // test's name becomes the test title; its base URL becomes test.use({...})
  // (derived from the first navigation when the test was never saved).
  // Generate the export and show it. Inline = one file; Page Object = two files
  // (a spec + a page class), unless the test is multi-tab/iframe/dialog/download
  // (POM falls back to inline, since those don't fit a clean auto-POM).
  // F1: which HAR filename the export should reference. A saved test uses its
  // own archive; a fresh recording that captured network (but isn't saved yet)
  // uses a generic name — main writes the in-memory HAR to it on save.
  const exportHarName = (): string | undefined =>
    harField ?? (harCount > 0 ? 'network.har' : undefined)

  const showExport = async (pageObject: boolean): Promise<void> => {
    // Live-link: expand linked blocks to their current steps so the generated
    // code contains the real actions (a block is just steps in the export).
    const flat = await expandForRun(steps)
    // Surface {{env:…}} names the OS also defines, HERE — at authoring time, the
    // only moment the name can actually be changed. `{{env:USERNAME}}` reads the
    // Windows account name, so the spec fills that into the form and reports a
    // credentials failure (or passes, if nothing asserts after it).
    setExportEnvWarning(osEnvCollisions(flat))
    const opts = {
      name: testName || undefined,
      baseURL: baseURL || deriveBaseURL(flat) || undefined,
      storageState,
      viewport,
      // F36: the device travels into the exported spec too, so a mobile test
      // stays mobile in CI. A real preset becomes `...devices['iPhone 13']`;
      // a size-only preset stays a bare `viewport:` (see deviceUse).
      device: deviceId ? deviceById(deviceId) : undefined,
      // F38: tags → Playwright's `{ tag: [...] }`, so `--grep @smoke` in CI
      // selects the same set the in-app tag filter does.
      tags,
      // Day 20: pass the data table so a data-driven test exports as a
      // `for (const data of dataset)` loop. The generators ignore it when
      // there are no columns/rows, so a plain test stays byte-identical.
      data: isDataDriven ? { columns: dataCols, rows: dataRows } : undefined,
      // F1: include a HAR in the export — the saved test's archive, or (if this
      // recording was captured but not yet saved) the fresh in-memory one.
      har: exportHarName()
    }
    if (pageObject) {
      const pom = generatePageObjectTest(flat, opts)
      if (pom) {
        setExportCode(pom.spec)
        setExportPage(pom.page)
        setExportPageFileName(pom.pageFileName)
        setExportTab('spec')
        return
      }
      // Unsupported for POM — fall back to inline so the user still gets output.
    }
    setExportCode(generatePlaywrightTest(flat, opts))
    setExportPage(null)
  }

  const handleExport = (): void => {
    setSavedPath(null)
    // Clear the companions too — a stale "+ pages/OldPage.ts" under a fresh
    // export would name a file this export never wrote.
    setSavedExtras([])
    setSavedPageOverwritten(false)
    showExport(poExport)
  }

  // Day 17: flip between inline and Page Object output, regenerating the preview.
  const handleTogglePoExport = (po: boolean): void => {
    setPoExport(po)
    showExport(po)
  }

  // Save the previewed code to .ts file(s) (main shows the OS save dialog). In
  // Page Object mode the page class is written to a pages/ folder beside the spec.
  const handleSaveExport = async (): Promise<void> => {
    if (!exportCode) return
    // F33: an opt-in GitHub Actions workflow that runs the tests on every PR.
    // Wire any {{env:NAME}} the export uses (emitted as process.env.NAME) to repo
    // secrets so they're never hard-coded.
    //
    // BOTH files, not just the spec. In Page Object mode every page interaction —
    // and therefore every credential — moves into the page CLASS, so scanning
    // only `exportCode` found `BASE_URL` and nothing else: a workflow that could
    // never log in, emitted as if it were complete. Inline export was unaffected,
    // which is why it went unnoticed.
    //
    // Both access forms are matched: `process.env.NAME` and `process.env['NAME']`
    // (the OS-collision guard uses bracket access).
    const envSources = [exportCode, exportPage ?? ''].join('\n')
    const secretNames = Array.from(
      new Set(
        [...envSources.matchAll(/process\.env(?:\.(\w+)|\[['"](\w+)['"]\])/g)].map(
          (m) => m[1] ?? m[2]
        )
      )
    )
    const ciWorkflow = exportCi ? generateCiWorkflow(secretNames) : undefined
    // F17: an opt-in cross-browser playwright.config.ts beside the spec.
    const configFile = exportXbrowser ? generatePlaywrightConfig() : undefined
    // Day 16(+): gather the upload files this test references so main can copy
    // them into a fixtures/ folder next to the saved spec (portable export).
    const fixturePaths = Array.from(
      new Set(
        steps
          .filter((s) => s.type === 'upload' && !s.disabled && s.value)
          .flatMap((s) => (s.value ?? '').split('\n').filter(Boolean))
      )
    )
    const res = await window.api.recorder.exportTest(
      exportCode,
      fixturePaths,
      storageState,
      exportPage ?? undefined,
      exportPage ? exportPageFileName : undefined,
      exportHarName(), // F1: copy the .har (saved or fresh) into hars/ beside the spec
      ciWorkflow, // F33: optional .github/workflows/playwright.yml
      configFile // F17: optional cross-browser playwright.config.ts
    )
    if (res) {
      setSavedPath(res.path)
      setSavedExtras(res.alsoWrote)
      setSavedPageOverwritten(res.pageOverwritten)
    }
  }

  const handleCopyExport = (): void => {
    const code = exportTab === 'page' && exportPage ? exportPage : exportCode
    if (code) navigator.clipboard.writeText(code)
  }

  // One replay of one steps-list, with outcome recorded for saved tests.
  // Shared by the single Replay button AND the Day 11.5 suite runner.
  // `interactive` (Day 12): a failure pauses for Retry / Re-pick / Skip / Stop
  // — only the single Replay button uses it; suite runs stay unattended.
  const runOnce = async (
    list: RecorderStep[],
    fileName: string | null,
    interactive = false,
    sessionFile: string | undefined = storageState,
    // F1: replay against a HAR — the loaded test's saved one, or the fresh
    // just-captured one ('__last') when capture is on and not yet saved.
    harFile: string | undefined = harField ??
      (captureNetwork && harCount > 0 ? '__last' : undefined),
    // F20: a batch run (edge cases) sets `silent` so it does NOT write the
    // workspace single-run panels — no failure banner, screenshot, What-changed
    // or recording pointer left behind for the LAST variant (it isn't "the test
    // failing", it's a hostile variant). The per-variant outcome is returned and
    // shown in the report modal instead. `traceOverride` forces a retain policy
    // (edge cases keep a recording for EVERY variant regardless of the setting).
    silent = false,
    traceOverride?: 'always' | 'failure' | 'off',
    // F28: replay the whole flow under this browser locale (Accept-Language +
    // Emulation.setLocaleOverride), for the localization sweep.
    localeOverride?: string,
    // F21b: ride the replay and pause per page to add a grounded check there.
    authorChecks = false
  ): Promise<{
    ok: boolean
    failedAt?: number
    error?: string
    screenshotPath?: string
    aborted?: boolean
    traceId?: string
    consoleErrors?: string[]
    networkErrors?: string[]
    failures?: { index: number; error: string; screenshotPath?: string; apiEvidence?: ApiEvidence }[]
    category?: FailureCategory // F9 (Stage 2): auto-classified failure type
    aiHealed?: number // B: how many selectors auto-healed this run
    // Option 2: a found-but-not-confident heal, for review & accept in the report
    healable?: { index: number; label: string; signals: string[]; score: number; step: RecorderStep }
  }> => {
    setFailedIndex(null)
    setReplayError(null)
    setDoneIndices(new Set())
    setReplayingIndex(null)
    setLastFailures([])
    setFailDetail(null)
    // F24: drop the previous run's API responses — a stale 201 next to a step
    // that just failed would be a lie, and the panel is meant to be evidence.
    setApiResponses({})
    setApiPanelIndex(null)
    setLastScreenshotPath(null)
    setLastTraceId(null)
    setSkippedIndices(new Set())
    setRecovery(null)
    setManualPause(null) // F30: clear any stale manual-step prompt
    setWhatChanged(null)
    setWhatChangedOpen(false)
    setLastConsoleErrors([])
    setLastNetworkErrors([])
    setIsReplaying(true)
    // Day 18: hand main the trace policy + the human step sentences (so the
    // saved trace is self-contained) + the test name for the manifest.
    // Day 20 (stuck-run fix): a replay MUST always release the UI — even if the
    // main-process handler rejects unexpectedly. Without this finally, one failed
    // IPC left isReplaying stuck `true`, which greys out every Replay / Run Data
    // button — so after a run or two (especially a data matrix firing many
    // replays back-to-back) the whole app looked frozen. Treat a rejection as an
    // ordinary failed run so the matrix keeps going and the banner explains it.
    let result: Awaited<ReturnType<typeof window.api.recorder.replay>>
    try {
      result = await window.api.recorder.replay(
        list,
        interactive,
        sessionFile,
        {
          mode: traceOverride ?? traceMode,
          stepTexts: list.map((s) => stepText(s)),
          testName: testName || undefined
        },
        harFile,
        // F29 slow-net + F28 locale override travel in the same run-options arg.
        chaosSlowNet || localeOverride
          ? { slowNetwork: chaosSlowNet || undefined, locale: localeOverride }
          : undefined,
        authorChecks // F21b
      )
    } catch (err) {
      // Electron wraps a main-process throw as "Error invoking remote method
      // 'recorder:replay': Error: <the real message>". That plumbing is not
      // something a QA should ever read, so strip it back to the message main
      // actually meant to send.
      const raw = err instanceof Error ? err.message : String(err)
      const clean = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
      result = { ok: false, error: clean }
    } finally {
      setIsReplaying(false)
      setReplayingIndex(null)
      setRecovery(null)
    }
    // Aborted = Home was pressed mid-recovery. The run is moot — no failure
    // banner, no run recorded.
    if (result.aborted) return result
    // A silent (batch) run returns its outcome but leaves the workspace panels
    // untouched — the caller (F20) collects result.traceId/screenshotPath per
    // variant and renders them in its own report.
    if (!silent) {
      setLastTraceId(result.traceId ?? null)
      // F37: surface untaken branches / empty loops on PASS as well as fail —
      // a green run that skipped its checks is exactly the case worth flagging.
      setBranchNotes(result.branchNotes ?? [])
      // F25: names that resolved to nothing this run. Shown on PASS too — a token
      // that silently became '' can leave a test green while testing nothing.
      setUnresolvedEnv(unresolvedEnvRef.current)
      // F1: surface how the HAR was used this run (absent when no HAR was in play).
      setLastHarUsage(
        result.harServed !== undefined
          ? { served: result.harServed, passthrough: result.harPassthrough ?? 0 }
          : null
      )
      if (!result.ok) {
        // Map expanded run indices back onto display rows (linked blocks) so the
        // red marks + failure banner point at the right rows. Identity otherwise.
        setFailedIndex(result.failedAt != null ? toDisplayIdx(result.failedAt) : null)
        setReplayError(result.error ?? 'Replay failed')
        setLastScreenshotPath(result.screenshotPath ?? null)
        setLastConsoleErrors(result.consoleErrors ?? [])
        setLastNetworkErrors(result.networkErrors ?? [])
        setLastFailures((result.failures ?? []).map((f) => ({ ...f, index: toDisplayIdx(f.index) })))
        setWhatChanged(result.whatChanged ?? null) // F8
      }
    }
    // A SAVED test remembers its outcomes — the library shows the latest as
    // a green/red dot and the last 10 as a history row (mini CI dashboard).
    if (fileName) {
      window.api.library.recordRun(fileName, {
        status: result.ok ? 'passed' : 'failed',
        at: new Date().toISOString(),
        failedAt: result.failedAt,
        error: result.error,
        screenshotPath: result.screenshotPath,
        traceId: result.traceId,
        category: result.category // F9 (Stage 2): auto-classified failure type
      })
    }
    return result
  }

  // === Day 18: run-trace viewer ======================================
  // Open a saved trace: load its manifest (thumbnails inlined), jump to the
  // failed step if any, and fetch that step's full screenshot.
  const loadTraceImage = async (manifest: TraceManifest, pos: number): Promise<void> => {
    setTraceImg(null)
    const step = manifest.steps[pos]
    if (step?.screenshotFile) {
      const img = await window.api.trace.getImage(manifest.id, step.screenshotFile)
      setTraceImg(img)
    }
  }
  const openTrace = async (id: string): Promise<void> => {
    const manifest = await window.api.trace.get(id)
    if (!manifest) return
    setTraceView(manifest)
    const failPos = manifest.steps.findIndex((s) => s.status === 'error')
    const pos = failPos >= 0 ? failPos : 0
    setTraceStepIdx(pos)
    loadTraceImage(manifest, pos)
  }
  const selectTraceStep = (pos: number): void => {
    if (!traceView) return
    setTraceStepIdx(pos)
    loadTraceImage(traceView, pos)
  }
  const closeTrace = (): void => {
    setTraceView(null)
    setTraceImg(null)
    setTraceSavedAt(null)
  }

  // F13: scan the current page for accessibility violations. Opens the panel
  // right away (spinner), then fills it with the result. Never throws — a
  // page that can't be scanned comes back as a result with `error` set.
  const handleA11yScan = async (): Promise<void> => {
    setA11yScan(null)
    setA11yScanning(true)
    try {
      const result = await window.api.a11y.scan()
      setA11yScan(result)
    } catch {
      setA11yScan({
        url: '',
        title: '',
        at: new Date().toISOString(),
        violations: [],
        passCount: 0,
        incompleteCount: 0,
        nodeCount: 0,
        error: 'The scan failed to run. Please try again.'
      })
    } finally {
      setA11yScanning(false)
    }
  }

  // F13: add the scan as a permanent test step — replay then FAILS if the page
  // regresses on accessibility (at or above the chosen budget). Appended to the
  // end (the check runs after the recorded flow); editable like any step after.
  const handleAddA11yStep = (): void => {
    editSteps([...steps, { type: 'a11y', label: 'Accessibility check', value: a11yAddLevel }])
    setA11yScan(null)
  }

  // F14: measure Core Web Vitals on the current page. Opens the panel right
  // away (spinner), then fills it. Never throws — a page it can't measure comes
  // back as a result with `error` set.
  const handleMeasurePerf = async (): Promise<void> => {
    setPerfResult(null)
    setPerfMeasuring(true)
    try {
      setPerfResult(await window.api.perf.measure())
    } catch {
      setPerfResult({
        url: '',
        title: '',
        at: new Date().toISOString(),
        metrics: [],
        error: 'The measurement failed to run. Please try again.'
      })
    } finally {
      setPerfMeasuring(false)
    }
  }

  // F14: add the measurement as a permanent test step — replay FAILS if a Core
  // Web Vital regresses past the chosen budget. Appended to the end; editable.
  const handleAddPerfStep = (): void => {
    editSteps([...steps, { type: 'perf', label: 'Performance check', value: perfAddLevel }])
    setPerfResult(null)
  }

  // F12: roll the working steps back to a past version (then the user can save,
  // which snapshots the current steps as a new version — nothing is lost).
  const handleRestoreVersion = (): void => {
    const v = testVersions[historyIdx]
    if (!v) return
    editSteps(v.steps as RecorderStep[])
    setHistoryOpen(false)
  }
  const saveTraceRecording = async (): Promise<void> => {
    if (!traceView) return
    const dest = await window.api.trace.export(traceView.id)
    if (dest) setTraceSavedAt(dest)
  }
  // Save a whole-run HTML report (pass or fail) for the just-finished run — the
  // "📄 report" button beside the recording. Uses the kept trace, so it appears
  // whenever a recording exists (Always mode, or a failure with tracing on).
  const saveRunReport = async (id: string): Promise<void> => {
    await window.api.trace.exportReport(id)
  }

  // Replay: run all recorded steps in the embedded browser and watch them go.
  // Interactive — a failed step pauses for recovery instead of ending the run.
  // Day 20: a DATA-DRIVEN test runs the WHOLE matrix (every row), same as
  // 🧪 Data ▸ Run — "Replay" should mean "run my test", and a data test IS all
  // its rows. (A test with variables but no rows yet falls through to a single
  // row-0 run so the button still does something.) Data runs are non-interactive
  // — recovery/heal can't substitute tokens, so it would mislead mid-row.
  const handleReplay = async (): Promise<void> => {
    if (isDataDriven && dataRows.length > 0) {
      await handleRunData()
      return
    }
    // Live-link: expand any linked blocks to their CURRENT steps before running,
    // and record the expanded→display index map so marks land on the right rows.
    const { flat, map } = await buildRunPlan(steps)
    runPlanRef.current = map
    const fromBase = baseURL || deriveBaseURL(flat)
    // F25 guard: the active env would send this test to another host — ask.
    // F24: `flat` is passed so the guard can also inspect API-step URLs.
    const choice = await confirmRetarget(fromBase, flat)
    if (choice === 'cancel') return
    const noEnv = choice === 'noenv'
    if (isDataDriven) {
      const row = dataRows[0] ?? {}
      // A data-driven test's {{env:…}} tokens usually live in the DATA ROWS, not
      // the steps (a password column of {{env:SAUCE_PW}}), so applyEnv — which
      // scans steps against an empty row set — never sees them. Record what
      // didn't resolve here too, or the run reports nothing while every row
      // types an empty password.
      const { values: envMap, unresolved: envMissing } =
        await window.api.recorder.resolveEnv(envVarNames(flat, [row]))
      unresolvedEnvRef.current = envMissing
      let list = substituteSteps(flat, resolveRow(row, envMap), envMap)
      if (activeEnv?.baseURL && !noEnv) list = retargetSteps(list, fromBase, activeEnv.baseURL)
      await runOnce(list, testFileName, false)
      return
    }
    setDataRun(null) // a plain single replay clears any stale matrix banner
    // F25: resolve {{env:}} creds + re-point navigations at the active env (if any).
    const list = await applyEnv(flat, fromBase, noEnv)
    await runOnce(list, testFileName, true)
  }

  // F21b: "Add checks along a replay" — ride the recorded flow and, on each page
  // it lands on, offer to drop a plain-English (nl) check for that page. Unlike
  // 🐛 Bug check (one page at a time), this walks the WHOLE flow once and lets you
  // add a check per page with no re-typing. Checks are collected during the ride
  // and spliced into the test at the end, so the live run's indices never shift.
  const handleReplayAlongChecks = async (): Promise<void> => {
    if (isDataDriven && dataRows.length > 0) {
      setAiToast({ tone: 'warn', msg: 'Ride-checks runs a single pass — use plain ▶ Replay for a data matrix.' })
      window.setTimeout(() => setAiToast(null), 6000)
      return
    }
    const { flat, map } = await buildRunPlan(steps)
    runPlanRef.current = map
    const fromBase = baseURL || deriveBaseURL(flat)
    const choice = await confirmRetarget(fromBase, flat)
    if (choice === 'cancel') return
    const list = await applyEnv(flat, fromBase, choice === 'noenv')
    rideChecksRef.current = []
    pendingClaimsRef.current = []
    rideListLenRef.current = list.length
    setRidePending([])
    setCheckOffer(null)
    await runOnce(list, testFileName, true, undefined, undefined, false, undefined, undefined, true)
    // The LAST page never fires a "next navigation", so finalize its pending
    // checks at the end of the flow.
    const tail = pendingClaimsRef.current
    if (tail.length) {
      const at = Math.max(0, rideListLenRef.current - 1)
      for (const claim of tail) rideChecksRef.current.push({ afterIndex: at, claim })
    }
    pendingClaimsRef.current = []
    const collected = rideChecksRef.current
    rideChecksRef.current = []
    setRidePending([])
    setCheckOffer(null)
    if (!collected.length) {
      setAiToast({ tone: 'warn', msg: 'Ride finished — no checks were added.' })
      window.setTimeout(() => setAiToast(null), 6000)
      return
    }
    // Splice descending so an earlier insert doesn't shift a later target row.
    const next = [...stepsRef.current]
    for (const c of [...collected].sort((a, b) => b.afterIndex - a.afterIndex)) {
      const at = toDisplayIdx(c.afterIndex) + 1
      next.splice(at, 0, { type: 'assert', assertKind: 'nl', value: c.claim } as RecorderStep)
    }
    editSteps(next)
    setAiToast({
      tone: 'ok',
      msg: `✓ Added ${collected.length} check${collected.length === 1 ? '' : 's'} across the ride. Review + ▶ Replay to verify.`
    })
    window.setTimeout(() => setAiToast(null), 7000)
  }

  // F21b: add ANOTHER check for the current page — buffered, not positioned yet
  // (its spot depends on where this page ends). Stays on the pause so you can
  // add more; ▶ Continue moves on.
  const handleRideAddCheck = (): void => {
    const claim = rideClaim.trim()
    if (!claim) return
    pendingClaimsRef.current = [...pendingClaimsRef.current, claim]
    setRidePending(pendingClaimsRef.current)
    setRideClaim('')
  }
  // F21b: done adding for this page — resume the ride to the next page.
  const handleRideContinue = (): void => {
    setCheckOffer(null)
    setRideClaim('')
    window.api.recorder.checkOfferRespond({})
  }
  // F21b: stop the ride here. Keep the current page's checks (place them right
  // after this page's landing step, since we never reach a "next navigation").
  const handleRideStop = (): void => {
    const pending = pendingClaimsRef.current
    if (checkOffer && pending.length) {
      for (const claim of pending) rideChecksRef.current.push({ afterIndex: checkOffer.afterIndex, claim })
    }
    pendingClaimsRef.current = []
    setRidePending([])
    setCheckOffer(null)
    setRideClaim('')
    window.api.recorder.checkOfferRespond({ stop: true })
  }

  // === Day 20: data-driven runs ======================================
  // Turn one step's fixed value into a {{variable}} (a column the data table
  // fills). The column name comes from the step's label; a secret password
  // field becomes a normal placeholder (its real value now comes per-row, and
  // real secrets can use a {{env:NAME}} cell). Opens the data grid.
  const handleParameterize = (i: number): void => {
    const step = steps[i]
    const col = toColumnName(step.label)
    editSteps(steps.map((s, idx) => (idx === i ? { ...s, value: `{{${col}}}`, secret: false } : s)))
    // Seed one empty row so the grid isn't blank the first time.
    if (dataRows.length === 0) setDataRows([{ [col]: '' }])
    setDataPanelOpen(true)
  }

  // Steps whose value can become a variable: typed/selected inputs and
  // value-bearing assertions (the "expected result" columns).
  const canParameterize = (step: RecorderStep): boolean =>
    step.type === 'type' ||
    step.type === 'select' ||
    (step.type === 'assert' && !!step.assertKind && assertNeedsValue(step.assertKind))

  // A readable name for a row in the run summary: its first column's value, else
  // a positional fallback. An empty first cell is tagged "(empty)" so a blank-
  // credentials row reads as intentional next to the named rows, not just "Row 4".
  const rowLabel = (row: Record<string, string>, i: number): string => {
    const first = dataCols[0] ? row[dataCols[0]] : ''
    return first ? first : `Row ${i + 1} (empty)`
  }

  // Grid editing — pure mutations of the dataRows array.
  const setCell = (r: number, col: string, val: string): void =>
    setDataRows((prev) => prev.map((row, idx) => (idx === r ? { ...row, [col]: val } : row)))
  const addDataRow = (): void =>
    setDataRows((prev) => [...prev, Object.fromEntries(dataCols.map((c) => [c, '']))])
  const deleteDataRow = (r: number): void =>
    setDataRows((prev) => prev.filter((_, idx) => idx !== r))

  // Run the flow once PER ROW, continuing past failures (each row gets a clean
  // browser via the existing replay isolation), then show a per-row summary —
  // the data-driven cousin of the suite runner.
  const handleRunData = async (): Promise<void> => {
    if (dataRows.length === 0 || !isDataDriven) return
    setDataPanelOpen(false)
    setDataTab(null)
    setDataPopupDismissed(false)
    // Live-link: expand linked blocks once, then run every row against the same
    // flattened flow (the index map lets per-row marks hit the right rows).
    const { flat, map } = await buildRunPlan(steps)
    runPlanRef.current = map
    // Env tokens in the data rows are invisible to applyEnv — collect them here.
    const { values: envMap, unresolved: envMissing } =
      await window.api.recorder.resolveEnv(envVarNames(flat, dataRows))
    unresolvedEnvRef.current = envMissing
    setDataRun({ total: dataRows.length, current: 0, currentLabel: '', results: [], running: true })
    const results: DataRunEntry[] = []
    for (let i = 0; i < dataRows.length; i++) {
      const label = rowLabel(dataRows[i], i)
      setDataRun((prev) => (prev ? { ...prev, current: i + 1, currentLabel: label } : prev))
      let list = substituteSteps(flat, resolveRow(dataRows[i], envMap), envMap)
      // F25: re-point navigations at the active environment (creds already
      // resolved above via envMap, which main sourced from the active env).
      if (activeEnv?.baseURL) list = retargetSteps(list, baseURL || deriveBaseURL(flat), activeEnv.baseURL)
      // fileName null: don't stamp a run per row — record ONE aggregate below.
      const result = await runOnce(list, null, false)
      if (result.aborted) {
        setDataRun(null)
        return
      }
      const entry: DataRunEntry = {
        label,
        status: result.ok ? 'passed' : 'failed',
        failedAt: result.failedAt,
        error: result.error,
        screenshotPath: result.screenshotPath,
        traceId: result.traceId,
        consoleErrors: result.consoleErrors,
        networkErrors: result.networkErrors,
        category: result.category
      }
      results.push(entry)
      setDataRun((prev) => (prev ? { ...prev, results: [...prev.results, entry] } : prev))
    }
    setDataRun((prev) => (prev ? { ...prev, running: false } : prev))
    // A saved test remembers the run as ONE outcome: green only if every row
    // passed, else red with a "N/M rows failed" summary.
    if (testFileName) {
      const failed = results.filter((r) => r.status === 'failed')
      const first = failed[0]
      window.api.library.recordRun(testFileName, {
        status: failed.length ? 'failed' : 'passed',
        at: new Date().toISOString(),
        failedAt: first?.failedAt,
        error: failed.length
          ? `${failed.length}/${results.length} rows failed — e.g. ${first.label}: ${first.error}`
          : undefined,
        screenshotPath: first?.screenshotPath,
        category: first?.category // F9 (Stage 2): representative failure type
      })
    }
  }

  // === F20: edge-case explosion =====================================
  // Open the picker: flatten the flow once (so blocks become real steps), detect
  // the text fields worth exploding, and default to all of them + all families.
  const handleOpenEdgeModal = async (): Promise<void> => {
    const { flat, map } = await buildRunPlan(steps)
    setEdgeFlat(flat)
    setEdgeMap(map)
    setEdgeFields(new Set(fillableFields(flat).map((f) => f.index)))
    setEdgeGroups(new Set<EdgeGroup>(['empty', 'boundary', 'invalid', 'injection']))
    setEdgeModalOpen(true)
  }

  // Run every generated variant through the SAME replay engine as a data run:
  // the happy-path baseline first (the reference), then each hostile variant.
  // Nothing is saved — variants are transient (fileName null), like the env
  // retarget. Outcomes stream into `edgeRun`; the report interprets them.
  // F28: replay the whole flow once per selected locale, then flag localization
  // issues — text overflow, RTL direction, and strings unchanged from the base
  // locale (likely untranslated). Mirrors the edge-case batch (silent + always-trace).
  const handleRunLocaleSweep = async (): Promise<void> => {
    const locales = LOCALE_PRESETS.filter((l) => localeSel.has(l.code)).map((l) => l.code)
    if (!locales.length) return
    setLocaleOpen(false)
    const { flat, map } = await buildRunPlan(steps)
    runPlanRef.current = map
    // F25: the SAME host-mismatch warning a normal replay shows. The locale sweep
    // used to retarget to the active environment SILENTLY — a test recorded on
    // mozilla.org would be quietly sent to the SauceDemo env's host and every locale
    // "failed to translate", with no hint why. Warn first, and honour the choice.
    const localeChoice = await confirmRetarget(baseURL || deriveBaseURL(flat), flat)
    if (localeChoice === 'cancel') return
    const localeNoEnv = localeChoice === 'noenv'
    // Resolve creds + retarget once — the same steps run under every locale.
    // A data-driven test carries {{column}} tokens (e.g. {{username}}) that only
    // get values when a ROW is bound; applyEnv alone binds an empty row, so those
    // tokens would stay literal and every locale would "fail" at the same step
    // (the exact bug data-driven login tests hit). A localization sweep only needs
    // ONE representative logged-in pass per locale (the UI language is the same
    // whichever user logs in), so bind the first row — mirroring the data runner.
    let listBase: RecorderStep[]
    if (isDataDriven && dataRows.length > 0) {
      const { values: envMap, unresolved: envMissing } =
        await window.api.recorder.resolveEnv(envVarNames(flat, dataRows))
      unresolvedEnvRef.current = envMissing
      listBase = substituteSteps(flat, resolveRow(dataRows[0], envMap), envMap)
      if (activeEnv?.baseURL && !localeNoEnv) {
        listBase = retargetSteps(listBase, baseURL || deriveBaseURL(flat), activeEnv.baseURL)
      }
    } else {
      listBase = await applyEnv(flat, baseURL || deriveBaseURL(flat), localeNoEnv)
    }
    setLocaleReportOpen(false)
    setLocaleRun({ total: locales.length, current: 0, currentLabel: '', running: true, results: [] })
    let baseTexts: Set<string> | null = null // the first locale's visible strings
    const results: LocaleResult[] = []
    for (let i = 0; i < locales.length; i++) {
      const loc = locales[i]
      setLocaleRun((prev) => (prev ? { ...prev, current: i + 1, currentLabel: loc } : prev))
      const res = await runOnce(listBase, null, false, undefined, undefined, true, 'always', loc)
      if (res.aborted) {
        setLocaleRun(null)
        return
      }
      const insp = await window.api.i18n.inspect()
      if (baseTexts === null) baseTexts = new Set(insp.texts) // base = the first run
      const unchanged = insp.texts.filter((t) => baseTexts!.has(t)).length
      results.push({
        locale: loc,
        ok: res.ok,
        error: res.error,
        failedAt: res.failedAt,
        screenshotPath: res.screenshotPath,
        traceId: res.traceId,
        dir: insp.dir,
        overflowCount: insp.overflowCount,
        overflow: insp.overflow,
        unchanged,
        totalTexts: insp.texts.length
      })
      setLocaleRun((prev) => (prev ? { ...prev, results: [...results] } : prev))
    }
    setLocaleRun((prev) => (prev ? { ...prev, running: false } : prev))
    setLocaleReportOpen(true)
  }

  const handleRunEdgeCases = async (): Promise<void> => {
    const cases = generateEdgeCases(edgeFlat, [...edgeFields], edgeGroups)
    if (cases.length <= 1) return // nothing but the baseline
    // F25 guard: ask ONCE before the batch, not once per variant — every variant
    // of this one test shares the same recorded host.
    const edgeChoice = await confirmRetarget(baseURL || deriveBaseURL(edgeFlat), edgeFlat)
    if (edgeChoice === 'cancel') return
    const edgeNoEnv = edgeChoice === 'noenv'
    // A success check is what lets us tell "app rejected the bad input" (the
    // check fails) from "app accepted it" (the check still passes). Without one,
    // we can only report what happened, not judge it.
    // Only a real `assert` is a success check. A snapshot/a11y/perf step is NOT a
    // pass/fail signal for "was the bad input accepted" — the exported negative suite
    // says exactly this and negates `assert` steps only (playwrightExport.ts). Counting
    // snapshots here let the verdict claim a certainty the evidence couldn't support.
    const hasAssertion = edgeFlat.some((s) => s.type === 'assert')
    runPlanRef.current = edgeMap // per-step marks map back to the display rows
    setEdgeSuiteSaved(null) // clear any stale "saved to…" note from a prior run
    setEdgeViewingHistory(false) // this is a fresh, live run (steps present)
    setEdgeReportOpen(false) // report opens only when the batch finishes
    setEdgeModalOpen(false)
    // Where the flow begins. The automatic verdict compares the baseline's END
    // against this: if valid input doesn't move the page, the URL signal can't
    // tell accepted from rejected and we must say so rather than guess.
    const startUrl = edgeFlat.find((s) => s.type === 'navigate')?.url ?? liveUrlRef.current
    const successUrl = edgeSuccessUrl.trim()
    setEdgeRun({
      total: cases.length,
      current: 0,
      currentLabel: '',
      running: true,
      hasAssertion,
      successUrl,
      startUrl,
      results: []
    })
    // Collect outcomes locally too (state is async) so we can persist the batch.
    const collected: {
      case: EdgeCase
      ok: boolean
      failedAt?: number
      error?: string
      screenshotPath?: string
      traceId?: string
      finalUrl?: string
    }[] = []
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      const label = c.baseline ? 'Happy path' : `${c.fieldLabel}: ${c.edgeLabel}`
      setEdgeRun((prev) => (prev ? { ...prev, current: i + 1, currentLabel: label } : prev))
      // Resolve {{env:}} creds + retarget URLs on the OTHER fields, exactly like
      // a normal run (the perturbed field is a literal hostile value).
      const list = await applyEnv(c.steps, baseURL || deriveBaseURL(c.steps), edgeNoEnv)
      // silent=true: don't pollute the workspace single-run panels with each
      // variant. traceOverride='always': keep a FULL recording for every variant
      // so each report row can open its own run.
      const res = await runOnce(list, null, false, undefined, undefined, true, 'always')
      if (res.aborted) {
        setEdgeRun(null)
        return
      }
      const entry = {
        case: c,
        ok: res.ok,
        failedAt: res.failedAt,
        error: res.error,
        screenshotPath: res.screenshotPath,
        traceId: res.traceId,
        // Where this variant left the browser. Read from the ref, not state —
        // this closure was created before the run and would see a stale value.
        finalUrl: liveUrlRef.current
      }
      collected.push(entry)
      setEdgeRun((prev) => (prev ? { ...prev, results: [...prev.results, entry] } : prev))
    }
    // The live step-progress listener marks each variant's steps as it runs —
    // including the LAST variant's rejected failure at the check step. Those are
    // transient batch marks, not a real result for the displayed test, so clear
    // them; otherwise the workspace shows a stray "✗ Failed at step N" banner
    // after the batch even though your saved test never failed.
    setFailedIndex(null)
    setReplayingIndex(null)
    setDoneIndices(new Set())
    setSkippedIndices(new Set())
    setEdgeRun((prev) => (prev ? { ...prev, running: false } : prev))
    setEdgeReportOpen(true) // now that it's done, show the report

    // Option 2: persist this batch as re-openable evidence — but ONLY for a
    // saved test (it's keyed per test file). An unsaved run stays re-openable in
    // memory for the session via the "current run" row.
    if (testFileName) {
      const baselineOk = !!collected.find((r) => r.case.baseline)?.ok
      // Judge here, once, and persist the verdicts. The re-opened run and the
      // history summary then read the SAME answer the report showed — they can't
      // drift apart, and main doesn't have to re-derive a rule it lacks the
      // context for.
      const saveCtx = edgeCtxOf({ hasAssertion, successUrl, startUrl, results: collected })
      await window.api.library.saveEdgeRun({
        testFile: testFileName,
        testName: testName || 'recorded flow',
        hasAssertion,
        baselineOk,
        results: collected.map((r) => ({
          baseline: r.case.baseline,
          fieldLabel: r.case.fieldLabel,
          edgeLabel: r.case.edgeLabel,
          group: r.case.group,
          value: r.case.value,
          hint: r.case.hint,
          ok: r.ok,
          screenshotPath: r.screenshotPath,
          traceId: r.traceId,
          finalUrl: r.finalUrl,
          verdict: r.case.baseline ? undefined : edgeVerdict(r, saveCtx).verdict,
          steps: r.case.steps // persist so a re-opened run can export its suite
        }))
      })
      await refreshEdgeHistory(testFileName)
    }
  }

  // Option 2: (re)load the persisted edge-run list for a test — for the
  // "🧨 Edge runs" list in the steps panel.
  const refreshEdgeHistory = async (fileName: string | null): Promise<void> => {
    setEdgeRunHistory(fileName ? ((await window.api.library.listEdgeRuns(fileName)) ?? []) : [])
  }

  // Option 2: re-open a PERSISTED batch from disk into the report modal. Its
  // variants' screenshots + recordings live on (protected from pruning), so the
  // 📷 / 🎬 buttons work. Steps aren't persisted, so Export is hidden for these
  // (edgeViewingHistory) — the verdicts, evidence and Copy report are all here.
  const handleOpenEdgeRun = async (id: string): Promise<void> => {
    const rec = await window.api.library.loadEdgeRun(id)
    if (!rec) return
    setEdgeRun({
      total: rec.results.length,
      current: rec.results.length,
      currentLabel: '',
      running: false,
      hasAssertion: rec.hasAssertion,
      // A saved run is re-judged from its OWN stored evidence, so re-opening it
      // months later can't produce a different answer than the day it ran.
      successUrl: '',
      startUrl: '',
      results: rec.results.map((v, i) => ({
        case: {
          id: `${i}`,
          baseline: v.baseline,
          fieldIndex: -1,
          fieldLabel: v.fieldLabel,
          group: v.group as EdgeGroup | null,
          edgeLabel: v.edgeLabel,
          value: v.value,
          hint: v.hint,
          steps: v.steps ?? [] // persisted steps → Export works on saved runs too
        },
        ok: v.ok,
        screenshotPath: v.screenshotPath,
        traceId: v.traceId,
        finalUrl: v.finalUrl,
        // Records saved before verdicts existed have none — those fall through
        // to the live rules, which for them means "no success check → unknown".
        // That is the honest answer for evidence we can no longer reconstruct.
        verdict: v.verdict
      }))
    })
    setEdgeSuiteSaved(null)
    setEdgeViewingHistory(true)
    setEdgeReportOpen(true)
  }

  // Option 2: delete a persisted edge run (its record + recordings + screenshots)
  // and refresh the list. If it's the one currently open in the report, close it.
  const handleDeleteEdgeRun = async (id: string): Promise<void> => {
    await window.api.library.deleteEdgeRun(id)
    if (edgeViewingHistory) {
      setEdgeReportOpen(false)
      setEdgeRun(null)
    }
    await refreshEdgeHistory(testFileName)
  }

  // F20 verdict for one variant.
  // 'accepted' = the app took the hostile input and still reached success (a bug
  // to investigate — worst for injection). 'rejected' = the app blocked it
  // (good). 'unknown' = we cannot tell, and MUST NOT guess.
  //
  // ORIGINALLY this was just `ok ? accepted : rejected`, which is only meaningful
  // when the test HAS a success check. Without one, `ok` means "the steps
  // completed" — and typing garbage into a field and clicking Login always
  // complete, whatever the app says next. So `ok` carried NO information, and
  // SauceDemo rejecting all 14 hostile inputs was reported as 14 ACCEPTED, with
  // the SQL injection flagged as a serious vulnerability. Manufacturing a
  // security finding is the worst thing a QA tool can do.
  //
  // Three sources of truth, most authoritative first:
  //   1. a success rule the user typed  — explicit beats inferred, always
  //   2. the test's own ✓ check         — what they actually asserted
  //   3. the BASELINE's final URL       — valid input lands on the post-login
  //      page; a variant that ends elsewhere was rejected. No hand-written
  //      assertion needed, which is the whole point: nobody adds one before
  //      running edge cases for the first time.
  // Only when none of the three can speak do we say 'unknown'.
  const normEdgeUrl = (u?: string): string => {
    if (!u) return ''
    try {
      const x = new URL(u)
      // origin + path only. Query/hash routinely carry per-run noise (tokens,
      // scroll anchors) that would make identical pages compare as different.
      return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase()
    } catch {
      return u.trim().replace(/\/+$/, '').toLowerCase()
    }
  }
  type EdgeBasis = 'stored' | 'rule' | 'check' | 'url' | 'none'
  const edgeVerdict = (
    r: { ok: boolean; finalUrl?: string; verdict?: 'accepted' | 'rejected' | 'unknown' },
    ctx: {
      baselineOk: boolean
      hasAssertion: boolean
      successUrl: string
      startUrl: string
      baselineUrl: string
    }
  ): { verdict: 'accepted' | 'rejected' | 'unknown'; basis: EdgeBasis } => {
    // A re-opened SAVED run carries the verdict it was given the day it ran.
    // Reuse it: stored evidence must not change meaning later just because the
    // judging rules improved, and the context it was judged with (the success
    // rule, the start URL) isn't all persisted.
    if (r.verdict) return { verdict: r.verdict, basis: 'stored' }
    // Baseline broken → the valid input didn't even work, so nothing below means
    // anything.
    if (!ctx.baselineOk) return { verdict: 'unknown', basis: 'none' }

    // 1. An explicit rule the user typed.
    const rule = ctx.successUrl.trim().toLowerCase()
    if (rule) {
      if (!r.finalUrl) return { verdict: 'unknown', basis: 'none' }
      return {
        verdict: r.finalUrl.toLowerCase().includes(rule) ? 'accepted' : 'rejected',
        basis: 'rule'
      }
    }

    // 2. The test's own check.
    if (ctx.hasAssertion) return { verdict: r.ok ? 'accepted' : 'rejected', basis: 'check' }

    // 3. Inferred from the baseline. Usable ONLY if success visibly moves the
    //    page — on an app that stays put (a SPA swapping content in place) the
    //    baseline ends where it started, the signal can't discriminate, and
    //    saying so beats guessing.
    const base = normEdgeUrl(ctx.baselineUrl)
    const start = normEdgeUrl(ctx.startUrl)
    const mine = normEdgeUrl(r.finalUrl)
    if (base && start && base !== start && mine) {
      return { verdict: mine === base ? 'accepted' : 'rejected', basis: 'url' }
    }
    return { verdict: 'unknown', basis: 'none' }
  }

  // The context every verdict in a run shares. Derived once from the run itself,
  // so the report, the markdown and the saved record can never disagree.
  const edgeCtxOf = (run: {
    hasAssertion: boolean
    successUrl?: string
    startUrl?: string
    results: { case: { baseline?: boolean }; ok: boolean; finalUrl?: string }[]
  }): {
    baselineOk: boolean
    hasAssertion: boolean
    successUrl: string
    startUrl: string
    baselineUrl: string
  } => {
    const baseline = run.results.find((r) => r.case.baseline)
    return {
      baselineOk: !!baseline?.ok,
      hasAssertion: run.hasAssertion,
      successUrl: run.successUrl ?? '',
      startUrl: run.startUrl ?? '',
      baselineUrl: baseline?.finalUrl ?? ''
    }
  }

  // How the verdicts in this run were reached — shown so a verdict is never a
  // black box, and so an INFERRED one is visibly weaker than an asserted one.
  const edgeBasisNote = (ctx: { hasAssertion: boolean; successUrl: string; startUrl: string; baselineUrl: string; baselineOk: boolean }): string => {
    if (!ctx.baselineOk) return ''
    if (ctx.successUrl.trim()) return `Judged by your rule: success = URL contains “${ctx.successUrl.trim()}”.`
    if (ctx.hasAssertion) return 'Judged by the test’s own ✓ check.'
    const base = normEdgeUrl(ctx.baselineUrl)
    const start = normEdgeUrl(ctx.startUrl)
    if (base && start && base !== start) {
      return `Inferred: the valid-input baseline ended on ${ctx.baselineUrl} — a variant that ended elsewhere was rejected.`
    }
    return ''
  }

  // A ready-to-paste markdown summary of an edge-case run (Copy button).
  const buildEdgeReport = (): string => {
    if (!edgeRun) return ''
    const baseline = edgeRun.results.find((r) => r.case.baseline)
    const baselineOk = !!baseline?.ok
    const variants = edgeRun.results.filter((r) => !r.case.baseline)
    const ctx = edgeCtxOf(edgeRun)
    const verdicts = variants.map((r) => edgeVerdict(r, ctx).verdict)
    const accepted = verdicts.filter((v) => v === 'accepted').length
    const rejected = verdicts.filter((v) => v === 'rejected').length
    const undetermined = verdicts.filter((v) => v === 'unknown').length
    const lines: string[] = []
    lines.push(`# Edge-case report${testName ? ` — ${testName}` : ''}`)
    lines.push('')
    lines.push(`- Variants run: ${variants.length}`)
    // Only claim accepted/rejected counts when they mean something. Printing
    // "0 rejected" beside "14 undetermined" reads as a finding; it isn't one.
    if (undetermined === variants.length) {
      lines.push(`- ? Undetermined: ${undetermined} — no verdict is possible for this run (see below).`)
    } else {
      lines.push(`- ⚠ Accepted (app took the bad input — review): ${accepted}`)
      lines.push(`- ✓ Rejected (handled): ${rejected}`)
      if (undetermined) lines.push(`- ? Undetermined: ${undetermined}`)
    }
    // How the verdicts were reached travels WITH them — an inferred verdict is
    // weaker than an asserted one and the reader has to be able to see which.
    const note = edgeBasisNote(ctx)
    if (note) lines.push(`- ${note}`)
    if (!baselineOk) lines.push(`- ⚠ Baseline (happy path) FAILED — fix the test first, then re-run; nothing here can be judged until the valid inputs pass.`)
    if (undetermined === variants.length && baselineOk)
      lines.push(`- ⚠ No success check in this test AND the valid-input baseline didn't move the page, so there is nothing to compare against. Add an assertion, or set a success rule in the 🧨 dialog, and re-run.`)
    lines.push('')
    for (const r of variants) {
      const v = edgeVerdict(r, ctx).verdict
      const mark =
        v === 'accepted'
          ? '⚠ ACCEPTED'
          : v === 'rejected'
            ? '✓ rejected'
            : baselineOk
              ? '? undetermined'
              : '· (baseline broken)'
      lines.push(`- ${mark} — **${r.case.fieldLabel}** = ${r.case.edgeLabel}: \`${r.case.value.slice(0, 60) || '(empty)'}\``)
      lines.push(`  - ${r.case.hint}`)
    }
    return lines.join('\n')
  }

  const handleCopyEdgeReport = (): void => {
    navigator.clipboard.writeText(buildEdgeReport())
  }

  // F20 export: turn the variants into a runnable Playwright negative suite —
  // one test per variant that asserts the app REJECTED the hostile input. Saved
  // as a .spec.ts (own save dialog) so the validation/security checks run in CI.
  const handleExportEdgeSuite = async (): Promise<void> => {
    if (!edgeRun) return
    const cases = edgeRun.results.map((r) => r.case)
    // Derive the base from the run's OWN steps (works for a re-opened saved run,
    // where edgeFlat belongs to a different/no run).
    const withSteps = cases.find((c) => c.steps && c.steps.length > 0)
    const code = generateEdgeSuite(cases, {
      name: testName || 'recorded flow',
      baseURL: baseURL || deriveBaseURL(withSteps?.steps ?? edgeFlat),
      viewport,
      device: deviceId ? deviceById(deviceId) : undefined // F36
    })
    // The edge suite is a single self-contained spec — no page class, workflow or
    // config — so only the spec path is of interest here.
    const res = await window.api.recorder.exportTest(code)
    if (res) setEdgeSuiteSaved(res.path)
  }

  // === F17: cross-browser replay ====================================
  // Open the runner: check whether Playwright is installed (the runner shells
  // out to it), then show the picker. WebKit/Firefox can't render in-app.
  const handleOpenXbrowser = async (): Promise<void> => {
    setXbResult(null)
    const chk = await window.api.xbrowser.check()
    setXbInstalled(chk.installed)
    setXbBrowsers({ chromium: chk.chromium, all: chk.allBrowsers })
    setXbOpen(true)
  }

  // Stop an in-flight download. The install promise settles on its own with
  // cancelled:true, so this only has to fire the kill — no state unwinding here.
  const handleCancelInstall = async (): Promise<void> => {
    setXbInstallLog('Cancelling…')
    await window.api.xbrowser.cancelInstallBrowsers()
  }

  // Download the browser binaries with the Playwright CLI the app ships. This is
  // the one place the app can repair its own missing dependency — a packaged
  // user has no repo and no npm, so "go run npx playwright install" is a dead
  // end for them. Minutes long, hence the streamed progress line.
  const handleInstallBrowsers = async (
    which: ('chromium' | 'firefox' | 'webkit')[]
  ): Promise<void> => {
    setXbInstalling(true)
    setXbInstallLog('Starting download…')
    const stop = window.api.xbrowser.onInstallProgress((line) => setXbInstallLog(line))
    try {
      const res = await window.api.xbrowser.installBrowsers(which)
      const chk = await window.api.xbrowser.check()
      setXbInstalled(chk.installed)
      setXbBrowsers({ chromium: chk.chromium, all: chk.allBrowsers })
      if (res.ok) setXbNeedDownload(false)
      setXbInstallLog(
        res.ok
          ? '✅ Browsers installed — you can run now.'
          : res.cancelled
            ? // Not a failure. Saying "⚠ failed" for something the user chose to
              // stop is the app blaming them for its own message.
              'Download cancelled. You can start it again any time.'
            : `⚠ ${res.message}`
      )
    } catch (err) {
      setXbInstallLog(`⚠ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stop()
      setXbInstalling(false)
    }
  }

  // Export the current flow to a self-contained spec and run it on the selected
  // engines via real Playwright (main). Session/HAR/fixtures are omitted in v1 —
  // the cross-browser run exercises the functional flow.
  const handleRunXbrowser = async (): Promise<void> => {
    if (xbSel.size === 0) return
    const { flat } = await buildRunPlan(steps)
    const code = generatePlaywrightTest(flat, {
      name: testName || 'recorded flow',
      baseURL: baseURL || deriveBaseURL(flat),
      viewport,
      // F36: an iPhone/iPad preset is a WebKit device in Playwright's catalogue,
      // so running it on the webkit project here is the one place the emulation
      // is the REAL engine and not Chromium in a costume.
      device: deviceId ? deviceById(deviceId) : undefined
    })
    setXbRunning(true)
    setXbResult(null)
    try {
      // F40: the exported spec fills a password field from process.env.PASSWORD,
      // and since F40 the value lives in userData rather than in the step — so
      // the refs have to travel or the login types an empty string and EVERY
      // engine times out identically. The parallel runner and monitors already
      // did this; this path didn't, which is what broke Test B.
      const secretRefs = flat
        .map((s) => s.secretRef)
        .filter((r): r is string => typeof r === 'string' && !!r)
      const res = await window.api.xbrowser.run(
        code,
        [...xbSel] as ('chromium' | 'firefox' | 'webkit')[],
        undefined,
        // A test that starts already logged in needs its session here too, for
        // the same reason: otherwise it's bounced to a login page it can't pass.
        storageState || undefined,
        secretRefs
      )
      setXbResult(res)
      setXbInstalled(res.installed)
      // The run refused because an engine isn't downloaded — flip the modal to
      // the download panel rather than leaving a message the user can't act on.
      if (res.needsBrowsers) {
        const chk = await window.api.xbrowser.check()
        setXbBrowsers({ chromium: chk.chromium, all: chk.allBrowsers })
        // Drop any leftover line from an EARLIER download. It renders inside the
        // "⚠ browsers aren't downloaded yet" panel, so a stale "✅ Browsers
        // installed — you can run now" from a previous session showed up directly
        // beneath the warning contradicting it.
        setXbInstallLog('')
        setXbNeedDownload(true)
      }
    } catch (err) {
      setXbResult({
        installed: true,
        ran: false,
        results: [],
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setXbRunning(false)
    }
  }

  // === F31: living docs =============================================
  // Generate a plain-English document of the CURRENT test from its steps — what
  // it does + what it verifies + preconditions. Flatten first so linked blocks
  // are described as their real steps. Regenerated each time, so it can't drift.
  // F31 (scale surface): one coverage document across the WHOLE library — load
  // each saved test, flatten it (blocks expanded), and hand them to the suite
  // generator. Opens the same docs modal. A living map of what QA covers.
  const handleSuiteDocs = async (): Promise<void> => {
    const entries: { name: string; suite: string; flat: RecorderStep[]; meta: DocMeta }[] = []
    for (const t of savedTests) {
      const data = await window.api.library.load(t.fileName)
      if (!data) continue
      const { flat } = await buildRunPlan(data.steps as RecorderStep[])
      entries.push({
        name: data.name,
        suite: t.suite,
        flat,
        meta: {
          baseURL: data.baseURL,
          storageState: data.storageState,
          viewport: data.viewport,
          deviceId: data.deviceId, // F36
          tags: data.tags, // F38
          dataRows: data.dataRows
        }
      })
    }
    setDocContent(generateSuiteDoc(entries))
    setDocSavedPath(null)
    setDocOpen(true)
  }

  const handleCopyDocs = (): void => {
    navigator.clipboard.writeText(docContent)
  }

  const handleSaveDocs = async (): Promise<void> => {
    const slug =
      (testName || 'test')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'test'
    const path = await window.api.translator.saveReport(docContent, `${slug}-docs.md`)
    if (path) setDocSavedPath(path)
  }

  // F31 (AC checklist): open the panel, restoring the saved acceptance criteria.
  const handleOpenAcChecklist = async (): Promise<void> => {
    setAcResult(null)
    setAcText(await window.api.ac.load())
    setAcOpen(true)
  }
  const closeAcChecklist = (): void => {
    window.api.ac.save(acText) // remember the ACs across restarts
    setAcOpen(false)
  }
  // Ask the AI which saved tests cover each acceptance criterion; uncovered = a gap.
  const handleMatchAcs = async (): Promise<void> => {
    const acs = acText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (!acs.length) return
    setAcBusy(true)
    setAcResult(null)
    setAcFailed(false)
    try {
      await window.api.ac.save(acText)
      // Summarize each saved test (its actions + checks) for the matcher.
      const tests: { name: string; summary: string }[] = []
      for (const t of savedTests) {
        const data = await window.api.library.load(t.fileName)
        if (!data) continue
        const { flat } = await buildRunPlan(data.steps as RecorderStep[])
        tests.push({
          name: data.name,
          summary: flat.map((s) => stepText(s)).join('; ').slice(0, 600)
        })
      }
      const res = await window.api.ac.map(acs, tests)
      if (res === null) setAcFailed(true)
      else setAcResult(res)
    } finally {
      setAcBusy(false)
    }
  }

  // === Day 12: recovery — answer a paused replay ====================
  const answerRecovery = (action: 'retry' | 'continue' | 'skip' | 'stop'): void => {
    setRecovery(null)
    setRecoveryWarning(null)
    setRepickPending(null)
    window.api.recorder.recovery({ action })
  }

  // Retrying an API step RE-FIRES the request. For GET/PUT/DELETE that's harmless —
  // they're idempotent, so sending them twice lands you in the same place. A POST or
  // PATCH is not: if the first attempt reached the server before failing (a 500, a
  // slow response that blew the SLA, a check that didn't hold), the record was
  // already created, and a silent retry creates a SECOND one. The test then passes
  // while quietly doubling its data every run.
  //
  // So: confirm before re-sending a non-idempotent call. Say plainly what may happen.
  const retryIsUnsafe = (i: number): boolean => {
    const s = steps[i]
    if (!s || s.type !== 'api') return false
    const m = (s.apiMethod ?? 'GET').toUpperCase()
    return m === 'POST' || m === 'PATCH'
  }

  const handleRecoveryRetry = (): void => {
    if (!recovery) return
    if (retryIsUnsafe(recovery.index)) {
      const s = steps[recovery.index]
      const m = (s.apiMethod ?? 'GET').toUpperCase()
      const ok = window.confirm(
        `⚠ Retrying will send this ${m} again.\n\n` +
          `${m} ${s.url ?? ''}\n\n` +
          `If the first attempt already reached the server, this may create a DUPLICATE record — ` +
          `the step could go green while quietly leaving two behind.\n\n` +
          `Send it again anyway?`
      )
      if (!ok) return
    }
    answerRecovery('retry')
  }

  // Day 18: PERMANENT skip — disable the failed step (skipped now and in future
  // runs) and continue. setSteps directly (like a re-pick heal) to keep the
  // live replay marks; 💾 Save persists the disable.
  const handleRecoverySkipStep = (): void => {
    if (!recovery) return
    const i = recovery.index
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, disabled: true } : s)))
    answerRecovery('skip')
  }

  // Re-pick: open the Day 9 element picker; the onPicked handler above heals
  // the failed step with the fresh ladder and retries it.
  const handleRecoveryRepick = async (): Promise<void> => {
    if (!recovery) return
    setRecoveryWarning(null)
    setRepickPending(null)
    setRepickIndex(recovery.index)
    setIsPicking(true)
    await window.api.recorder.setPicking(true)
  }

  const handleRecoveryRepickCancel = async (): Promise<void> => {
    setRepickIndex(null)
    setIsPicking(false)
    await window.api.recorder.setPicking(false)
  }

  // === Day 13: failure translator + bug report ======================
  // The renderer assembles the evidence bundle — it owns the steps and their
  // human sentences; main contributed the console/network capture and the
  // screenshot. Then main's translator turns it into a verdict + explanation
  // (Claude CLI when available, built-in rules otherwise — same shape back).
  const handleExplain = async (
    index: number,
    error: string,
    screenshotPath: string | null | undefined,
    consoleErrors: string[],
    networkErrors: string[],
    // F24: an API step fails with an HTTP exchange, not a screenshot — pass it
    // so the analysis reasons over the real request/response.
    apiEvidence?: ApiEvidence
  ): Promise<void> => {
    setBugReport(null)
    setReportSavedPath(null)
    setAnalysis(null)
    setIsDeep(false)
    setAnalysisOpen(true)
    setAnalyzing(true)
    // The page's live URL + title live inside the native browser view — only
    // main can read them (same reason as the Day 11 title-check prefill).
    let pageUrl = urlInput
    let pageTitle = ''
    try {
      const info = await window.api.browser.getPageInfo()
      pageUrl = info.url || urlInput
      pageTitle = info.title
    } catch {
      // keep the URL-bar fallback
    }
    const step = steps[index] as RecorderStep | undefined
    const evidence: FailureEvidence = {
      testName: testName || undefined,
      pageUrl,
      pageTitle,
      stepIndex: index,
      stepText: step ? stepText(step) : `Step ${index + 1}`,
      stepType: step?.type ?? 'unknown',
      selector: step?.selector,
      error,
      consoleErrors,
      networkErrors,
      screenshotPath: screenshotPath ?? undefined,
      apiEvidence: apiEvidence ?? lastFailures.find((f) => f.index === index)?.apiEvidence,
      allSteps: steps.map((s) => stepText(s)),
      // F29: same as the multi-failure bundle below — the triage MUST know the slowness
      // was injected, or it reports a chaos timeout as a dead server and sends you off to
      // restart a service that never stopped. (This single-failure path was missed the
      // first time round, and only surfaced once a teardown stopped counting as a second
      // failure — which routed the very same run down here instead.)
      chaos: chaosSlowNet ? { slowNetwork: true, latencyMs: 2000 } : undefined
    }
    setLastEvidence(evidence)
    try {
      setAnalysis(await window.api.translator.explain(evidence))
    } catch {
      setAnalysis({
        source: 'rules',
        verdict: 'unknown',
        explanation: 'The translator could not run — see the raw evidence below.',
        suggestion: ''
      })
    }
    setAnalyzing(false)
  }

  // Whole-test analysis: when a test failed at several steps (Continue mode),
  // explain ALL of them at once — one verdict + one write-up covering every
  // failure — instead of step-by-step. Builds one evidence bundle carrying the
  // full failures[] list; the primary fields mirror the first failure.
  const handleExplainAll = async (): Promise<void> => {
    if (!lastFailures.length) return
    setBugReport(null)
    setReportSavedPath(null)
    setAnalysis(null)
    setIsDeep(false)
    setAnalysisOpen(true)
    setAnalyzing(true)
    let pageUrl = urlInput
    let pageTitle = ''
    try {
      const info = await window.api.browser.getPageInfo()
      pageUrl = info.url || urlInput
      pageTitle = info.title
    } catch {
      // keep the URL-bar fallback
    }
    const failures = lastFailures.map((f) => {
      const s = steps[f.index] as RecorderStep | undefined
      return {
        index: f.index,
        stepText: s ? stepText(s) : `Step ${f.index + 1}`,
        error: f.error,
        selector: s?.selector,
        screenshotPath: f.screenshotPath,
        // F24: an API failure's evidence is its HTTP exchange, not a screenshot.
        apiEvidence: f.apiEvidence
      }
    })
    const first = failures[0]
    const primaryStep = steps[first.index] as RecorderStep | undefined
    const evidence: FailureEvidence = {
      testName: testName || undefined,
      pageUrl,
      pageTitle,
      stepIndex: first.index,
      stepText: first.stepText,
      stepType: primaryStep?.type ?? 'unknown',
      selector: first.selector,
      error: first.error,
      consoleErrors: lastConsoleErrors,
      networkErrors: lastNetworkErrors,
      screenshotPath: first.screenshotPath,
      apiEvidence: first.apiEvidence,
      allSteps: steps.map((s) => stepText(s)),
      failures,
      // F29: tell the triage that the slowness was INJECTED. Without this it sees a
      // timeout with no response, concludes the service is down, and sends you off to
      // restart a server that never stopped.
      chaos: chaosSlowNet ? { slowNetwork: true, latencyMs: 2000 } : undefined
    }
    setLastEvidence(evidence)
    try {
      setAnalysis(await window.api.translator.explain(evidence))
    } catch {
      setAnalysis({
        source: 'rules',
        verdict: 'unknown',
        explanation: 'The translator could not run — see the raw evidence below.',
        suggestion: ''
      })
    }
    setAnalyzing(false)
  }

  const closeAnalysis = (): void => {
    setAnalysisOpen(false)
    setAnalyzing(false)
    setAnalysis(null)
    setBugReport(null)
    setReportSavedPath(null)
    setIsDeep(false)
  }

  // F9 Stage 3: Deep RCA — feed the WHOLE run trace (every step + screenshot) to
  // the LLM to find a root cause that may be EARLIER than the reported failure.
  // Opt-in (this button), one failure at a time; slower than a normal explain.
  const handleDeepRca = async (): Promise<void> => {
    if (!lastTraceId) return
    setIsDeep(true)
    setBugReport(null)
    setAnalyzing(true)
    setAnalysis(null)
    try {
      const res = (await window.api.translator.deepRca(lastTraceId)) as FailureAnalysis | null
      setAnalysis(
        res ?? {
          source: 'rules',
          verdict: 'unknown',
          explanation:
            'Deep RCA could not run — it needs the Claude CLI (and a saved run trace). The normal analysis still applies.',
          suggestion: ''
        }
      )
    } finally {
      setAnalyzing(false)
    }
  }

  // Bug report = the SAME evidence formatted for humans (plus the verdict,
  // when an analysis ran). Generated in place, inside the analysis modal.
  const handleGenerateReport = (): void => {
    if (!lastEvidence) return
    setBugReport(generateBugReport(lastEvidence, analysis))
    setReportSavedPath(null)
  }

  const handleCopyReport = (): void => {
    if (bugReport) navigator.clipboard.writeText(bugReport)
  }

  const handleSaveReport = async (): Promise<void> => {
    if (!bugReport || !lastEvidence) return
    const path = await window.api.translator.saveReport(bugReport, bugReportFileName(lastEvidence))
    if (path) setReportSavedPath(path)
  }

  // F34: open the Jira ticket modal, pre-filled from THIS failure — the summary
  // is the one-line title, the description is the whole bug report.
  const handleOpenJira = (): void => {
    if (!lastEvidence) return
    setJiraSummaryText(jiraSummary(lastEvidence))
    setJiraDescText(bugReport ?? generateBugReport(lastEvidence, analysis))
    setJiraNote('')
    setJiraOpen(true)
  }
  // F34: push the ticket to Jira via REST. Persists site/email/project (not token).
  const handleJiraCreate = async (): Promise<void> => {
    if (!jiraBaseUrl.trim() || !jiraEmail.trim() || !jiraToken.trim() || !jiraProject.trim()) {
      setJiraNote('⚠ Fill in the Jira site, email, API token, and project key first.')
      return
    }
    setJiraBusy(true)
    setJiraNote('Creating the issue in Jira…')
    localStorage.setItem('jira.baseUrl', jiraBaseUrl.trim())
    localStorage.setItem('jira.email', jiraEmail.trim())
    localStorage.setItem('jira.project', jiraProject.trim())
    try {
      const res = await window.api.jira.createIssue({
        baseUrl: jiraBaseUrl.trim(),
        email: jiraEmail.trim(),
        apiToken: jiraToken.trim(),
        projectKey: jiraProject.trim(),
        summary: jiraSummaryText,
        description: jiraDescText
      })
      setJiraNote(res.ok ? `✓ Created ${res.key} — ${res.url}` : `⚠ ${res.error || 'Jira rejected the request.'}`)
    } finally {
      setJiraBusy(false)
    }
  }
  // F34: the no-token path — copy the ticket + open Jira's create page in the browser.
  const handleJiraCopyOpen = async (): Promise<void> => {
    await navigator.clipboard.writeText(`${jiraSummaryText}\n\n${jiraDescText}`).catch(() => {})
    if (jiraBaseUrl.trim()) {
      localStorage.setItem('jira.baseUrl', jiraBaseUrl.trim())
      await window.api.jira.openCreate(jiraBaseUrl.trim())
      setJiraNote('✓ Ticket copied. Opened Jira’s create page — paste it into the description.')
    } else {
      setJiraNote('✓ Ticket copied. Add your Jira site URL to open the create page, or paste it into Jira yourself.')
    }
  }


  // === Day 11: test library =========================================
  const handleOpenSavePanel = async (): Promise<void> => {
    const base = baseURL || deriveBaseURL(steps)
    let suggested = testName
    if (!suggested && base) {
      try {
        suggested = `${new URL(base).hostname.replace(/^www\./, '')} flow`
      } catch {
        suggested = ''
      }
    }
    setSaveNameInput(suggested)
    setSaveSuite(testSuite || 'Daily')
    setNewSuiteInput('')
    setSuites(await window.api.library.listSuites())
    setSavePanelOpen(true)
  }

  // Day 17 (viewport emulation): set the device viewport and apply it live so
  // the embedded browser re-renders at that size immediately.
  //
  // F36: this is now the back-compat entry point — it's what a saved test with
  // only a `viewport` (no deviceId) goes through, and it deliberately clears any
  // device signals so that test behaves exactly as it did before F36.
  const applyViewport = (vp: { width: number; height: number } | undefined): void => {
    setViewport(vp)
    setDeviceId(undefined)
    window.api.browser.setViewport(vp ?? null)
  }

  // F36: choose a device by id — applies size AND userAgent/touch/pixel-density
  // to the live browser. Passing undefined returns it to a plain desktop.
  const applyDevice = (id: string | undefined): void => {
    const profile = deviceById(id)
    setDeviceId(profile ? id : undefined)
    setViewport(profile?.viewport)
    window.api.browser.setDevice(
      profile
        ? {
            viewport: profile.viewport,
            userAgent: profile.userAgent,
            deviceScaleFactor: profile.deviceScaleFactor,
            isMobile: profile.isMobile,
            hasTouch: profile.hasTouch
          }
        : null
    )
  }

  // F36: re-apply a loaded test's saved device. resolveDevice handles the three
  // cases — a known profile, an unknown id (fall back to the saved size, never
  // silently to desktop), and a pre-F36 test that has only a viewport.
  const applySavedDevice = (
    savedDeviceId: string | undefined,
    savedViewport: { width: number; height: number } | undefined
  ): void => {
    const profile = resolveDevice(savedDeviceId, savedViewport)
    setDeviceId(savedDeviceId)
    setViewport(profile?.viewport)
    window.api.browser.setDevice(
      profile
        ? {
            viewport: profile.viewport,
            userAgent: profile.userAgent,
            deviceScaleFactor: profile.deviceScaleFactor,
            isMobile: profile.isMobile,
            hasTouch: profile.hasTouch
          }
        : null
    )
  }

  // Day 17 (session reuse): capture the embedded browser's CURRENT state (after
  // logging in) as a named session, then auto-attach it to this test.
  const handleSaveSession = async (): Promise<void> => {
    const name = sessionNameInput.trim()
    if (!name) return
    const file = await window.api.session.save(name)
    if (file) {
      setSessionNameInput('')
      setStorageState(file)
      refreshSessions()
    }
  }

  // Day 17(+): seed the chosen session into the live browser, then drop into the
  // logged-in page so the user can record post-login steps without re-logging in.
  const handleUseSession = async (): Promise<void> => {
    if (!useSessionSel) return
    setUseSessionError(null)
    setApplyingSession(true)
    // Open the URL the user typed (so a post-login page like /inventory.html
    // opens directly, logged in) — or the session's own site if the box is empty.
    const res = await window.api.session.apply(useSessionSel, urlInput.trim() || undefined)
    setApplyingSession(false)
    if (res?.ok) {
      // Auto-attach: the session you used to RECORD is also the session the test
      // needs to REPLAY — wire both halves so you pick it once. Saving the test
      // (or a draft) now carries it automatically; the Save panel shows it set.
      setStorageState(useSessionSel)
      setHasNavigated(true) // welcome → chrome view
      if (res.url) setUrlInput(res.url)
    } else {
      setUseSessionError(res?.error ?? 'Could not open that session')
    }
  }

  const handleSaveTest = async (): Promise<void> => {
    const name = saveNameInput.trim()
    if (!name) return
    // A typed new section name wins over the chosen chip.
    const suite = newSuiteInput.trim() || saveSuite || 'Daily'
    const base = baseURL || deriveBaseURL(steps)
    const summary = await window.api.library.save({
      name,
      baseURL: base,
      suite,
      steps,
      storageState,
      viewport,
      deviceId, // F36: the device profile travels with the test
      tags, // F38: the labels travel with it too
      dataRows, // Day 20: data-driven table travels with the test
      captureHar: harCount > 0 // F1: bank the just-captured network, if any
    })
    if (harCount > 0) setHarField(summary.har)
    // F12: saving may have snapshotted the previous steps as a new version —
    // refresh the in-memory history so it's up to date without a reload.
    const savedFull = await window.api.library.load(summary.fileName)
    setTestVersions(savedFull?.versions ?? [])
    // Renaming or re-sectioning = a MOVE: the save created the new file, so
    // drop the old one (otherwise stale copies pile up under the old name).
    if (testFileName && testFileName !== summary.fileName) {
      await window.api.library.remove(testFileName)
    }
    setTestName(name)
    setTestFileName(summary.fileName)
    setTestSuite(summary.suite)
    setBaseURL(base)
    setSavePanelOpen(false)
    setHealedIndices(new Set()) // healed selectors are on disk now — hint done
    // AI heals are on disk now too (they ride on the step as healedByAi, so the
    // badge still shows) — drop the transient live-run set.
    setAiHealedIndices(new Set())
    // Day 18: it's a real test now — drop the auto-saved draft.
    if (draftIdRef.current) {
      window.api.drafts.delete(draftIdRef.current)
      draftIdRef.current = null
    }
  }

  // Open a saved test: its steps become the working list (the single source
  // of truth, same as after recording), and the browser shows its start page.
  const handleLoadTest = async (fileName: string): Promise<void> => {
    const test = await window.api.library.load(fileName)
    if (!test) return
    editSteps(test.steps)
    setTestName(test.name)
    setTestFileName(fileName)
    setTestSuite(fileName.includes('/') ? fileName.split('/')[0] : '')
    setBaseURL(test.baseURL)
    setStorageState(test.storageState)
    setHarField(test.har) // F1: replay this test against its saved HAR, if any
    setLastHarUsage(null)
    setTestVersions(test.versions ?? []) // F12: this test's edit history
    setHistoryOpen(false)
    // F20 (Option 2): drop any in-memory edge run from the previous test and load
    // THIS test's persisted edge-run history for the "🧨 Edge runs" list.
    setEdgeRun(null)
    setEdgeReportOpen(false)
    refreshEdgeHistory(fileName)
    applySavedDevice(test.deviceId, test.viewport)
    setTags(test.tags ?? []) // F38
    setDataRows(test.dataRows ?? []) // Day 20: data-driven table
    setDataPanelOpen(false)
    setHasNavigated(true)
    const firstNav = test.steps.find((s) => s.type === 'navigate' && s.url)
    if (firstNav?.url) {
      setUrlInput(firstNav.url)
      window.api.browser.navigate(firstNav.url)
    }
  }

  // Day 18: restore an auto-saved draft (an unsaved recording). Like opening a
  // test, but it has no fileName — it stays a draft until explicitly saved, and
  // editing it keeps updating the SAME draft.
  const handleLoadDraft = async (id: string): Promise<void> => {
    const d = await window.api.drafts.load(id)
    if (!d) return
    editSteps(d.steps)
    setTestName(d.name || '')
    setTestFileName(null)
    setTestSuite(d.suite || '')
    setBaseURL(d.baseURL || '')
    setStorageState(d.storageState)
    applySavedDevice(d.deviceId, d.viewport)
    setTags(d.tags ?? []) // F38
    setDataRows(d.dataRows ?? []) // Day 20: data-driven table
    setDataPanelOpen(false)
    draftIdRef.current = d.id
    setDraftDismissed(true)
    setHasNavigated(true)
    const firstNav = d.steps.find((s) => s.type === 'navigate' && s.url)
    if (firstNav?.url) {
      setUrlInput(firstNav.url)
      window.api.browser.navigate(firstNav.url)
    }
  }

  const handleDeleteDraft = async (id: string): Promise<void> => {
    await window.api.drafts.delete(id)
    setDrafts((prev) => prev.filter((d) => d.id !== id))
    if (draftIdRef.current === id) draftIdRef.current = null
  }

  // A friendly label for a draft: its name if it was given one, else the site
  // it's recording (the first URL's domain), else a fallback.
  const draftLabel = (d: DraftSummary): string => {
    if (d.name) return d.name
    if (d.firstUrl) {
      try {
        return new URL(d.firstUrl).hostname.replace(/^www\./, '')
      } catch {
        return d.firstUrl
      }
    }
    return 'Untitled recording'
  }

  // === Day 11.5: suite runner =======================================
  // Run every test in a section, one after another, CONTINUING past failures
  // (each test starts from a clean browser state, so one red can't poison the
  // next) — then show the full picture, like a CI run.
  const handleRunSuite = async (
    suite: string,
    tests: SavedTestSummary[],
    // F39.1: force the in-app path even with parallel mode ticked. Used by
    // "re-run the failures in the app" — the whole point of that button is to
    // re-run them through the engine that HAS self-heal and the recovery pause.
    opts?: { forceSequential?: boolean }
  ): Promise<void> => {
    if (tests.length === 0) return
    const useParallel = parallelMode && !opts?.forceSequential
    // F25 guard, BEFORE we navigate away from the library: a suite spans several
    // sites, so read each test's RECORDED base URL and warn once with the full
    // picture. This is where the trap bites hardest — one active env silently
    // retargets every test in the suite.
    const bases = await Promise.all(
      tests.map(async (t) => {
        const d = await window.api.library.load(t.fileName)
        return {
          name: t.name,
          fromBase: d ? d.baseURL || deriveBaseURL(d.steps as RecorderStep[]) : '',
          // F24: the guard inspects each test's API-step URLs too — this is where
          // the prod-write trap bites hardest (one env, the whole suite).
          steps: d ? (d.steps as RecorderStep[]) : []
        }
      })
    )
    const suiteChoice = await confirmRetargetFor(bases)
    if (suiteChoice === 'cancel') return
    const suiteNoEnv = suiteChoice === 'noenv'
    // A sequential run drives the embedded browser, so it belongs in the
    // workspace. A PARALLEL batch doesn't touch that browser at all — it shells
    // out to headless Playwright — so switching to the workspace would show a
    // large empty pane with nothing in it (main only reveals the browser once
    // something has really navigated it, which never happens here). Stay in the
    // library instead; the progress bar and the report both render there.
    if (!useParallel) setHasNavigated(true)
    // F39: these describe THIS run, not the last one.
    parallelSkipReasons.current = new Map()
    setParallelNote(null)
    setSuiteRun({
      suite,
      total: tests.length,
      current: 0,
      currentName: '',
      results: [],
      running: true
    })

    // === F39: parallel pre-pass ===================================
    // When parallel mode is on, run everything that MEANS THE SAME THING
    // headlessly in one Playwright process with N workers, then fall through to
    // the normal sequential loop for the rest. Nothing is skipped — a test that
    // can't run headless runs the old way, and the report says which is which.
    let parallelDone = new Map<string, SuiteRunEntry>()
    const sequentialTests: SavedTestSummary[] = []
    if (useParallel) {
      const safe: {
        test: SavedTestSummary
        code: string
        sessionFile?: string
        refs: (string | undefined)[] // F40: secret refs this test needs resolved
        // F39 fix: the assets the generated spec references by RELATIVE path.
        // A manual export copies these beside the spec; the parallel runner
        // never did, so an upload step died on ENOENT …\fixtures\<name>.
        fixturePaths?: string[]
        harFile?: string
      }[] = []
      for (const t of tests) {
        const data = await window.api.library.load(t.fileName)
        if (!data) {
          sequentialTests.push(t) // let the sequential loop report the read error
          continue
        }
        const blockers = headlessBlockers(data.steps as RecorderStep[])
        if (blockers.length) {
          // Would not mean the same thing headlessly — see headless.ts. Runs
          // sequentially instead, with the reason kept for the report.
          sequentialTests.push(t)
          parallelSkipReasons.current.set(t.fileName, blockerSummary(blockers))
          continue
        }
        const { flat } = await buildRunPlan(data.steps as RecorderStep[])
        // F37 × F39: a test with a mismatched loop/if marker has no single
        // correct structure — the app refuses to run one for exactly that
        // reason. The exporter now auto-closes the block so the spec at least
        // parses (an unbalanced brace is a fatal LOAD error that abandons the
        // whole batch), but running our GUESS at the structure headless and
        // reporting the result as fact is not something this app should do.
        // Send it down the sequential path, where the app's own check applies.
        const cfErrors = analyzeControlFlow(flat).errors
        if (cfErrors.length) {
          sequentialTests.push(t)
          parallelSkipReasons.current.set(t.fileName, cfErrors[0])
          continue
        }
        const cols = dataColumns(flat)
        const rows = data.dataRows ?? []
        safe.push({
          test: t,
          code: generatePlaywrightTest(flat, {
            name: data.name,
            baseURL: data.baseURL || deriveBaseURL(flat),
            viewport: data.viewport,
            device: data.deviceId ? deviceById(data.deviceId) : undefined, // F36
            tags: data.tags, // F38
            data: cols.length > 0 && rows.length > 0 ? { columns: cols, rows } : undefined
          }),
          sessionFile: data.storageState || undefined,
          refs: flat.map((s) => s.secretRef),
          // Absolute source paths — main copies them into the run folder and
          // repoints the spec at the copies.
          fixturePaths: Array.from(
            new Set(
              flat
                .filter((s) => s.type === 'upload' && !s.disabled && s.value)
                .flatMap((s) => (s.value ?? '').split('\n').filter(Boolean))
            )
          ),
          harFile: (data as { har?: string }).har || undefined
        })
      }
      if (safe.length) {
        setSuiteRun((prev) => (prev ? { ...prev, parallelBatch: safe.length } : prev))
        // F40: the exported specs read process.env.PASSWORD, and the value now
        // lives in userData rather than in the steps — resolve it for this run.
        const secretRefs = safe
          .flatMap((s) => s.refs)
          .filter((r): r is string => typeof r === 'string' && !!r)
        let batchEnv: Record<string, string> | undefined = suiteNoEnv ? {} : undefined
        if (secretRefs.length) {
          const resolved = await window.api.xbrowser.resolveSecrets(secretRefs)
          const password = secretRefs.map((r) => resolved[r]).find((v) => v)
          if (password) batchEnv = { ...(batchEnv ?? {}), PASSWORD: password }
        }
        const res = await window.api.xbrowser.runSuite(
          safe.map((s) => ({
            id: s.test.fileName,
            name: s.test.name,
            code: s.code,
            sessionFile: s.sessionFile,
            fixturePaths: s.fixturePaths,
            harFile: s.harFile
          })),
          parallelWorkers,
          batchEnv
        )
        if (!res.installed || !res.ran) {
          // Fall back to sequential rather than failing the whole suite — the
          // tests are fine, the runner isn't available.
          setParallelNote(
            `${res.message ?? 'The parallel runner could not start'} — ran everything sequentially instead.`
          )
          // The batch is over — it never started. Only the SUCCESS path used to
          // clear this, so after a fallback the progress line went on claiming
          // "Running 55 tests at once, 4 at a time…" for the entire sequential
          // run that followed, and the running banner stayed up with it. The
          // screen said parallel while the app was visibly replaying one test at
          // a time (Surbhi, Test 7).
          setSuiteRun((prev) => (prev ? { ...prev, parallelBatch: undefined } : prev))
          sequentialTests.push(...safe.map((s) => s.test))
        } else {
          parallelDone = new Map(
            res.results.map((r) => {
              const t = safe.find((s) => s.test.fileName === r.id)!.test
              return [
                r.id,
                {
                  fileName: r.id,
                  name: t.name,
                  status: r.ok ? ('passed' as const) : ('failed' as const),
                  error: r.error,
                  // Parallel results carried NO category, so every headless
                  // failure fell into "unclassified" — 20 of 20 in Test 12,
                  // which made the breakdown useless on the runs that best
                  // predict CI. Playwright's wording differs from ours, so it
                  // gets its own (deliberately coarser) rules.
                  category: r.ok ? undefined : headlessCategory(r.error),
                  ranParallel: true
                }
              ]
            })
          )
          // A parallel result is still a real run — record it in the history so
          // the library dots and F2 flaky analytics don't silently miss it.
          for (const [fileName, entry] of parallelDone) {
            await window.api.library.recordRun(fileName, {
              status: entry.status,
              at: new Date().toISOString(),
              error: entry.error
            })
          }
          setSuiteRun((prev) =>
            prev
              ? {
                  ...prev,
                  results: [...prev.results, ...parallelDone.values()],
                  // Batch over — back to a real per-test counter for any
                  // sequential leftovers.
                  parallelBatch: undefined,
                  current: parallelDone.size
                }
              : prev
          )
        }
      }
    }
    // In parallel mode the sequential loop only handles the leftovers.
    const toRunSequentially = useParallel ? sequentialTests : tests
    // Those leftovers DO drive the embedded browser, so now the workspace is
    // the right place to be. An all-parallel batch never gets here and stays in
    // the library.
    if (toRunSequentially.length > 0) setHasNavigated(true)

    for (let i = 0; i < toRunSequentially.length; i++) {
      const t = toRunSequentially[i]
      // Progress counts the parallel batch too, so "12 of 40" stays honest.
      const doneBefore = parallelDone.size
      setSuiteRun((prev) =>
        prev ? { ...prev, current: doneBefore + i + 1, currentName: t.name } : prev
      )
      const data = await window.api.library.load(t.fileName)
      let entry: SuiteRunEntry
      if (!data) {
        entry = {
          fileName: t.fileName,
          name: t.name,
          status: 'failed',
          error: 'Could not read the test file'
        }
      } else {
        // Show this test in the panel while it runs (steps + live marks).
        editSteps(data.steps)
        // Also surface its data table — else a data-driven test shows 0 rows in the
        // 🧪 Data panel during/after a suite run (the rows still ran; only the panel
        // was stale), which reads as "my rows vanished".
        setDataRows(data.dataRows ?? [])
        setTestName(data.name)
        setTestFileName(t.fileName)
        setTestSuite(suite)
        setBaseURL(data.baseURL)
        // F36 (fixes a Day-17 gap): apply THIS test's device before replaying
        // it. The suite loop already honours each test's own session, HAR and
        // base URL — the viewport was the one saved property it ignored, so a
        // mobile test in a Run All silently rendered at whatever size the
        // workspace happened to be on. A suite of mixed devices was testing the
        // wrong one for most of its tests.
        applySavedDevice(data.deviceId, data.viewport)
        setTags(data.tags ?? []) // F38
        // Live-link: expand any linked blocks before running (a block ref must
        // never reach the replay engine — it only understands real steps).
        const { flat: flatSuite, map: suiteMap } = await buildRunPlan(data.steps as RecorderStep[])
        runPlanRef.current = suiteMap
        // F25: run this test against the active environment — resolve its
        // {{env:}} creds + re-point its navigations (its OWN recorded base is the
        // anchor). No active env → unchanged. This is the scale win: one Run All,
        // every test against staging/prod in one click.
        // Day 20 fix: a DATA-DRIVEN test (its steps use {{column}} tokens AND it
        // carries saved rows) must run EVERY row here too. The suite path used to
        // substitute only {{env:}} against an EMPTY row, so data tokens reached the
        // page as literal text ("{{expectedError}}") and the test failed for the
        // wrong reason. Expand it into one run per row and aggregate to a single
        // suite result — the suite cousin of handleRunData.
        const suiteCols = dataColumns(flatSuite)
        const suiteRows = data.dataRows ?? []
        let result: Awaited<ReturnType<typeof runOnce>>
        if (suiteCols.length > 0 && suiteRows.length > 0) {
          // The suite's data-driven path. Its env tokens live in the ROWS (a
          // password column of {{env:SAUCE_PW}}), which applyEnv never scans —
          // so without this a data-driven test reported nothing while all 5 rows
          // typed an empty password. Found by exactly that, on Positive Login.
          const { values: envMap, unresolved: envMissing } =
            await window.api.recorder.resolveEnv(envVarNames(flatSuite, suiteRows))
          unresolvedEnvRef.current = envMissing
          const rowOutcomes: { label: string; r: Awaited<ReturnType<typeof runOnce>> }[] = []
          let rowAborted = false
          for (let r = 0; r < suiteRows.length; r++) {
            // Show ROW progress in the suite header — a data-driven test runs many
            // times, so "test 1 of 1" alone hid that 6 rows were running.
            setSuiteRun((prev) =>
              prev
                ? { ...prev, currentName: `${data.name} — row ${r + 1}/${suiteRows.length}` }
                : prev
            )
            let list = substituteSteps(flatSuite, resolveRow(suiteRows[r], envMap), envMap)
            if (activeEnv?.baseURL && !suiteNoEnv) {
              list = retargetSteps(list, data.baseURL || deriveBaseURL(flatSuite), activeEnv.baseURL)
            }
            // fileName null: don't stamp a run per row — record ONE aggregate below.
            const rr = await runOnce(list, null, false, data.storageState, data.har)
            if (rr.aborted) {
              rowAborted = true
              break
            }
            rowOutcomes.push({ label: rowLabel(suiteRows[r], r), r: rr })
          }
          if (rowAborted) {
            setSuiteRun((prev) => (prev ? { ...prev, running: false } : prev))
            return
          }
          const failedRows = rowOutcomes.filter((x) => !x.r.ok)
          const firstF = failedRows[0]
          // A data-driven test in a suite is ONE entry: green only if every row
          // passed, else red with an "N/M rows failed — e.g. …" summary.
          result = {
            ...rowOutcomes[0].r,
            ok: failedRows.length === 0,
            failedAt: firstF?.r.failedAt,
            error: failedRows.length
              ? `${failedRows.length}/${rowOutcomes.length} rows failed — e.g. ${firstF!.label}: ${firstF!.r.error}`
              : undefined,
            screenshotPath: firstF?.r.screenshotPath,
            category: firstF?.r.category,
            aiHealed: rowOutcomes.reduce((n, x) => n + (x.r.aiHealed ?? 0), 0) || undefined,
            healable: rowOutcomes.find((x) => x.r.healable)?.r.healable
          }
          // Per-row runs passed fileName null, so stamp ONE aggregate run for the file.
          await window.api.library.recordRun(t.fileName, {
            status: failedRows.length ? 'failed' : 'passed',
            at: new Date().toISOString(),
            failedAt: firstF?.r.failedAt,
            error: result.error,
            screenshotPath: firstF?.r.screenshotPath,
            category: firstF?.r.category
          })
        } else {
          const listSuite = await applyEnv(
            flatSuite,
            data.baseURL || deriveBaseURL(flatSuite),
            suiteNoEnv
          )
          // F1: each test in the suite replays against its own saved HAR, if any.
          result = await runOnce(listSuite, t.fileName, false, data.storageState, data.har)
        }
        entry = {
          fileName: t.fileName,
          name: data.name,
          status: result.ok ? 'passed' : 'failed',
          failedAt: result.failedAt,
          error: result.error,
          screenshotPath: result.screenshotPath,
          category: result.category,
          healed: result.aiHealed,
          // Read from the ref: applyEnv set it while building THIS test's steps.
          unresolvedEnv: unresolvedEnvRef.current.length
            ? [...unresolvedEnvRef.current]
            : undefined
        }
        // B: this test's selectors auto-healed — capture the REPAIRED display
        // steps (block-aware, updated by the auto-heal events) so the report can
        // offer "Save all healed" and persist every fix in one click.
        if (result.aiHealed && result.aiHealed > 0) {
          await new Promise((r) => setTimeout(r, 0)) // let heal events flush into `steps`
          const save: HealedSave = {
            fileName: t.fileName,
            name: data.name,
            saveInput: {
              name: data.name,
              baseURL: data.baseURL,
              // The TEST'S OWN section — not `suite`, which is this RUN's display
              // label ("8 selected tests", "17 failed tests"). Saving under the
              // run label wrote a healed DUPLICATE into a folder named after the
              // run and left the real test untouched, so the heal looked saved,
              // reappeared on the next run, and the library quietly grew a junk
              // section every time. Both "8 selected tests" and "17 failed tests"
              // in the library are old run labels created exactly this way.
              suite: t.suite,
              steps: stepsRef.current.slice(),
              storageState: data.storageState,
              viewport: data.viewport,
              deviceId: data.deviceId, // F36
              tags: data.tags, // F38
              dataRows: data.dataRows
            }
          }
          setSuiteRun((prev) =>
            prev ? { ...prev, healedSaves: [...(prev.healedSaves ?? []), save] } : prev
          )
        }
        // Option 2: the test FAILED but self-heal found a likely fix — capture it
        // for the report's "review & accept" list (never auto-applied in a batch).
        if (result.healable) {
          const hf: HealableFail = {
            fileName: t.fileName,
            name: data.name,
            // The test's own section, for the same reason as the healed-save
            // above: handleAcceptHealable saves with this, and the run label
            // would file the accepted fix as a duplicate in a junk folder.
            suite: t.suite,
            hasBlocks: (data.steps as RecorderStep[]).some((s) => s.type === 'block'),
            healable: result.healable
          }
          setSuiteRun((prev) =>
            prev ? { ...prev, healables: [...(prev.healables ?? []), hf] } : prev
          )
        }
      }
      setSuiteRun((prev) => (prev ? { ...prev, results: [...prev.results, entry] } : prev))
    }
    setSuiteRun((prev) => (prev ? { ...prev, running: false } : prev))
    // F39.2: re-read the sessions and the library before the report renders.
    // Both were loaded at startup, so the report could name an expiry that had
    // already been replaced, and count tests whose session was already removed —
    // a warning that is itself out of date is worse than none, because it sends
    // you to fix something you have already fixed (Surbhi, Test 7).
    refreshSessions()
    setSavedTests(await window.api.library.list())
  }

  const handleDeleteTest = async (test: SavedTestSummary): Promise<void> => {
    if (!window.confirm(`Delete "${test.name}"? This cannot be undone.`)) return
    await window.api.library.remove(test.fileName)
    setSavedTests(await window.api.library.list())
  }

  // B: persist EVERY selector a suite run auto-healed, in one click — no
  // per-test opening/saving across a big suite.
  const handleSaveAllHealed = async (): Promise<void> => {
    const saves = suiteRun?.healedSaves ?? []
    if (!saves.length) return
    for (const s of saves) await window.api.library.save(s.saveInput)
    setSavedTests(await window.api.library.list())
    setSuiteRun((prev) => (prev ? { ...prev, healedSaved: true } : prev))
  }

  // Option 2: accept a found-but-not-confident heal from the report — patch the
  // failing step's selector, stamp it healedByAi, and save. This is the HUMAN
  // confirming the fix (we never applied it silently). Skipped for block tests
  // (the expanded index may not map to a display step — review those manually).
  const handleAcceptHealable = async (hf: HealableFail): Promise<void> => {
    if (hf.hasBlocks) return
    const data = await window.api.library.load(hf.fileName)
    if (!data) return
    const steps = (data.steps as RecorderStep[]).slice()
    const idx = hf.healable.index
    if (idx < 0 || idx >= steps.length) return
    const s = hf.healable.step
    steps[idx] = {
      ...steps[idx],
      label: s.label,
      selector: s.selector,
      candidates: s.candidates,
      frame: s.frame,
      healedByAi: s.healedByAi
    }
    await window.api.library.save({
      name: data.name,
      baseURL: data.baseURL,
      suite: hf.suite,
      steps,
      storageState: data.storageState,
      viewport: data.viewport,
      deviceId: data.deviceId, // F36
      tags: data.tags, // F38
      dataRows: data.dataRows
    })
    setSavedTests(await window.api.library.list())
    setSuiteRun((prev) =>
      prev ? { ...prev, accepted: [...(prev.accepted ?? []), hf.fileName] } : prev
    )
  }
  const handleAcceptAllHealable = async (): Promise<void> => {
    for (const hf of suiteRun?.healables ?? []) {
      if (!hf.hasBlocks && !suiteRun?.accepted?.includes(hf.fileName)) await handleAcceptHealable(hf)
    }
  }

  // B: one shareable markdown report for a whole suite run — pass/fail, the
  // by-category failure breakdown, and the auto-healed tests.
  const generateSuiteReport = (): string => {
    if (!suiteRun) return ''
    const r = suiteRun.results
    const passed = r.filter((x) => x.status === 'passed').length
    const failed = r.length - passed
    const healed = r.reduce((s, x) => s + (x.healed ?? 0), 0)
    const byCat = new Map<string, number>()
    for (const x of r) {
      if (x.status === 'failed') {
        const c = x.category ?? 'unknown'
        byCat.set(c, (byCat.get(c) ?? 0) + 1)
      }
    }
    const lines: string[] = [
      `# Suite run — ${suiteRun.suite}`,
      '',
      `**${passed}/${r.length} passed · ${failed} failed${healed ? ` · ${healed} selector${healed > 1 ? 's' : ''} auto-healed` : ''}**`,
      ''
    ]
    if (byCat.size) {
      lines.push('## Failures by type', '')
      for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
        // The reason travels WITH the count. Pasted into a ticket or a PR, this
        // report is read by someone who can't hover a chip to find out why an
        // "app bug" was called an app bug.
        const why = CATEGORY_WHY[c as FailureCategory]
        lines.push(`- **${CATEGORY_LABELS[c as FailureCategory] ?? c}: ${n}**${why ? ` — ${why}` : ''}`)
      }
      lines.push('')
    }
    // F25: unresolved {{env:…}} — in the pasted report too, since that's what
    // reaches a ticket. Without it the reader sees only the downstream failure.
    {
      const byVar = new Map<string, string[]>()
      for (const r of suiteRun.results) {
        for (const v of r.unresolvedEnv ?? []) {
          byVar.set(v, [...(byVar.get(v) ?? []), r.name])
        }
      }
      if (byVar.size) {
        lines.push('## ⚠ Environment variables with no value', '')
        lines.push(
          `Each was replaced with an empty string, so a failure below may be about the environment rather than the test.`,
          ''
        )
        for (const [v, tests] of byVar) {
          lines.push(
            `- \`{{env:${v}}}\` — ${tests.length} test${tests.length === 1 ? '' : 's'}: ${tests.join(', ')}` +
              (collidesWithOsEnv(v)
                ? ' _(never read from the OS, which defines this name too)_'
                : '')
          )
        }
        lines.push('')
      }
    }
    if (suiteRun.healables?.length) {
      lines.push('## Healable failures (review before accepting)', '')
      for (const hf of suiteRun.healables) {
        lines.push(
          `- ${hf.name} → suggests "${hf.healable.label}" (${hf.healable.signals.join(' + ')} · ${hf.healable.score}/100)`
        )
      }
      lines.push('')
    }
    lines.push('## Tests', '')
    // Two tests can share a display name in different sections (Daily/… and
    // E2E/… both hold a "saucedemo.com flow"). Listing the bare name made one
    // pass and one fail read as the SAME test reported twice with contradictory
    // results — the report looked broken when it was being accurate. Only the
    // ambiguous ones get the section, so the common case stays uncluttered.
    const nameCounts = new Map<string, number>()
    for (const x of r) nameCounts.set(x.name, (nameCounts.get(x.name) ?? 0) + 1)
    const sectionOf = (fileName: string): string =>
      fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/')) : ''
    for (const x of r) {
      const icon = x.status === 'passed' ? '✓' : '✗'
      const tags = [
        x.healed ? `🤖 ${x.healed} healed` : '',
        x.status === 'failed' && x.category ? (CATEGORY_LABELS[x.category] ?? x.category) : ''
      ]
        .filter(Boolean)
        .join(' · ')
      const section =
        (nameCounts.get(x.name) ?? 0) > 1 ? sectionOf(x.fileName) : ''
      lines.push(
        `- ${icon} **${x.name}**${section ? ` \`(${section})\`` : ''}${tags ? ` — ${tags}` : ''}` +
          (x.status === 'failed' && x.error ? `\n  - ${x.error}` : '')
      )
    }
    return lines.join('\n')
  }
  const handleCopySuiteReport = (): void => {
    navigator.clipboard.writeText(generateSuiteReport()).catch(() => {})
  }
  const handleSaveSuiteReport = async (): Promise<void> => {
    const slug = (suiteRun?.suite || 'suite').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    await window.api.translator.saveReport(generateSuiteReport(), `${slug}-run-report.md`)
  }

  // Clone a saved test: duplicate it (steps + session + data + viewport) under a
  // "(copy)" name in the same section, then refresh. Record a happy path once,
  // clone it, and tweak the copy into a variant — no re-recording. Fresh copy =
  // no run history (a new test hasn't been run yet). Reuses load + save; the
  // saved-name slug makes repeat clones land on distinct files (…-copy, …-copy-2).
  const handleCloneTest = async (test: SavedTestSummary): Promise<void> => {
    const full = await window.api.library.load(test.fileName)
    if (!full) return
    await window.api.library.save({
      name: `${full.name} (copy)`,
      baseURL: full.baseURL,
      suite: test.suite,
      steps: full.steps,
      storageState: full.storageState,
      viewport: full.viewport,
      deviceId: full.deviceId, // F36: a clone is the same device as its original
      tags: full.tags, // F38: and carries the same labels
      dataRows: full.dataRows
    })
    setSavedTests(await window.api.library.list())
  }

  // Retarget the test at another environment: rewrite every navigation that
  // lives under the OLD base so it lives under the NEW one. Visible in the
  // step list immediately — no hidden state.
  const handleCommitBaseURL = (): void => {
    setEditingBase(false)
    let next = baseEditValue.trim().replace(/\/+$/, '')
    if (!next) return
    if (!/^https?:\/\//i.test(next)) next = `https://${next}`
    try {
      new URL(next)
    } catch {
      return // not a usable URL — keep the old base
    }
    const old = baseURL
    if (next === old) return
    if (old) {
      editSteps(
        steps.map((s) =>
          s.type === 'navigate' && s.url?.startsWith(old)
            ? { ...s, url: next + s.url.slice(old.length) }
            : s
        )
      )
    }
    setBaseURL(next)
  }

  // === No-code step editor ==========================================
  // Every edit changes the single source of truth — the `steps` array. It also
  // clears the last replay's pass/fail marks (they no longer describe the new
  // list) and closes any open inline edit.
  const editSteps = (next: RecorderStep[]): void => {
    setSteps(next)
    setEditingIndex(null)
    setExpandedIndex(null) // rows may have shifted — an open ladder would lie
    setInsertMenuIndex(null) // same for an open insert-here menu
    setDoneIndices(new Set())
    setFailedIndex(null)
    setReplayError(null)
    setReplayingIndex(null)
    setSkippedIndices(new Set()) // skip marks describe the old order too
    setHealedIndices(new Set()) // healed indices may have shifted — drop the hint
    setAiHealedIndices(new Set()) // AI-heal badges describe the old order too
    setDataRun(null) // Day 20: a past data-run summary describes the old steps
    setFailDetail(null)
    // F24: the recorded HTTP responses describe the OLD list. Insert a step above
    // an API step and every index shifts, so a "↩ 200 · 322 ms" chip would sit on
    // a step that never ran — the exact kind of lie this app exists to prevent.
    setApiResponses({})
    setApiPanelIndex(null)
  }

  // Day 10(c): hand-pick a selector candidate as the step's primary. The pick
  // is recorded as `pinned` — replay tries the pinned candidate FIRST (before
  // higher-scored ones), and export emits its locator. Picking again later
  // simply moves the pin.
  const handlePickCandidate = (stepIdx: number, candIdx: number): void => {
    const step = steps[stepIdx]
    if (!step.candidates) return
    const candidates = step.candidates.map((c, idx) => ({
      ...c,
      pinned: idx === candIdx || undefined
    }))
    setSteps(
      steps.map((s, idx) =>
        idx === stepIdx ? { ...s, selector: candidates[candIdx].locator, candidates } : s
      )
    )
    // Changing the selector invalidates the last replay's pass/fail marks.
    setDoneIndices(new Set())
    setFailedIndex(null)
    setReplayError(null)
  }

  // Move a step one slot up (dir -1) or down (dir +1) by swapping neighbours.
  const handleMoveStep = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = steps.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    editSteps(next)
  }

  const handleDeleteStep = (i: number): void => {
    editSteps(steps.filter((_, idx) => idx !== i))
  }

  // Duplicate a step: insert a copy right after it. Drops the transient
  // recording `id` so the copy is a fresh, independent step.
  const handleDuplicateStep = (i: number): void => {
    const { id: _id, ...copy } = steps[i]
    editSteps([...steps.slice(0, i + 1), copy, ...steps.slice(i + 1)])
  }

  // Turn a step off/on. A disabled step stays in the list (so you don't lose it)
  // but is skipped by both replay and export.
  const handleToggleDisabled = (i: number): void => {
    editSteps(steps.map((s, idx) => (idx === i ? { ...s, disabled: !s.disabled } : s)))
  }

  // F27: mark/unmark a step as one that CREATES persistent data. Prompts for the
  // entity label so a suite can later flag "creates data but has no teardown" —
  // orphan-data risk. Informational only; changes nothing at replay.
  const handleToggleCreatesData = (i: number): void => {
    // Already marked → clear it outright; asking again would be a pointless dialog.
    if (steps[i].createsData) {
      editSteps(steps.map((x, idx) => (idx === i ? { ...x, createsData: undefined } : x)))
      return
    }
    setCreatesDataDraft('')
    setCreatesDataIndex(i)
  }

  const handleSaveCreatesData = (): void => {
    const label = createsDataDraft.trim()
    if (createsDataIndex === null || !label) return
    editSteps(
      steps.map((x, idx) => (idx === createsDataIndex ? { ...x, createsData: label } : x))
    )
    setCreatesDataIndex(null)
    setCreatesDataDraft('')
  }

  // F26: mark a step optional / required. An OPTIONAL step runs when its element
  // is present but is SKIPPED (not failed) when it's absent — for things that
  // may or may not appear, like a cookie banner or a promo popup.
  const handleToggleOptional = (i: number): void => {
    editSteps(steps.map((s, idx) => (idx === i ? { ...s, optional: !s.optional } : s)))
  }

  // Which steps can be optional: ones that TARGET an element (so "present or
  // not" is meaningful). Page/flow steps (navigate, wait, back) always run.
  const canBeOptional = (step: RecorderStep): boolean =>
    ['click', 'type', 'select', 'press', 'hover', 'assert'].includes(step.type)

  // The text an inline edit would change: a navigate edits its URL; a type /
  // select edits its value; a wait edits its seconds; a valued assertion edits
  // its expected text. Clicks have nothing to edit; passwords are never
  // surfaced in a text box. Returns null when the step isn't editable.
  const editableValue = (step: RecorderStep): string | null => {
    if (step.type === 'navigate') return step.url ?? ''
    if (step.secret) return null
    if (step.type === 'type' || step.type === 'select') {
      return step.value ?? ''
    }
    // F3: a fixed wait edits its seconds, a "wait for text" edits the text; a
    // "wait for network idle" has nothing to type.
    if (step.type === 'wait') {
      return step.waitKind === 'network-idle' ? null : (step.value ?? '')
    }
    // Day 19: a snapshot's allowed diff threshold (percent) is editable.
    if (step.type === 'snapshot') return step.value ?? '1'
    // F13: an a11y check's budget (critical|serious|moderate|minor) is editable.
    if (step.type === 'a11y') return step.value ?? 'serious'
    // F14: a perf check's budget (good|needs-improvement) is editable.
    if (step.type === 'perf') return step.value ?? 'needs-improvement'
    if (step.type === 'assert' && step.assertKind && assertNeedsValue(step.assertKind)) {
      return step.value ?? ''
    }
    // Day 16: a prompt's answer text, or a confirm's 'accept'/'dismiss', is
    // editable; an alert has no answer to edit.
    if (step.type === 'dialog' && step.dialogKind !== 'alert') {
      return step.value ?? ''
    }
    // Day 16(+): a download step's expected filename to verify (non-empty is
    // always checked; this is the "correct file" part).
    if (step.type === 'download') return step.value ?? step.label ?? ''
    return null
  }

  // === Day 9: picking + assertion authoring =========================
  const handleStartPick = async (at: number | null): Promise<void> => {
    setInsertMenuIndex(null)
    setPickedElement(null)
    pickBindRef.current = null
    setInsertAt(at)
    setIsPicking(true)
    await window.api.recorder.setPicking(true)
  }

  // F37: pick an element FOR an existing step (a for-each loop's collection, or
  // an if's condition target) instead of creating a new step from it. Kept in a
  // ref, not state, because the pick arrives on an IPC callback registered once
  // at mount — a state value would be captured stale in that closure.
  const handleStartPickFor = async (index: number): Promise<void> => {
    setInsertMenuIndex(null)
    setPickedElement(null)
    pickBindRef.current = index
    setIsPicking(true)
    await window.api.recorder.setPicking(true)
  }

  const handleCancelPick = async (): Promise<void> => {
    setIsPicking(false)
    await window.api.recorder.setPicking(false)
  }

  // Insert a finished step at the requested position (null = append).
  const insertStep = (step: RecorderStep, at: number | null): void => {
    const i = at ?? steps.length
    editSteps([...steps.slice(0, i), step, ...steps.slice(i)])
  }

  // F37: patch fields on one step in place (a loop's count, an if's condition).
  // Goes through editSteps so it joins the normal undo/version/auto-save flow
  // rather than mutating behind their backs.
  const updateStepField = (index: number, patch: Partial<RecorderStep>): void => {
    const next = steps.slice()
    if (!next[index]) return
    next[index] = { ...next[index], ...patch }
    editSteps(next)
  }

  // === Pillar 4: reusable step blocks ================================
  const refreshBlocks = async (): Promise<void> => {
    setBlocks((await window.api.blocks.list()) ?? [])
    // F7: load the blast-radius map alongside the list, so every row can show
    // how many tests it affects (and the edit banner can name them).
    setBlockUsage((await window.api.blocks.usage()) ?? {})
  }
  // Open the blocks panel. `insertAt` = where a chosen block's steps land
  // (null = append); also seed the save-range to the full current step list.
  const openBlocksPanel = (insertAt: number | null): void => {
    setBlockInsertAt(insertAt)
    setBlockFrom(1)
    setBlockTo(steps.length)
    setBlockNameInput('')
    setInsertMenuIndex(null)
    setBlocksCollapsed(false) // always open expanded
    setEditingBlockRef(null) // opening to insert is not an edit detour
    setStashedSteps(null)
    setBlocksPanelOpen(true)
    refreshBlocks()
  }
  // A block MARKER can carry per-step flags of its own — F27's 🗃️ "creates
  // data" is set on the block row, not on the steps inside it. Expanding
  // replaces that marker with the block's inner steps, so the flag used to
  // vanish: a block marked "creates data" reported as creating nothing, and the
  // suite-level "no teardown — orphaned records will pile up" warning silently
  // never fired. The badge showed on the row the whole time, so it looked set.
  //
  // Carried onto the FIRST inner step: once, where a reader expects it, instead
  // of N copies that would list the same label repeatedly in the docs. An inner
  // step with its own marker keeps it — the block's flag never overwrites one
  // the block's author set deliberately.
  const carryBlockFlags = (marker: RecorderStep, inner: RecorderStep[]): RecorderStep[] => {
    if (!marker.createsData || !inner.length) return inner
    const [first, ...rest] = inner
    return [first.createsData ? first : { ...first, createsData: marker.createsData }, ...rest]
  }

  // Replace each linked `block` step with the block's CURRENT steps loaded FRESH
  // from disk (so a run/export always reflects the latest edit — the "live" in
  // live-link). Flattens any nested block refs too. Identity for a test with no
  // block steps. Used by replay + export; display uses the cached expandSteps.
  const expandForRun = async (list: RecorderStep[]): Promise<RecorderStep[]> => {
    const out: RecorderStep[] = []
    for (const s of list) {
      if (s.type === 'block') {
        if (s.disabled || !s.blockRef) continue
        const b = await window.api.blocks.load(s.blockRef)
        if (b) out.push(...carryBlockFlags(s, await expandForRun(b.steps as RecorderStep[])))
      } else {
        out.push(s)
      }
    }
    return out
  }
  // Like expandForRun, but ALSO returns a map from each expanded index → the
  // display-row it came from (a block's inner steps all point back at the block
  // row), so replay marks line up with the collapsed UI. Set into runPlanRef
  // before a run. For a test with no linked blocks the map is the identity.
  const buildRunPlan = async (
    display: RecorderStep[]
  ): Promise<{ flat: RecorderStep[]; map: number[] }> => {
    const flat: RecorderStep[] = []
    const map: number[] = []
    for (let i = 0; i < display.length; i++) {
      const s = display[i]
      if (s.type === 'block') {
        if (s.disabled || !s.blockRef) continue
        const b = await window.api.blocks.load(s.blockRef)
        // Same flag carriage as expandForRun — a block's 🗃️ marker must survive
        // flattening here too, or the docs built from this plan lose it.
        const inner = b ? carryBlockFlags(s, await expandForRun(b.steps as RecorderStep[])) : []
        for (const st of inner) {
          flat.push(st)
          map.push(i)
        }
      } else {
        flat.push(s)
        map.push(i)
      }
    }
    return { flat, map }
  }

  // === F32: run one monitor NOW (headless, via the same Playwright path as F17
  // cross-browser) and stamp the outcome. Never throws — a broken setup is
  // recorded as 'error' (distinct from a real 'failed'), and an alert fires on
  // anything that isn't a clean pass. Called by the scheduler tick and "Run now".
  const runMonitorNow = async (
    mon: Awaited<ReturnType<typeof window.api.monitors.list>>[number]
  ): Promise<void> => {
    // Self-guard: one headless run at a time (a manual click during a scheduled
    // run used to be silently swallowed). monRunningId drives the UI spinner.
    if (monitorBusyRef.current) return
    monitorBusyRef.current = true
    setMonRunningId(mon.id)
    try {
      await doMonitorRun(mon)
    } finally {
      monitorBusyRef.current = false
      setMonRunningId(null)
    }
  }
  // F32b: fire a monitor's alert — a desktop notification AND, if configured, a
  // POST to a Slack/Discord/Teams incoming webhook (a real second alert channel
  // beyond the desktop, so a failure reaches you even away from the machine).
  const fireMonitorAlert = async (
    mon: { name: string },
    run: { status: 'passed' | 'failed' | 'error'; detail?: string }
  ): Promise<void> => {
    const title =
      run.status === 'failed' ? `Monitor failed: ${mon.name}` : `Monitor couldn't run: ${mon.name}`
    const body = run.detail || 'A monitored test just failed.'
    // In-app alert: a visible toast INSIDE the app — the reliable channel, since
    // Windows desktop toasts only show for a packaged/installed app, not in dev.
    // Kept up longer than a normal toast so a background failure isn't missed.
    const short = clip(body, 160)
    setAiToast({ tone: 'fail', msg: `🔔 ${title} — ${short}` })
    // ONE toast slot exists, so the webhook outcome can't arrive as a second
    // toast — it would wipe the failure message before it had been read. It
    // amends THIS toast instead, as soon as the send resolves (usually well
    // under a second), and the dismiss timer restarts so the added line gets
    // its own reading time. Waiting for the first toast to expire and then
    // showing a second was the earlier approach: correct, but the warning
    // landed 12s later, by which point nobody is looking.
    let dismiss = window.setTimeout(() => setAiToast(null), 12000)
    const amend = (extra: string): void => {
      window.clearTimeout(dismiss)
      setAiToast({ tone: 'fail', msg: `🔔 ${title} — ${short}\n${extra}` })
      dismiss = window.setTimeout(() => setAiToast(null), 12000)
    }
    // Desktop toast (fires in a packaged build) + the optional webhook.
    window.api.notify.show(title, body)
    const hook = (localStorage.getItem('monitor.webhookUrl') || '').trim()
    if (!hook) return
    // A webhook that fails must not break the run — but it must not fail SILENTLY
    // either. The result used to be discarded entirely, so a wrong or expired URL
    // looked exactly like a successful send: you'd believe your alerts were
    // reaching Slack for weeks while they went nowhere. Not breaking the run and
    // never telling anyone are different things.
    const sent = await window.api.notify
      .webhook(hook, title, body)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!sent?.ok) {
      amend(
        `⚠ The alert webhook didn’t send — ${sent?.error || 'unknown error'} (the monitor result itself is unaffected).`
      )
    }
  }

  // F32b: retry a FAILING run before alerting — a single transient blip (a slow
  // page, a one-off network hiccup) shouldn't wake you. Up to 3 attempts total;
  // a pass on any attempt clears it. A setup 'error' (missing test / no Playwright)
  // is NOT retried — re-running won't fix it.
  const MONITOR_MAX_ATTEMPTS = 3
  const doMonitorRun = async (
    mon: Awaited<ReturnType<typeof window.api.monitors.list>>[number]
  ): Promise<void> => {
    const test = await window.api.library.load(mon.fileName)
    if (!test) {
      const run = {
        at: new Date().toISOString(),
        status: 'error' as const,
        detail: 'The saved test no longer exists.'
      }
      setMonitors(await window.api.monitors.recordRun(mon.id, run))
      if (mon.alertOnFail) await fireMonitorAlert(mon, run)
      return
    }
    // Build the run inputs ONCE — they don't change between retries.
    let code: string
    let session: string | undefined
    const envVars: Record<string, string> = {}
    try {
      const flat = await expandForRun(test.steps)
      // A data-driven test carries {{column}} tokens that only resolve when the
      // DATA TABLE is handed to the generator (same trap as the F28 fix).
      const cols = dataColumns(flat)
      const rows = test.dataRows ?? []
      code = generatePlaywrightTest(flat, {
        name: test.name || 'monitored flow',
        baseURL: test.baseURL || deriveBaseURL(flat),
        viewport: test.viewport,
        // F36: a monitor watches the test AS SAVED — including its device. The
        // spec's test.use() overrides the run config, so a mobile monitor really
        // runs mobile.
        device: test.deviceId ? deviceById(test.deviceId) : undefined,
        data: cols.length > 0 && rows.length > 0 ? { columns: cols, rows } : undefined
      })
      // F32: run against the monitor's PINNED environment, not the global "Run
      // against" — always an explicit override so the active env can't retarget it.
      const pinned = mon.envId ? envState.environments.find((e) => e.id === mon.envId) : null
      if (pinned) {
        for (const v of pinned.vars) if (v.name) envVars[v.name] = v.value
        if (pinned.baseURL) envVars.BASE_URL = pinned.baseURL
      }
      // A monitor re-runs YOUR OWN saved test on YOUR machine — the secret is on
      // disk already — so use it (a pinned env's PASSWORD still wins).
      if (envVars.PASSWORD === undefined) {
        // F40: the password is no longer in the step — the step carries a ref and
        // the value lives in userData. Ask main for it (same machine, same user).
        // A pre-F40 test that still holds a literal is honoured too, so a monitor
        // keeps working in the window between upgrading and the migration run.
        const refs = flat
          .map((s) => s.secretRef)
          .filter((r): r is string => typeof r === 'string' && !!r)
        if (refs.length) {
          const resolved = await window.api.xbrowser.resolveSecrets(refs)
          const first = refs.map((r) => resolved[r]).find((v) => v)
          if (first) envVars.PASSWORD = first
        }
        if (envVars.PASSWORD === undefined) {
          const secretStep = flat.find(
            (s) => s.type === 'type' && s.secret && s.value && !s.value.includes('{{')
          )
          if (secretStep?.value) envVars.PASSWORD = secretStep.value
        }
      }
      // Every OTHER run path resolves {{env:…}} up front and says which names had
      // no value — in-app replay, single-row, data runs, suite runs. The monitor
      // path didn't, so an undefined variable was handed to the generator as a raw
      // token: the test typed "{{env:SAUCE_PW}}" as a password, stayed on the login
      // page, and reported `Expected pattern /inventory.html` — an assertion failure
      // that says nothing about the actual cause. Diagnosing that took a code read.
      //
      // Recorded as 'error' (setup is broken), not 'failed' (the app under test is
      // broken) — the two mean different things, and errors are deliberately not
      // retried, since running it twice more cannot conjure a missing value.
      const needed = envVarNames(flat, rows)
      if (needed.length) {
        const { values, unresolved } = await window.api.recorder.resolveEnv(needed)
        // The pinned environment wins; resolveEnv only knows the ACTIVE one plus the
        // process, so anything the pin already supplied is not missing.
        //
        // Tested on EMPTINESS, not `undefined`. env:get resolves a missing name to
        // '' and reports it in `unresolved` (index.ts:4577) — so an `undefined`
        // check copies that empty string in, decides the variable is present, and
        // the guard never fires. Which is precisely the failure this guard exists
        // to catch: an empty value passing itself off as a real one.
        for (const n of needed) {
          if (!envVars[n] && values[n]) envVars[n] = values[n]
        }
        const missing = unresolved.filter((n) => !envVars[n])
        if (missing.length) {
          const names = missing.map((n) => `{{env:${n}}}`).join(', ')
          const why =
            mon.envId && !pinned
              ? ' This monitor is pinned to an environment that no longer exists, so none of its variables were applied — pick a different one on the monitor’s card.'
              : ' Add the value to the environment this monitor runs against, or pick a different one on its card.'
          const run = {
            at: new Date().toISOString(),
            status: 'error' as const,
            detail: `${missing.length} environment variable${missing.length === 1 ? '' : 's'} had no value: ${names}.${why}`
          }
          setMonitors(await window.api.monitors.recordRun(mon.id, run))
          if (mon.alertOnFail) await fireMonitorAlert(mon, run)
          return
        }
      }
      session = test.storageState || undefined
    } catch (e) {
      const run = {
        at: new Date().toISOString(),
        status: 'error' as const,
        detail: e instanceof Error ? e.message : String(e)
      }
      setMonitors(await window.api.monitors.recordRun(mon.id, run))
      if (mon.alertOnFail) await fireMonitorAlert(mon, run)
      return
    }
    let run: { at: string; status: 'passed' | 'failed' | 'error'; detail?: string } = {
      at: new Date().toISOString(),
      status: 'error'
    }
    let attempts = 0
    for (let a = 0; a < MONITOR_MAX_ATTEMPTS; a++) {
      attempts = a + 1
      const at = new Date().toISOString()
      try {
        const res = await window.api.xbrowser.run(code, ['chromium'], envVars, session)
        if (!res.installed) {
          run = { at, status: 'error', detail: 'Playwright is not installed — monitor runs need it.' }
          break
        }
        if (!res.ran) {
          run = { at, status: 'error', detail: res.message || 'The run did not start.' }
          break
        }
        const bad = res.results.find((r) => !r.ok)
        if (!bad) {
          run = {
            at,
            status: 'passed',
            detail: a > 0 ? `Passed on attempt ${a + 1} — a transient blip cleared.` : undefined
          }
          break
        }
        run = { at, status: 'failed', detail: bad.error || bad.failingTest || 'A step failed.' }
        // fall through to retry
      } catch (e) {
        run = { at, status: 'error', detail: e instanceof Error ? e.message : String(e) }
        break
      }
    }
    if (run.status === 'failed' && attempts > 1) {
      run = { ...run, detail: `${run.detail || 'A step failed.'} (failed all ${attempts} attempts)` }
    }
    setMonitors(await window.api.monitors.recordRun(mon.id, run))
    if (run.status !== 'passed' && mon.alertOnFail) await fireMonitorAlert(mon, run)
  }

  // F32: run EVERY monitor once, in order — a one-click "are they all still
  // green?" check so you never have to click each row. Sequential (runMonitorNow
  // self-guards), so headless runs never overlap.
  const runAllMonitorsNow = async (): Promise<void> => {
    for (const m of monitors) await runMonitorNow(m)
  }

  // F23: crawl the app from the current page, then overlay which discovered pages
  // the saved tests actually visit (navigate) or verify (url-contains assert).
  const handleCoverageCrawl = async (): Promise<void> => {
    setCoverageOpen(true)
    setCoverageRun({
      running: true,
      found: 0,
      result: null,
      coveredExact: new Set(),
      coveredContains: []
    })
    const off = window.api.coverage.onProgress(({ found }) =>
      setCoverageRun((prev) => (prev ? { ...prev, found } : prev))
    )
    try {
      // What the saved tests cover: paths they navigate to + url-contains checks.
      const coveredExact = new Set<string>()
      const coveredContains: { value: string; origins: string[] }[] = []
      for (const t of savedTests) {
        const test = await window.api.library.load(t.fileName)
        if (!test) continue
        // Which site(s) this test drives — the origins of its navigations. A
        // url-contains assert is credited only when the crawl is on one of these,
        // so an assertion written for site A can't cover site B's pages.
        const testOrigins = new Set<string>()
        for (const s of test.steps) {
          if (s.type === 'navigate' && s.url) {
            try {
              testOrigins.add(new URL(s.url).origin)
            } catch {
              /* skip a malformed url */
            }
          }
        }
        for (const s of test.steps) {
          if (s.type === 'navigate' && s.url) {
            try {
              // origin + path (not path alone): a test on ANOTHER site that
              // happens to share a path (e.g. /login) must NOT mark this site's
              // page as covered — that false green was hiding real gaps.
              const u = new URL(s.url)
              coveredExact.add(u.origin + normCovPath(u.pathname))
            } catch {
              /* skip a malformed url */
            }
          } else if (s.type === 'assert' && s.assertKind === 'url-contains' && s.value) {
            coveredContains.push({ value: s.value, origins: [...testOrigins] })
          }
        }
      }
      const result = await window.api.coverage.crawl()
      setCoverageRun({ running: false, found: result.pages.length, result, coveredExact, coveredContains })
    } catch {
      setCoverageRun({
        running: false,
        found: 0,
        result: null,
        coveredExact: new Set(),
        coveredContains: []
      })
    } finally {
      off()
    }
  }

  // The scheduler: every 30s, run the FIRST monitor that's due (enabled + its
  // interval has elapsed since lastRunAt). One at a time — the busy-guard stops a
  // slow headless run from overlapping the next tick. HONEST LIMIT: this only
  // fires while the app is open. Skips while the user is mid-record/replay/pick so
  // a background run can't fight their foreground work.
  useEffect(() => {
    const tick = async (): Promise<void> => {
      // `isReplaying` is only true DURING each individual runOnce(), and a batch
      // clears it between iterations — so a 30-second tick landing in that gap
      // used to start a headless monitor run in the middle of a Run All. Guard on
      // the whole batch, not just the single replay inside it.
      //
      // EVERY batch kind, not only the suite. The original fix covered `suiteRun`
      // and left the other three long-running batches exposed to the identical
      // race: a data-driven run (one runOnce per ROW), a locales run (one per
      // LOCALE) and an edge-case explosion (one per VARIANT) all clear
      // `isReplaying` between iterations exactly the same way. Same bug, three
      // more doors. (`parallelRunning` is derived from `suiteRun`, kept for
      // readability.)
      if (
        monitorBusyRef.current ||
        isRecording ||
        isReplaying ||
        isPicking ||
        suiteRun?.running ||
        parallelRunning ||
        dataRun?.running ||
        localeRun?.running ||
        edgeRun?.running
      )
        return
      const now = Date.now()
      const due = monitors.find(
        (m) =>
          m.enabled &&
          (!m.lastRunAt || now - new Date(m.lastRunAt).getTime() >= m.intervalMin * 60000)
      )
      if (due) await runMonitorNow(due) // self-guards + drives the spinner
    }
    const id = window.setInterval(tick, 30000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Every guarded flag belongs here too, or the effect keeps a stale closure
    // and the tick reads the value from when it was last created.
  }, [
    monitors,
    isRecording,
    isReplaying,
    isPicking,
    suiteRun?.running,
    parallelRunning,
    dataRun?.running,
    localeRun?.running,
    edgeRun?.running
  ])

  // Save a 1-based range of the current steps as a named block (default: all).
  // The range is FLATTENED first (any linked block inside it becomes its steps)
  // so a saved block is always plain steps — no nested references to resolve.
  // Clearing the cache makes every linked test re-read the block (live update).
  const handleSaveBlock = async (): Promise<void> => {
    const name = blockNameInput.trim()
    if (!name || steps.length === 0) return
    const from = Math.max(1, Math.min(blockFrom, steps.length))
    const to = Math.max(from, Math.min(blockTo, steps.length))
    const flat = await expandForRun(steps.slice(from - 1, to))
    await window.api.blocks.save({ name, steps: flat })
    setBlockCache({}) // linked tests re-read the block on next render/run
    setBlockNameInput('')
    const wasEditing = editingBlockRef !== null
    setEditingBlockRef(null)
    await refreshBlocks()
    // If this was an EDIT detour, bring the user's own test back and close the
    // panel — updating a block must never leave their recording behind.
    if (wasEditing && stashedSteps !== null) {
      editSteps(stashedSteps)
      setStashedSteps(null)
      setBlocksPanelOpen(false)
    }
  }
  // Close the blocks panel, restoring the user's stashed test if they were mid
  // block-edit — so cancelling a block edit is as safe as finishing one.
  const closeBlocksPanel = (): void => {
    if (stashedSteps !== null) {
      editSteps(stashedSteps)
      setStashedSteps(null)
    }
    setEditingBlockRef(null)
    setBlockNameInput('')
    setBlocksPanelOpen(false)
  }
  // Insert a saved block as a LIVE reference (one `block` step). Editing the
  // block later updates this test automatically. `⧉ Copy` (below) inlines a
  // snapshot instead.
  const handleInsertBlockLinked = async (block: BlockSummary): Promise<void> => {
    const at = blockInsertAt ?? steps.length
    const ref: RecorderStep = { type: 'block', blockRef: block.fileName, label: block.name }
    editSteps([...steps.slice(0, at), ref, ...steps.slice(at)])
    setStashedSteps(null) // inserting is a deliberate edit — drop any edit-detour stash
    setBlocksPanelOpen(false)
  }
  // Insert a COPY of the block's steps (copy-in snapshot — no live link).
  const handleInsertBlock = async (fileName: string): Promise<void> => {
    const block = await window.api.blocks.load(fileName)
    if (!block || !block.steps.length) return
    const at = blockInsertAt ?? steps.length
    editSteps([...steps.slice(0, at), ...(block.steps as RecorderStep[]), ...steps.slice(at)])
    setStashedSteps(null) // inserting is a deliberate edit — drop any edit-detour stash
    setBlocksPanelOpen(false)
  }
  // Edit a block: load its steps into the editor and open the panel primed to
  // SAVE back to it (same name overwrites). Re-saving updates every test that
  // links the block — "fix once, updates everywhere."
  const handleEditBlock = async (block: BlockSummary): Promise<void> => {
    const b = await window.api.blocks.load(block.fileName)
    if (!b) return
    // Stash the user's current test so this edit is a NON-destructive detour —
    // it's restored when they finish or cancel. Don't overwrite an existing
    // stash if they're already mid-edit of another block.
    if (editingBlockRef === null) setStashedSteps(steps)
    editSteps(b.steps as RecorderStep[])
    setEditingBlockRef(block.fileName)
    setBlockNameInput(block.name)
    setBlockFrom(1)
    setBlockTo(b.steps.length)
    setBlockInsertAt(null)
    setBlocksPanelOpen(true)
    refreshBlocks()
  }
  const handleDeleteBlock = async (fileName: string): Promise<void> => {
    setPendingDeleteBlock(null)
    await window.api.blocks.delete(fileName)
    setBlockCache({})
    await refreshBlocks()
  }
  // First ✕ click arms the delete; a second click within 3s confirms it. The
  // timeout auto-disarms so a forgotten arm can't delete a block much later.
  const armOrDeleteBlock = (fileName: string): void => {
    if (pendingDeleteBlock === fileName) {
      handleDeleteBlock(fileName)
      return
    }
    setPendingDeleteBlock(fileName)
    // F7: longer arm window (6s) so there's time to read the blast-radius banner
    // that appears listing the tests this delete would break, before confirming.
    setTimeout(() => {
      setPendingDeleteBlock((cur) => (cur === fileName ? null : cur))
    }, 6000)
  }
  // Load any linked block's steps into the cache (for display + data columns).
  // Runs when the step list or cache changes; the "missing" guard stops it after
  // one pass (and re-fills after a cache clear following a block edit).
  useEffect(() => {
    const refs = [
      ...new Set(
        steps.filter((s) => s.type === 'block' && s.blockRef).map((s) => s.blockRef as string)
      )
    ]
    const missing = refs.filter((r) => !(r in blockCache))
    if (missing.length === 0) return
    Promise.all(
      missing.map((r) =>
        window.api.blocks.load(r).then((b) => [r, (b?.steps ?? []) as RecorderStep[]] as const)
      )
    ).then((pairs) => {
      setBlockCache((prev) => {
        const next = { ...prev }
        for (const [r, s] of pairs) next[r] = s
        return next
      })
    })
  }, [steps, blockCache])

  // Switching check type re-prefills the expected value from the element's
  // live state (its text for text checks, its value for the value check).
  const handleChooseKind = (kind: AssertKind): void => {
    setAssertKind(kind)
    if (!pickedElement) return
    if (kind === 'value') setAssertValue(pickedElement.inputValue ?? '')
    else if (kind === 'text-equals' || kind === 'text-contains') {
      setAssertValue(pickedElement.text ?? '')
    } else if (kind === 'count') {
      // How many elements the primary selector matched at pick time.
      setAssertValue(String(pickedElement.groupCount ?? 1))
    } else if (kind === 'attribute' || kind === 'class') {
      // No live prefill for these — clear the stale text prefill so the user
      // isn't asserting the element's text as an attribute value by accident.
      setAssertValue('')
    }
  }

  // === Day 11: PAGE-level checks (no element to pick) =================
  // Offered as shortcuts inside the picking banner: they end pick mode and
  // insert directly at the position picking was started for.

  // URL check, prefilled with the current page's PATH — the stable, meaningful
  // part (the full URL would make "contains" behave like "equals").
  const handleAddUrlCheck = async (): Promise<void> => {
    await handleCancelPick()
    let prefill = urlInput
    try {
      const u = new URL(urlInput)
      prefill = u.pathname !== '/' ? u.pathname : u.host
    } catch {
      // not a parseable URL — keep the raw text, the user can edit it
    }
    insertStep({ type: 'assert', assertKind: 'url-contains', value: prefill }, insertAt)
    setInsertAt(null)
  }

  // Title check, prefilled with the live page title (only main can read it —
  // the title lives inside the native browser view).
  const handleAddTitleCheck = async (): Promise<void> => {
    await handleCancelPick()
    const info = await window.api.browser.getPageInfo()
    insertStep({ type: 'assert', assertKind: 'title', value: info.title }, insertAt)
    setInsertAt(null)
  }

  // F19: AI (plain-English) check — verify an outcome described in words, judged
  // by the LLM at replay time. The claim IS the assertion (no element, no fixed
  // matcher); it's editable inline afterward like any other check value.
  const handleAddNlCheck = async (): Promise<void> => {
    const claim = nlClaim.trim()
    if (!claim) return
    await handleCancelPick()
    insertStep({ type: 'assert', assertKind: 'nl', value: claim }, insertAt)
    setNlClaim('')
    setInsertAt(null)
  }

  const handleAddAssert = (): void => {
    if (!pickedElement) return
    // An attribute check without an attribute name can never pass — hold the
    // panel open until one is entered.
    if (assertKind === 'attribute' && !assertAttr.trim()) return
    insertStep(
      {
        type: 'assert',
        assertKind,
        label: pickedElement.label,
        selector: pickedElement.selector,
        candidates: pickedElement.candidates,
        value: assertNeedsValue(assertKind) ? assertValue : undefined,
        attrName: assertKind === 'attribute' ? assertAttr.trim() : undefined,
        // Day 15: assert in the same frame the element was picked from.
        frame: pickedElement.frame
      },
      insertAt
    )
    setPickedElement(null)
    setInsertAt(null)
  }

  // F3 (smart waits): insert a fixed pause, or a CONDITION wait (network idle /
  // text appears) that replaces a guessy sleep with a precise wait.
  const handleAddWait = (
    at: number | null,
    kind: 'time' | 'network-idle' | 'text' | 'manual' = 'time'
  ): void => {
    setInsertMenuIndex(null)
    if (kind === 'network-idle') insertStep({ type: 'wait', waitKind: 'network-idle' }, at)
    else if (kind === 'text') insertStep({ type: 'wait', waitKind: 'text', value: '' }, at)
    // F30: a human gate (2FA/CAPTCHA/manual check) — pauses replay until you continue.
    else if (kind === 'manual')
      insertStep(
        { type: 'wait', waitKind: 'manual', value: 'Complete the manual step, then Continue.' },
        at
      )
    else insertStep({ type: 'wait', waitKind: 'time', value: '2' }, at)
  }

  // === F37: loops + branching =======================================
  // Both handlers insert a matched PAIR of markers in one go. That's deliberate:
  // if you could add a `repeat` on its own, the very first thing you'd have is a
  // test that refuses to run ("loop is never closed"). Inserting the pair means
  // the structure is valid at every moment, and building a loop is "add it, then
  // drag the steps you want inside" — which is also how it reads.
  const handleAddRepeat = (at: number | null, kind: 'times' | 'each'): void => {
    setInsertMenuIndex(null)
    const i = at ?? steps.length
    const open: RecorderStep =
      kind === 'each'
        ? { type: 'repeat', repeatKind: 'each', label: '' }
        : { type: 'repeat', repeatKind: 'times', value: '2' }
    const close: RecorderStep = { type: 'endRepeat' }
    editSteps([...steps.slice(0, i), open, close, ...steps.slice(i)])
    // A for-each has no element yet — send the user straight into the picker,
    // because an unpicked for-each loop iterates zero times and would look
    // broken rather than unfinished.
    if (kind === 'each') handleStartPickFor(i)
  }

  const handleAddIf = (at: number | null): void => {
    setInsertMenuIndex(null)
    const i = at ?? steps.length
    editSteps([
      ...steps.slice(0, i),
      { type: 'if', condKind: 'element-visible', label: '' } as RecorderStep,
      { type: 'else' } as RecorderStep,
      { type: 'endIf' } as RecorderStep,
      ...steps.slice(i)
    ])
    handleStartPickFor(i)
  }

  // F24: insert an API-request step and immediately open its editor (an api step
  // has several fields — endpoint, method, headers, body, expected response — so
  // it needs a form, not an inline value like a wait).
  const handleAddApiStep = (at: number | null): void => {
    setInsertMenuIndex(null)
    const idx = at ?? steps.length
    const step: RecorderStep = { type: 'api', apiMethod: 'GET', url: '', apiExpectStatus: '' }
    insertStep(step, at)
    setApiDraft({ ...step })
    setApiEditIndex(idx)
  }

  // Open the editor on an existing api step (clicking its row).
  const openApiEditor = (i: number): void => {
    setApiDraft({ ...steps[i] })
    setApiEditIndex(i)
  }

  const patchApiDraft = (patch: Partial<RecorderStep>): void => {
    setApiDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  // Just put the form away. Used by Save, which has ALREADY committed the step —
  // it must not go anywhere near the discard path below.
  const dismissApiEditor = (): void => {
    setApiEditIndex(null)
    setApiDraft(null)
  }

  // Cancel / ✕ / backdrop-click. handleAddApiStep inserts the row BEFORE opening the
  // form (the editor edits a real step, not a phantom). So backing out used to strand
  // an api step with no URL: it failed every replay with "API step has no URL", and
  // exported as `await request.get("")`. Backing out of the form backs out of the step.
  const closeApiEditor = (): void => {
    if (apiEditIndex !== null) {
      const s = steps[apiEditIndex]
      if (s && s.type === 'api' && !(s.url ?? '').trim()) {
        editSteps(steps.filter((_, i) => i !== apiEditIndex))
      }
    }
    dismissApiEditor()
  }

  const saveApiEditor = (): void => {
    if (apiEditIndex === null || !apiDraft) return
    editSteps(steps.map((s, idx) => (idx === apiEditIndex ? apiDraft : s)))
    // NOT closeApiEditor(). `steps` here is still the PRE-save array (editSteps queues
    // a React state update; it does not apply it synchronously), so the discard path
    // would look at the phantom's empty URL and delete the step we just saved.
    dismissApiEditor()
  }

  // F18: turn the typed intent into draft steps grounded to the current page,
  // then APPEND them for review (the user verifies by replaying / re-picking).
  const handleGenerateAiSteps = async (): Promise<void> => {
    const intent = aiPromptText.trim()
    if (!intent) return
    // Close the modal FIRST. Generation has to show the native browser to read the
    // page's elements, and the browser draws over any HTML modal — leaving it open
    // made it flash under the browser. With the modal gone the read is clean, and a
    // top-right toast (safe over the pane) reports progress/result.
    setAiPromptOpen(false)
    setAiPromptText('')
    setAiPromptNote('')
    setAiToast({ tone: 'progress', msg: '🪄 Generating steps…' })
    try {
      const res = await window.api.ai.generateSteps(intent)
      if (res === null) {
        setAiToast({
          tone: 'fail',
          msg: '⚠ The AI is unavailable (needs the Claude CLI). Try again, or add steps manually.'
        })
      } else if (res.steps.length) {
        editSteps([...stepsRef.current, ...(res.steps as RecorderStep[])])
        setAiToast({
          tone: 'ok',
          msg: `✓ Added ${res.steps.length} step${res.steps.length === 1 ? '' : 's'}. Review + Replay to verify.${res.note ? ' ' + res.note : ''}`
        })
      } else {
        setAiToast({ tone: 'warn', msg: res.note || 'The AI produced no steps for this page.' })
      }
    } finally {
      window.setTimeout(() => setAiToast(null), 6000)
    }
  }

  // F21: reproduce a bug from its plain-English repro steps (AI, grounded to the page
  // like F18), then append a plain-English assertion of the EXPECTED behaviour — so
  // the test FAILS before the fix (assertion red) and PASSES after. Same modal-close-
  // first + toast pattern as F18 (the browser draws over any HTML modal while we read).
  const handleGenerateRegressionTest = async (): Promise<void> => {
    const repro = bugReproText.trim()
    if (!repro) return
    const expected = bugExpectedText.trim()
    setBugPromptOpen(false)
    setBugReproText('')
    setBugExpectedText('')
    setAiToast({ tone: 'progress', msg: '🐛 Building a check for this page…' })
    try {
      const res = await window.api.ai.generateRegressionTest(repro, expected)
      if (res === null) {
        setAiToast({
          tone: 'fail',
          msg: '⚠ The AI is unavailable (needs the Claude CLI). Try again, or add steps manually.'
        })
      } else if (res.steps.length) {
        editSteps([...stepsRef.current, ...(res.steps as RecorderStep[])])
        setAiToast({
          tone: 'ok',
          msg: `✓ Added ${res.steps.length} step${res.steps.length === 1 ? '' : 's'} (repro + a check). Review + Replay to verify.${res.note ? ' ' + res.note : ''}`
        })
      } else {
        setAiToast({ tone: 'warn', msg: res.note || 'The AI produced no steps for this page.' })
      }
    } finally {
      window.setTimeout(() => setAiToast(null), 7000)
    }
  }

  // F22: pick a local git repo and load its diff as extra context for the draft.
  const handleLoadDiff = async (): Promise<void> => {
    const res = await window.api.repo.pickDiff()
    if (!res) return // user cancelled the folder picker
    if (!res.ok) {
      setDraftDiff(null)
      setDraftNote(`⚠ ${res.note}`)
      return
    }
    setDraftDiff({ text: res.diff, summary: res.summary })
    setDraftNote(`✓ Loaded diff from ${res.summary} — it’ll steer the draft.`)
  }

  // F22: turn the story (+ any loaded diff) into a draft test, shown for review.
  // Unlike F18/F21 there's no page to read, so the modal STAYS open and renders the
  // draft; the user reviews it and clicks Insert. baseUrl = the address bar, so a
  // bare navigate path like "/inventory" becomes a full URL.
  const handleGenerateDraft = async (): Promise<void> => {
    const story = draftStory.trim()
    if (!story && !draftDiff) return
    setDraftBusy(true)
    setDraftNote('')
    setDraftResult(null)
    try {
      const res = await window.api.ai.draftFromStory(story, draftDiff?.text, urlInput || undefined)
      if (res === null) {
        setDraftNote('⚠ The AI is unavailable (needs the Claude CLI). Try again.')
      } else if (res.steps.length) {
        setDraftResult({
          title: res.title,
          steps: res.steps as RecorderStep[],
          guessed: res.guessed ?? []
        })
        setDraftNote(
          res.note ? `⚠ ${res.note}` : `✓ Drafted ${res.steps.length} steps — review, then Insert.`
        )
      } else {
        setDraftNote(`⚠ ${res.note || 'The AI produced no draft for that story.'}`)
      }
    } finally {
      setDraftBusy(false)
    }
  }

  // F22: append the reviewed draft to the current test, and adopt its title if the
  // test is still unnamed. Manual (⏸) steps are the ones to ground by recording over.
  const handleInsertDraft = (): void => {
    if (!draftResult) return
    const n = draftResult.steps.length
    editSteps([...stepsRef.current, ...draftResult.steps])
    if (draftResult.title && !testName.trim()) setTestName(draftResult.title)
    setDraftOpen(false)
    setDraftStory('')
    setDraftDiff(null)
    setDraftResult(null)
    setDraftNote('')
    setAiToast({
      tone: 'ok',
      msg: `✓ Inserted ${n} draft step${n === 1 ? '' : 's'}. Ground the ⏸ actions (record over them), then Replay.`
    })
    window.setTimeout(() => setAiToast(null), 7000)
  }

  // F35 (Mock Studio): pull the mockable API responses from the last capture and
  // open the studio. Nothing captured → a hint that tells you how to get some.
  const openMockStudio = async (): Promise<void> => {
    const res = await window.api.har.mockList()
    setMockEntries(res.entries)
    setMockSel(null)
    setMockStatus('200')
    setMockBody('')
    setMockCopied(false)
    setMockNote(
      res.available && res.entries.length
        ? ''
        : '⚠ No mockable API responses captured. Record a flow with 🌐 Net capture ON, then open Mock Studio.'
    )
    setMockOpen(true)
  }
  // Load a captured response into the editor (its real status + body as the start).
  const selectMock = (i: number): void => {
    const e = mockEntries[i]
    if (!e) return
    setMockSel(i)
    setMockStatus(String(e.status))
    setMockBody(e.body)
    setMockNote(
      e.bodyTruncated
        ? '⚠ This body was very large and is truncated — the mock uses the shown text.'
        : ''
    )
  }
  // Build the Playwright route/fulfill for the edited scenario. Pure — recomputed
  // live as you edit the status/body, so the snippet always matches the editor.
  const mockSnippet = (): string => {
    if (mockSel == null) return ''
    const e = mockEntries[mockSel]
    if (!e) return ''
    let pattern = e.url
    try {
      const u = new URL(e.url)
      pattern = '**' + u.pathname + '**' // path-based glob; ignores cache-busting query
    } catch {
      /* keep the raw url */
    }
    const ct = e.mimeType || 'application/json'
    const status = Number(mockStatus) || 200
    const method = e.method.toUpperCase()
    return [
      `// Mock: ${method} ${e.url}`,
      `await page.route('${pattern}', async (route) => {`,
      // Only fulfil the intended verb; let other methods on the same path pass.
      method !== 'GET' ? `  if (route.request().method() !== '${method}') return route.fallback()` : null,
      `  await route.fulfill({`,
      `    status: ${status},`,
      `    contentType: ${JSON.stringify(ct)},`,
      `    body: ${JSON.stringify(mockBody)}`,
      `  })`,
      `})`
    ]
      .filter(Boolean)
      .join('\n')
  }
  const copyMockSnippet = (): void => {
    const s = mockSnippet()
    if (!s) return
    navigator.clipboard.writeText(s).catch(() => {})
    // Confirm ON the button so the feedback is where the click is, not below the fold.
    setMockCopied(true)
    window.setTimeout(() => setMockCopied(false), 2000)
  }

  // F15: open the visual-snapshot editor (mask regions + freeze animations).
  const openSnapEditor = (i: number): void => {
    setSnapDraft({ ...steps[i] })
    setSnapEditIndex(i)
    setSnapStatus('')
  }
  const patchSnapDraft = (patch: Partial<RecorderStep>): void => {
    setSnapDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }
  const closeSnapEditor = (): void => {
    setSnapEditIndex(null)
    setSnapDraft(null)
    setSnapStatus('')
  }
  // Commit the mask/freeze/threshold to the step AND re-capture the baseline with
  // those settings — otherwise a masked compare would differ against an unmasked
  // baseline. Re-capture uses the CURRENT page, so the user must be on it.
  const saveSnapEditor = async (): Promise<void> => {
    if (snapEditIndex === null || !snapDraft) return
    const { baselineId, maskSelectors, freezeAnimations } = snapDraft
    editSteps(steps.map((s, idx) => (idx === snapEditIndex ? snapDraft : s)))
    // Close the modal FIRST. The re-capture has to show the native browser to
    // photograph the page, and the browser draws over any HTML modal — leaving the
    // modal open made it flash under the browser and back. With the modal gone the
    // re-capture reads as "taking the photo", and a top-right toast reports it.
    closeSnapEditor()
    if (!baselineId) return
    setSnapToast('busy')
    const ok = await window.api.visual.recaptureBaseline(baselineId, maskSelectors, freezeAnimations)
    setSnapToast(ok ? 'ok' : 'fail')
    window.setTimeout(() => setSnapToast(null), 3200)
  }

  const handleStartEdit = async (i: number): Promise<void> => {
    // Day 16(+): an upload step isn't text-editable — its "value" is a file
    // path. The ✎ instead opens an OS file picker; the chosen file is copied
    // into the library and swapped into the step (label = the new filename).
    if (steps[i].type === 'upload') {
      const newPath = await window.api.recorder.pickUploadFile()
      if (!newPath) return
      const name = newPath.split(/[\\/]/).pop() ?? 'file'
      editSteps(steps.map((s, idx) => (idx === i ? { ...s, value: newPath, label: name } : s)))
      return
    }
    const current = editableValue(steps[i])
    if (current === null) return
    setEditValue(current)
    setEditingIndex(i)
  }

  const handleCommitEdit = (): void => {
    if (editingIndex === null) return
    const i = editingIndex
    editSteps(
      steps.map((s, idx) =>
        idx !== i
          ? s
          : s.type === 'navigate'
            ? { ...s, url: editValue }
            : { ...s, value: editValue }
      )
    )
  }

  // A one-line summary of the last/current replay for the status banner.
  // While PAUSED for recovery (Day 12), the recovery panel carries the story.
  const replayBanner = ((): { tone: string; text: string } | null => {
    if (recovery) return null
    if (isReplaying) {
      // Name the wait. This step is judging its whole run of AI checks in one
      // model call — the steps after it then return instantly — so a ~10s pause
      // here is work, not a hang.
      if (nlBatchCount && nlBatchCount > 1) {
        return {
          tone: 'running',
          text: `Replaying… judging ${nlBatchCount} AI checks together in one call (the next ${nlBatchCount - 1} return instantly)`
        }
      }
      return { tone: 'running', text: 'Replaying…' }
    }
    if (failedIndex !== null) {
      // Day 20: Continue can leave SEVERAL failed steps — name them all.
      if (lastFailures.length > 1) {
        return {
          tone: 'failed',
          text: `✗ Failed at steps ${lastFailures.map((f) => f.index + 1).join(', ')}`
        }
      }
      return { tone: 'failed', text: `✗ Failed at step ${failedIndex + 1}: ${replayError}` }
    }
    // A run can fail BEFORE any step runs — F37 refuses a broken loop/if
    // structure up front, so there's no step to point at. Without this branch
    // the error is stored and never shown, and pressing Replay looks like it
    // did nothing.
    if (replayError) return { tone: 'failed', text: `✗ ${replayError}` }
    if (doneIndices.size > 0 && doneIndices.size + skippedIndices.size === enabledCount) {
      return skippedIndices.size > 0
        ? {
            tone: 'passed',
            text: `✓ Finished: ${doneIndices.size} passed, ${skippedIndices.size} skipped`
          }
        : { tone: 'passed', text: `✓ All ${enabledCount} steps passed` }
    }
    return null
  })()

  // F25: the environment manager is opened from BOTH the library (welcome
  // screen) and the workspace test-bar chip — which live in two SEPARATE
  // returns. Build the modal once here and render {envManagerModal} in each, so
  // it appears no matter which screen you're on. (Its setOverlay handling is in
  // the effect above; on the welcome screen there's no native pane to hide.)
  const envManagerModal = envManagerOpen && (
    <div
      className="modal-backdrop"
      onClick={() => {
        setEnvManagerOpen(false)
        setEnvDraft(null)
      }}
    >
      <div className="env-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            🌐 Environments
            {envDraft && ` · ${envDraft.name || 'new environment'}`}
          </span>
          <button
            className="modal-close"
            onClick={() => {
              setEnvManagerOpen(false)
              setEnvDraft(null)
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {envDraft ? (
          // --- Edit one environment ---
          <div className="env-edit">
            <label className="env-field">
              <span className="env-field-label">Name</span>
              <input
                className="env-field-input"
                value={envDraft.name}
                placeholder="e.g. Staging"
                onChange={(e) => setEnvDraft({ ...envDraft, name: e.target.value })}
                autoFocus
                spellCheck={false}
              />
            </label>
            <label className="env-field">
              <span className="env-field-label">Base URL</span>
              <input
                className="env-field-input"
                value={envDraft.baseURL}
                placeholder="https://staging.example.com"
                onChange={(e) => setEnvDraft({ ...envDraft, baseURL: e.target.value })}
                spellCheck={false}
              />
            </label>
            <div className="env-field-help">
              At run time, every navigation recorded under a test&rsquo;s own base URL is
              re-pointed here &mdash; the saved test is never changed.
            </div>

            <div className="env-vars">
              <div className="env-vars-head">
                <span className="env-field-label">Variables</span>
                <span className="env-vars-hint">
                  Referenced in steps as <code>{'{{env:NAME}}'}</code> &mdash; e.g. a login
                  field. Each environment supplies its own values.
                </span>
              </div>
              {envDraft.vars.length === 0 && <div className="env-vars-empty">No variables yet.</div>}
              {envDraft.vars.map((v, vi) => (
                <div key={vi} className="env-var-row">
                  <input
                    className="env-var-name"
                    value={v.name}
                    placeholder="NAME"
                    onChange={(e) =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.map((x, i) =>
                          i === vi ? { ...x, name: e.target.value } : x
                        )
                      })
                    }
                    spellCheck={false}
                  />
                  <input
                    className="env-var-value"
                    type={v.secret ? 'password' : 'text'}
                    value={v.value}
                    placeholder="value"
                    onChange={(e) =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.map((x, i) =>
                          i === vi ? { ...x, value: e.target.value } : x
                        )
                      })
                    }
                    spellCheck={false}
                  />
                  <label
                    className="env-var-secret"
                    title="Mask this value on screen (a password)"
                  >
                    <input
                      type="checkbox"
                      checked={!!v.secret}
                      onChange={(e) =>
                        setEnvDraft({
                          ...envDraft,
                          vars: envDraft.vars.map((x, i) =>
                            i === vi ? { ...x, secret: e.target.checked } : x
                          )
                        })
                      }
                    />
                    secret
                  </label>
                  <button
                    type="button"
                    className="env-var-remove"
                    aria-label="Remove variable"
                    onClick={() =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.filter((_, i) => i !== vi)
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="env-add-var"
                onClick={() =>
                  setEnvDraft({
                    ...envDraft,
                    vars: [...envDraft.vars, { name: '', value: '' }]
                  })
                }
              >
                + Add variable
              </button>
            </div>

            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setEnvDraft(null)}>
                Cancel
              </button>
              <button
                className="modal-btn primary"
                disabled={!envDraft.name.trim()}
                onClick={async () => {
                  // Drop half-typed variable rows (no name) before saving.
                  const clean: Environment = {
                    ...envDraft,
                    name: envDraft.name.trim(),
                    baseURL: envDraft.baseURL.trim().replace(/\/+$/, ''),
                    vars: envDraft.vars.filter((v) => v.name.trim())
                  }
                  await saveEnv(clean)
                  setEnvDraft(null)
                }}
              >
                Save environment
              </button>
            </div>
          </div>
        ) : (
          // --- List of environments ---
          <div className="env-list">
            <p className="env-list-intro">
              Define your dev / staging / prod environments once, then run any test &mdash; or the
              whole suite &mdash; against any of them. The active environment re-points navigations
              and fills <code>{'{{env:NAME}}'}</code> credentials.
            </p>
            {envState.environments.length === 0 ? (
              <div className="env-empty">No environments yet &mdash; add your first.</div>
            ) : (
              <ul className="env-items">
                {envState.environments.map((env) => (
                  <li
                    key={env.id}
                    className={`env-item${env.id === envState.activeId ? ' active' : ''}`}
                  >
                    <label className="env-item-pick" title="Make this the active environment">
                      <input
                        type="radio"
                        name="active-env"
                        checked={env.id === envState.activeId}
                        onChange={() => setActiveEnv(env.id)}
                      />
                      <span className="env-item-name">{env.name}</span>
                    </label>
                    <span className="env-item-base">{env.baseURL || 'no base URL'}</span>
                    <span className="env-item-vars">
                      {env.vars.length} var{env.vars.length === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="env-item-btn" onClick={() => setEnvDraft(env)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="env-item-btn danger"
                      onClick={() => {
                        if (window.confirm(`Delete environment "${env.name}"?`)) deleteEnv(env.id)
                      }}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-footer">
              {/* "Don't ask again" is never a one-way door. */}
              <button
                className="modal-btn"
                onClick={() => {
                  window.api.environments.forgetRetarget().then(setEnvState)
                  setWarnsReset(true)
                  window.setTimeout(() => setWarnsReset(false), 2000)
                }}
                title="Show the host-mismatch warning again for every environment you dismissed"
              >
                {warnsReset ? '✓ Warnings reset' : 'Reset run warnings'}
              </button>
              <button
                className="modal-btn"
                onClick={() => setActiveEnv(null)}
                disabled={!envState.activeId}
                title="Run against each test's own recorded URLs"
              >
                Use recorded URLs
              </button>
              <button
                className="modal-btn primary"
                onClick={() =>
                  setEnvDraft({ id: `env-${Date.now()}`, name: '', baseURL: '', vars: [] })
                }
              >
                + Add environment
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  // F25 guard: the active environment points at a different site than the one
  // this test was recorded on. Every button settles the promise handleReplay is
  // awaiting, so the run can't proceed until a choice is made. No backdrop
  // click-to-close: dismissing without a choice would hang the run.
  // Cancel is never remembered: a stored "cancel" would make the test silently
  // unrunnable under this env, with no modal left to explain why.
  const settleEnvWarn = (choice: 'run' | 'noenv' | 'cancel'): void => {
    if (envWarn && activeEnv && envWarnRemember && choice !== 'cancel') {
      // Persist for every host pair shown — the checkbox names them all. Goes to
      // the main-process store (userData), which the per-run storage clear can't
      // touch; refresh the cached envState so the next run sees it.
      const keys = [
        ...envWarn.mismatches.map((m) => retargetWarnKey(activeEnv.id, m.from, m.to)),
        // F24: remember the API-host acknowledgements under their own keys too,
        // or the modal would re-ask for them on every run.
        ...envWarn.apiHosts.map((a) =>
          retargetWarnKey(activeEnv.id, `api:${a.host}`, activeEnv.baseURL)
        )
      ]
      window.api.environments.rememberRetarget(keys, choice).then(setEnvState)
    }
    envWarn?.resolve(choice)
    setEnvWarn(null)
    setEnvWarnRemember(false)
  }
  const envWarnModal = envWarn && (
    <div className="modal-backdrop">
      <div className="modal env-warn" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {envWarn.mismatches.length === 0
              ? '⚠ API steps bypass this environment'
              : '⚠ Environment retargets this run'}
          </span>
        </div>
        <div className="env-warn-body">
          {/* Navigations retargeted to another site (the original F25 warning). */}
          {envWarn.mismatches.length > 0 && (
            <>
              <p>
                The active environment <strong>{activeEnv?.name}</strong> re-points every navigation
                at <code className="env-warn-to">{envWarn.mismatches[0].to}</code>.{' '}
                {envWarn.mismatches.length === 1 && envWarn.mismatches[0].tests.length === 1
                  ? 'This test was recorded somewhere else.'
                  : `${envWarn.mismatches.reduce((n, m) => n + m.tests.length, 0)} test(s) in this run were recorded on ${envWarn.mismatches.length} other host(s).`}
              </p>
              <div className="env-warn-hosts">
                {envWarn.mismatches.map((m) => (
                  <div key={m.from} className="env-warn-row">
                    <code>{m.from}</code>
                    <span className="env-warn-arrow">→</span>
                    <code className="env-warn-to">{m.to}</code>
                    <span className="env-warn-count" title={m.tests.join('\n')}>
                      {m.tests.length === 1 ? m.tests[0] : `${m.tests.length} tests`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="env-warn-hint">
                If those aren’t the same app, the run will hit pages that don’t exist.
              </p>
            </>
          )}
          {/* F24: API steps calling a host the environment does NOT cover. These
              are NOT retargeted — the danger is an app's own API on a separate
              host, where a "staging" run would still write to PRODUCTION. */}
          {envWarn.apiHosts.length > 0 && (
            <>
              <p className="env-warn-api-lead">
                🔌 This run’s <strong>API steps</strong> call{' '}
                {envWarn.apiHosts.length === 1 ? 'a host' : `${envWarn.apiHosts.length} hosts`} the
                environment does <strong>not</strong> cover. Those calls are{' '}
                <strong>not retargeted</strong> — they go to the host below exactly as recorded,
                even though the rest of the run goes to {activeEnv?.name}.
              </p>
              <div className="env-warn-hosts">
                {envWarn.apiHosts.map((a) => (
                  <div key={a.host} className="env-warn-row">
                    <code className="env-warn-api">{a.host}</code>
                    <span className="env-warn-arrow">↛</span>
                    <span className="env-warn-nochange">not retargeted</span>
                    <span className="env-warn-count" title={a.tests.join('\n')}>
                      {a.tests.length === 1 ? a.tests[0] : `${a.tests.length} tests`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="env-warn-hint">
                Fine for a third-party API (Stripe, a public endpoint). But if that host is{' '}
                <strong>your own API</strong>, this run will read and write <strong>real
                production data</strong> while everything else points at {activeEnv?.name} — add it
                to the environment’s base URL, or edit the step to use a relative host.
              </p>
            </>
          )}
          <label className="env-warn-remember">
            <input
              type="checkbox"
              checked={envWarnRemember}
              onChange={(e) => setEnvWarnRemember(e.target.checked)}
            />
            <span>
              Don’t ask again for{' '}
              {envWarn.mismatches.length + envWarn.apiHosts.length === 1 ? (
                envWarn.mismatches.length === 1 ? (
                  <>
                    <code>{envWarn.mismatches[0].from}</code> →{' '}
                    <code>{envWarn.mismatches[0].to}</code>
                  </>
                ) : (
                  <code>{envWarn.apiHosts[0].host}</code>
                )
              ) : (
                <>these {envWarn.mismatches.length + envWarn.apiHosts.length} hosts</>
              )}
              <em> (these hosts only — a new one still asks)</em>
            </span>
          </label>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => settleEnvWarn('cancel')}>
            Cancel
          </button>
          <button className="modal-btn" onClick={() => settleEnvWarn('run')}>
            Run anyway
          </button>
          <button className="modal-btn primary" onClick={() => settleEnvWarn('noenv')}>
            Run without environment
          </button>
        </div>
      </div>
    </div>
  )

  // F24: the response panel — a Postman-style view of what the server actually
  // returned, for a PASSING step as much as a failing one. The point: `body
  // contains "id"` goes green on {"id": null, "status": "FAILED"}, and no amount
  // of staring at a green tick would tell you. Now you can just look.
  const statusIsOk = (status?: number): boolean =>
    status !== undefined && status >= 200 && status < 300

  // F24.2: the contract is the SHAPE of a known-good response. It is inferred in
  // MAIN (from the raw body) and arrives on the evidence as `shape` — see
  // handleCaptureContract. The renderer used to re-derive it from the truncated
  // response text, which quietly broke on any payload over 2 KB.

  // "1 field" / "3 fields". One helper, so the badge, the response panel and the
  // editor can't disagree — and so none of them says "1 fields".
  const fieldCount = (n: number): string => `${n} field${n === 1 ? '' : 's'}`

  const handleCaptureContract = (index: number): void => {
    const ev = apiResponses[index]
    if (!ev) return
    // Use the shape MAIN inferred from the raw body. Re-parsing `ev.responseBody`
    // here was a trap: that string is truncated at 2 KB, so every response bigger
    // than that failed to parse and the user got "this response isn't JSON" — for
    // a response that was perfectly good JSON.
    const contract = ev.shape
    if (!contract) {
      window.alert("This response isn't JSON, so it has no shape to contract.")
      return
    }
    if (!Object.keys(contract).length) {
      window.alert('This response has no fields to contract.')
      return
    }
    // setSteps, NOT editSteps: capturing a contract adds a field to one step — no
    // row moves, so the run's pass/fail marks and its recorded responses all still
    // describe this list. editSteps would (correctly, for a reordering edit) throw
    // them away, closing the very panel you're reading.
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, apiContract: contract } : s)))
  }

  // Pretty-print JSON so a one-line payload is actually readable; leave anything
  // that isn't JSON (HTML, plain text) exactly as it came.
  const prettyBody = (text?: string): string => {
    const raw = (text ?? '').trim()
    if (!raw) return ''
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }

  // Rendered as a MODAL, not inline in the steps column: the column is ~300px
  // wide and a JSON body wrapped into it is unreadable. A modal is the only
  // surface here that can be genuinely wide (it also hides the native browser
  // pane, which would otherwise paint straight over it — see setOverlay).
  const apiResponseStep = apiPanelIndex !== null ? steps[apiPanelIndex] : undefined
  const apiResponseEv = apiPanelIndex !== null ? apiResponses[apiPanelIndex] : undefined
  const apiResponseModal = apiPanelIndex !== null && apiResponseEv && (
    <div className="modal-backdrop" onClick={() => setApiPanelIndex(null)}>
      <div className="modal api-response-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            ↩ Response — step {apiPanelIndex + 1}
            {apiResponseStep ? ` · ${apiResponseStep.apiMethod ?? 'GET'}` : ''}
          </span>
          <button className="modal-close" onClick={() => setApiPanelIndex(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-response-body">
          <div className={`api-panel-status${statusIsOk(apiResponseEv.status) ? ' ok' : ' bad'}`}>
            {apiResponseEv.status != null
              ? apiResponseEv.status
              : 'no response — the request never reached the server'}
            {apiResponseEv.durationMs != null && (
              <span className="api-panel-meta">· {apiResponseEv.durationMs} ms</span>
            )}
            {apiResponseEv.sizeBytes != null && (
              <span className="api-panel-meta">· {formatBytes(apiResponseEv.sizeBytes)}</span>
            )}
          </div>
          <div className="api-panel-lbl">Sent</div>
          <pre className="api-panel-pre">
            {`${apiResponseEv.method} ${apiResponseEv.url}`}
            {apiResponseEv.requestHeaders ? `\n${apiResponseEv.requestHeaders}` : ''}
            {apiResponseEv.requestBody ? `\n\n${apiResponseEv.requestBody}` : ''}
          </pre>
          <div className="api-panel-lbl">Received</div>
          {apiResponseEv.responseHeaders && (
            <pre className="api-panel-pre api-panel-headers">{apiResponseEv.responseHeaders}</pre>
          )}
          <pre className="api-panel-pre">
            {prettyBody(apiResponseEv.responseBody) || '(empty body)'}
          </pre>
          <p className="api-panel-note">
            Credentials are masked (••••). Long bodies are cut at 2,000 characters — the size above
            is the real one.
          </p>
          {/* F24.2: capture the SHAPE of this known-good response as a contract.
              This is the check that catches a backend renaming `total` → `amount`:
              no value assertion can, because the field simply isn't there. */}
          {apiResponseStep?.type === 'api' && (
            <div className="api-contract-capture">
              <button
                type="button"
                className="modal-btn"
                onClick={() => handleCaptureContract(apiPanelIndex!)}
                disabled={!apiResponseEv.responseBody}
                title="Remember this response's SHAPE. Later runs fail if a field is renamed, dropped, or changes type."
              >
                📐 Save this shape as the contract
              </button>
              <span className="api-panel-note">
                {apiResponseStep.apiContract
                  ? `Contract set — ${fieldCount(Object.keys(apiResponseStep.apiContract).length)} being enforced.`
                  : 'No contract yet: a renamed or dropped field would go unnoticed.'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // F24: the API-request step editor. `request` runs in the main process, so it
  // reaches any endpoint regardless of what page the browser is on.
  const apiMethod = (apiDraft?.apiMethod ?? 'GET') as string
  const apiSendsBody = apiMethod !== 'GET' && apiMethod !== 'DELETE'
  const apiEditorModal = apiDraft && apiEditIndex !== null && (
    <div className="modal-backdrop" onClick={closeApiEditor}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🔌 API request</span>
          <button className="modal-close" onClick={closeApiEditor} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <div className="api-row api-req-line">
            <select
              className="api-method"
              value={apiMethod}
              onChange={(e) => patchApiDraft({ apiMethod: e.target.value as RecorderStep['apiMethod'] })}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="api-url"
              type="text"
              placeholder="https://api.example.com/users/1"
              value={apiDraft.url ?? ''}
              onChange={(e) => patchApiDraft({ url: e.target.value })}
            />
          </div>
          <label className="api-field">
            <span>Headers — one per line, e.g. Authorization: Bearer {'{{env:TOKEN}}'}</span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={'Content-Type: application/json\nAuthorization: Bearer …'}
              value={apiDraft.apiHeaders ?? ''}
              onChange={(e) => patchApiDraft({ apiHeaders: e.target.value })}
            />
          </label>
          {apiSendsBody && (
            <label className="api-field">
              <span>Request body</span>
              <textarea
                className="api-body"
                rows={4}
                placeholder={'{ "name": "morpheus" }'}
                value={apiDraft.apiBody ?? ''}
                onChange={(e) => patchApiDraft({ apiBody: e.target.value })}
              />
            </label>
          )}
          <div className="api-row api-expect">
            <label className="api-field api-field-inline">
              <span>Expect status</span>
              <input
                type="text"
                placeholder="2xx  ·  200  ·  204,404"
                value={apiDraft.apiExpectStatus ?? ''}
                onChange={(e) => patchApiDraft({ apiExpectStatus: e.target.value })}
              />
            </label>
            <label className="api-field api-field-inline">
              <span>Response body contains (optional)</span>
              <input
                type="text"
                placeholder='e.g. "success" or an id'
                value={apiDraft.apiExpectBody ?? ''}
                onChange={(e) => patchApiDraft({ apiExpectBody: e.target.value })}
              />
            </label>
          </div>
          {/* F24.2: REAL assertions. "Body contains" is a substring match — it
              passes on {"id": null}, which is the dead-assertion disease F6 exists
              to catch, reinvented in API form. */}
          <label className="api-field">
            <span>
              ✅ Response checks — <strong>assertions</strong>. One per line:{' '}
              <code>path op value</code>
            </span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={
                'id not-empty\nstatus equals CONFIRMED\nitems count-gt 0\nheader:content-type contains application/json'
              }
              value={apiDraft.apiChecks ?? ''}
              onChange={(e) => patchApiDraft({ apiChecks: e.target.value })}
            />
          </label>
          <p className="api-hint api-ops">
            <strong>Operators:</strong> <code>equals</code> · <code>not-equals</code> ·{' '}
            <code>contains</code> · <code>not-contains</code> · <code>exists</code> ·{' '}
            <code>not-empty</code> · <code>empty</code> · <code>gt</code> · <code>lt</code> ·{' '}
            <code>count-eq</code> · <code>count-gt</code> · <code>count-lt</code> ·{' '}
            <code>is-number</code> · <code>is-string</code> · <code>is-boolean</code> ·{' '}
            <code>is-array</code>. Prefix a path with <code>header:</code> to check a response
            header.
          </p>
          <div className="api-row api-expect">
            <label className="api-field api-field-inline">
              <span>Must respond within (ms) — SLA, blank = no limit</span>
              <input
                type="text"
                placeholder="e.g. 500"
                value={apiDraft.apiMaxMs != null ? String(apiDraft.apiMaxMs) : ''}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  patchApiDraft({ apiMaxMs: Number.isFinite(n) && n > 0 ? n : undefined })
                }}
              />
            </label>
            <label className="api-field api-field-inline">
              <span>Give up after (seconds) — default 30</span>
              <input
                type="text"
                placeholder="30"
                value={apiDraft.apiTimeoutMs != null ? String(apiDraft.apiTimeoutMs / 1000) : ''}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  patchApiDraft({
                    apiTimeoutMs: Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined
                  })
                }}
              />
            </label>
          </div>
          {/* F24.2: the contract. Captured from the response panel, shown here so
              you can see it exists and drop it. */}
          {apiDraft.apiContract && Object.keys(apiDraft.apiContract).length > 0 && (
            <div className="api-contract-row">
              <span>
                📐 <strong>Contract:</strong> {fieldCount(Object.keys(apiDraft.apiContract).length)}{' '}
                — fails if any is renamed, dropped, or changes type.
              </span>
              <button
                type="button"
                className="modal-btn"
                onClick={() => patchApiDraft({ apiContract: undefined })}
              >
                Remove
              </button>
            </div>
          )}
          {/* F24.1: the piece that makes create → verify → delete possible. The
              server invents the id, so it cannot be typed when authoring. */}
          {/* Visually separated from "Response checks" above. The two were
              adjacent, identically styled textareas with different grammars
              (`path op value` vs `name = path`), and a check typed into this one
              was silently dropped. */}
          <label className="api-field api-save-field">
            <span>
              💾 Save from response — <strong>not a check</strong>. One{' '}
              <code>name = path</code> per line, used later as <code>{'{{saved:name}}'}</code>
            </span>
            <textarea
              className="api-headers"
              rows={2}
              placeholder={'orderId = id\ntoken = data.accessToken'}
              value={apiDraft.apiSave ?? ''}
              onChange={(e) => patchApiDraft({ apiSave: e.target.value })}
            />
          </label>
          {/* Say so IMMEDIATELY. This warning exists because a dropped line cost
              a real assertion that looked saved and green for hours. */}
          {saveSpecWarning(apiDraft.apiSave) && (
            <p className="api-hint api-save-warn">⚠ {saveSpecWarning(apiDraft.apiSave)}</p>
          )}
          {/* F24.3: hand this response's auth to the browser — the suite-scale win. */}
          <div className="api-auth-block">
            <label className="api-check-line">
              <input
                type="checkbox"
                checked={!!apiDraft.apiInjectCookies}
                onChange={(e) => patchApiDraft({ apiInjectCookies: e.target.checked })}
              />
              <span>
                🔑 Log the <strong>browser</strong> in with this response’s cookies — the UI steps
                after this start already authenticated, with no login screen.
              </span>
            </label>
            <label className="api-field">
              <span>
                …or, if the API returns a <strong>token in the body</strong>: set localStorage —
                one <code>key = value</code> per line
              </span>
              <textarea
                className="api-headers"
                rows={2}
                placeholder={'authToken = {{saved:token}}'}
                value={apiDraft.apiInjectStorage ?? ''}
                onChange={(e) => patchApiDraft({ apiInjectStorage: e.target.value })}
              />
            </label>
          </div>
          <p className="api-hint">
            The request runs from the app itself (not the browser tab), so it works on any page. A
            failed status or missing body text fails the step like any check.
          </p>
          <p className="api-hint">
            <strong>Re-runnable tests:</strong> use <code>{'{{uuid}}'}</code>,{' '}
            <code>{'{{timestamp}}'}</code> or <code>{'{{randomInt}}'}</code> anywhere in the URL,
            headers or body to create data that never collides on a second run (
            <code>qa+{'{{timestamp}}'}@x.com</code>). For a teardown check, an{' '}
            <strong>Expect status</strong> of <code>204,404</code> accepts either — so “already
            gone” still passes and the test doesn’t go red forever after run 1.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeApiEditor}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={saveApiEditor}
            disabled={!(apiDraft.url ?? '').trim()}
          >
            Save step
          </button>
        </div>
      </div>
    </div>
  )

  // F15: the visual-snapshot editor — mask dynamic regions + freeze animations.
  const snapEditorModal = snapDraft && snapEditIndex !== null && (
    <div className="modal-backdrop" onClick={closeSnapEditor}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📸 Visual snapshot settings</span>
          <button className="modal-close" onClick={closeSnapEditor} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Ignore these regions (mask) — CSS selectors, one per line</span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={'.timestamp\n#carousel\n.ad-banner'}
              value={snapDraft.maskSelectors ?? ''}
              onChange={(e) => patchSnapDraft({ maskSelectors: e.target.value })}
            />
            <span className="api-hint">
              A clock, ad, or carousel that changes every run would otherwise fail the diff. Masked
              areas are painted over identically on both baseline and current, so they’re excluded.
            </span>
          </label>
          <label className="api-field api-field-inline" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={snapDraft.freezeAnimations !== false}
              onChange={(e) => patchSnapDraft({ freezeAnimations: e.target.checked })}
            />
            <span>Freeze animations &amp; transitions before capture (recommended)</span>
          </label>
          <label className="api-field api-field-inline">
            <span>Allowed difference (%)</span>
            <input
              type="text"
              placeholder="1"
              value={snapDraft.value ?? '1'}
              onChange={(e) => patchSnapDraft({ value: e.target.value })}
            />
          </label>
          <label className="api-field api-field-inline">
            <span>Also fail past N changed pixels</span>
            <input
              type="text"
              placeholder="200"
              value={snapDraft.maxDiffPixels ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                patchSnapDraft({ maxDiffPixels: Number.isFinite(n) && n >= 0 ? n : undefined })
              }}
            />
          </label>
          <p className="api-hint">
            On a big full-page snapshot, a small change (one button, a badge) can stay under the %
            bar. This also fails once more than N real pixels change — so localized regressions
            aren&apos;t diluted. Blank = 200.
          </p>
          {snapStatus && <p className="api-hint" style={{ color: '#8ab4f8' }}>{snapStatus}</p>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeSnapEditor}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={saveSnapEditor}
            title="Save these settings AND re-capture the baseline from the current page with them applied"
          >
            Save &amp; re-capture baseline
          </button>
        </div>
      </div>
    </div>
  )

  // F18: the AI-prompt step composer. Grounded to the CURRENT page's elements,
  // so it's a per-page authoring aid — the produced steps are a draft to verify.
  const aiPromptModal = aiPromptOpen && (
    <div className="modal-backdrop" onClick={() => setAiPromptOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🪄 AI step — describe what to do</span>
          <button className="modal-close" onClick={() => setAiPromptOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Plain English — what should happen on THIS page?</span>
            <textarea
              className="api-body"
              rows={3}
              placeholder={'e.g. log in as standard_user with password secret_sauce'}
              value={aiPromptText}
              onChange={(e) => setAiPromptText(e.target.value)}
              autoFocus
            />
          </label>
          <p className="api-hint">
            The AI reads the elements on the page you’re viewing and turns your intent into steps —
            grounded to real elements, so it can’t invent selectors. It sees one page at a time, so
            for a multi-page flow, generate on each page. Always review + Replay the result.
          </p>
          {aiPromptNote && (
            <p
              className="api-hint"
              style={{ color: aiPromptNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}
            >
              {aiPromptNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setAiPromptOpen(false)}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleGenerateAiSteps}
            disabled={!aiPromptText.trim()}
          >
            🪄 Generate steps
          </button>
        </div>
      </div>
    </div>
  )

  // F22: draft a whole test from a user story (+ optional local PR diff). No live
  // page, so it stays open and shows the draft for review; actions become ⏸ manual
  // steps (ground them by recording over) and checks become real ✅ AI assertions.
  const draftStepIcon = (s: RecorderStep): string =>
    s.type === 'navigate' ? '🧭' : s.type === 'assert' ? '✅' : '⏸'
  const draftStepKind = (s: RecorderStep): string =>
    s.type === 'navigate' ? 'Go to' : s.type === 'assert' ? 'Check' : 'Do (ground this)'
  const draftModal = draftOpen && (
    <div className="modal-backdrop" onClick={() => !draftBusy && setDraftOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📝 Draft a test — from a story or PR diff</span>
          <button
            className="modal-close"
            onClick={() => setDraftOpen(false)}
            disabled={draftBusy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>User story / acceptance criteria</span>
            <textarea
              className="api-body"
              rows={5}
              placeholder={
                'e.g. As a shopper I can sort products by price (low to high) on the inventory page, and the list re-orders so the cheapest item is first.'
              }
              value={draftStory}
              onChange={(e) => setDraftStory(e.target.value)}
              autoFocus
            />
          </label>
          <div className="draft-diff-row">
            <button className="modal-btn" onClick={handleLoadDiff} disabled={draftBusy}>
              📁 {draftDiff ? 'Change PR diff…' : 'Load PR diff from repo…'}
            </button>
            {draftDiff && (
              <span className="draft-diff-chip">
                {draftDiff.summary}
                <button
                  className="draft-diff-clear"
                  onClick={() => {
                    setDraftDiff(null)
                    setDraftNote('')
                  }}
                  title="Remove the diff"
                  aria-label="Remove the diff"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <p className="api-hint">
            The AI turns your story into a draft: <strong>navigations</strong> and{' '}
            <strong>✅ checks</strong> run for real; <strong>⏸ actions</strong> are plain-English
            placeholders you ground by recording over them (there’s no live page to read selectors
            from yet). Optionally point at the app’s local git repo to steer the draft from its diff.
          </p>
          {draftNote && (
            <p
              className="api-hint"
              style={{ color: draftNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}
            >
              {draftNote}
            </p>
          )}
          {draftResult && (
            <>
              <div className="ac-summary">
                Draft: <strong>{draftResult.title}</strong> · {draftResult.steps.length} steps
              </div>
              <ul className="ac-list">
                {draftResult.steps.map((s, i) => {
                  // The story named no address for this "Go to", so the URL below
                  // is our guess. Flag it here — at replay it would just look
                  // like the site is broken.
                  const guessedUrl = draftResult.guessed.includes(i)
                  return (
                    <li key={i} className="ac-row">
                      <span className="ac-mark">{guessedUrl ? '⚠' : draftStepIcon(s)}</span>
                      <span className="ac-text">
                        <strong>{draftStepKind(s)}</strong>
                        <span
                          className="mon-sub"
                          style={guessedUrl ? { color: '#f0b232' } : undefined}
                          title={
                            guessedUrl
                              ? 'The story didn’t say where to go — this address is a guess. Set it before you replay.'
                              : undefined
                          }
                        >
                          {s.type === 'navigate'
                            ? s.url || '(no address — set this before replaying)'
                            : s.value}
                          {guessedUrl && s.url ? ' — guessed' : ''}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setDraftOpen(false)} disabled={draftBusy}>
            Close
          </button>
          {draftResult ? (
            <>
              <button className="modal-btn" onClick={handleGenerateDraft} disabled={draftBusy}>
                ↻ Regenerate
              </button>
              <button className="modal-btn primary" onClick={handleInsertDraft} disabled={draftBusy}>
                ＋ Insert {draftResult.steps.length} steps
              </button>
            </>
          ) : (
            <button
              className="modal-btn primary"
              onClick={handleGenerateDraft}
              disabled={draftBusy || (!draftStory.trim() && !draftDiff)}
            >
              {draftBusy ? '✨ Drafting…' : '✨ Generate draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // F35 (Mock Studio): pick a captured API response, edit its status/body into a
  // scenario (sold-out, a 500, an empty list), and copy the Playwright route/fulfill.
  const mockModal = mockOpen && (
    <div className="modal-backdrop" onClick={() => setMockOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🎭 Mock Studio — edit a captured response into a scenario</span>
          <button className="modal-close" onClick={() => setMockOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          {!mockEntries.length ? (
            <p className="api-hint">
              {mockNote ||
                'No mockable API responses captured yet. Record a flow with 🌐 Net capture ON, then reopen Mock Studio.'}
            </p>
          ) : (
            <>
              <p className="api-hint">
                Pick a captured API call, edit its <strong>status</strong> and{' '}
                <strong>body</strong> into the scenario you want to test (sold-out, a server error,
                an empty list), then copy the Playwright mock. Paste it into your test to force that
                exact response — no backend needed.
              </p>
              <div className="ac-summary">Captured responses ({mockEntries.length})</div>
              <ul className="ac-list mock-list">
                {mockEntries.map((e, i) => (
                  <li
                    key={i}
                    className={`ac-row mock-row${mockSel === i ? ' selected' : ''}`}
                    onClick={() => selectMock(i)}
                  >
                    <span className={`mock-verb verb-${e.method.toLowerCase()}`}>{e.method}</span>
                    <span className="ac-text">
                      <strong>{(() => { try { return new URL(e.url).pathname } catch { return e.url } })()}</strong>
                      <span className="mon-sub">
                        {e.status} {e.statusText} · {e.mimeType || '—'}
                        {e.resourceType ? ` · ${e.resourceType}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {mockSel != null && mockEntries[mockSel] && (
                <div className="mock-editor">
                  <div className="mock-controls">
                    <label className="mock-status-field">
                      <span>Status</span>
                      <input
                        className="mock-status-input"
                        value={mockStatus}
                        onChange={(e) => setMockStatus(e.target.value.replace(/[^\d]/g, ''))}
                      />
                    </label>
                    <div className="mock-quick">
                      <button className="modal-btn" onClick={() => { setMockStatus('500'); setMockBody('{"error":"Internal Server Error"}') }}>
                        Force 500
                      </button>
                      <button className="modal-btn" onClick={() => { setMockStatus('404'); setMockBody('{"error":"Not Found"}') }}>
                        Force 404
                      </button>
                      <button className="modal-btn" onClick={() => setMockBody('[]')}>
                        Empty list []
                      </button>
                      <button className="modal-btn" onClick={() => { const e = mockEntries[mockSel]; setMockStatus(String(e.status)); setMockBody(e.body) }}>
                        ↺ Reset
                      </button>
                    </div>
                  </div>
                  <label className="api-field">
                    <span>Response body (edit into your scenario)</span>
                    <textarea
                      className="api-body mock-body"
                      rows={7}
                      value={mockBody}
                      onChange={(e) => setMockBody(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <div className="ac-summary">Playwright mock (paste into your test)</div>
                  <pre className="mock-snippet"><code>{mockSnippet()}</code></pre>
                </div>
              )}
            </>
          )}
          {mockNote && mockEntries.length > 0 && (
            <p className="api-hint" style={{ color: mockNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}>
              {mockNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setMockOpen(false)}>
            Close
          </button>
          {mockSel != null && (
            <button className="modal-btn primary" onClick={copyMockSnippet}>
              {mockCopied ? '✓ Copied!' : '📋 Copy Playwright mock'}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  // F34: create a Jira ticket from a failure. Pre-filled summary + the whole bug
  // report as the description. Two paths: push via API token, or copy + open
  // Jira's create page (no token). Site/email/project persist; token never stored.
  const jiraModal = jiraOpen && (
    <div className="modal-backdrop" onClick={() => !jiraBusy && setJiraOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🎫 Create a Jira ticket</span>
          <button
            className="modal-close"
            onClick={() => setJiraOpen(false)}
            disabled={jiraBusy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Summary (ticket title)</span>
            <input
              className="url-input"
              type="text"
              value={jiraSummaryText}
              onChange={(e) => setJiraSummaryText(e.target.value)}
            />
          </label>
          <label className="api-field">
            <span>Description</span>
            <textarea
              className="api-body"
              rows={8}
              value={jiraDescText}
              onChange={(e) => setJiraDescText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="api-hint">
            Push it straight to Jira with an API token, or use <strong>Copy + open Jira</strong> (no
            token — paste the ticket into Jira’s create page). Your site, email and project are
            remembered; the token is never stored.
          </p>
          <div className="jira-cred-grid">
            <label className="api-field">
              <span>Jira site URL</span>
              <input
                className="url-input"
                type="text"
                placeholder="https://yourteam.atlassian.net"
                value={jiraBaseUrl}
                onChange={(e) => setJiraBaseUrl(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>Project key</span>
              <input
                className="url-input"
                type="text"
                placeholder="QA"
                value={jiraProject}
                onChange={(e) => setJiraProject(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>Your email</span>
              <input
                className="url-input"
                type="text"
                placeholder="you@team.com"
                value={jiraEmail}
                onChange={(e) => setJiraEmail(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>
                API token <span className="mon-sub">(not stored)</span>
              </span>
              <input
                className="url-input"
                type="password"
                placeholder="Atlassian API token"
                value={jiraToken}
                onChange={(e) => setJiraToken(e.target.value)}
              />
            </label>
          </div>
          {jiraNote && (
            <p
              className="api-hint"
              style={{
                color: jiraNote.startsWith('✓')
                  ? '#7ee787'
                  : jiraNote.startsWith('⚠')
                    ? '#f0b232'
                    : '#9aa4b2'
              }}
            >
              {jiraNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setJiraOpen(false)} disabled={jiraBusy}>
            Close
          </button>
          <button className="modal-btn" onClick={handleJiraCopyOpen} disabled={jiraBusy}>
            📋 Copy + open Jira
          </button>
          <button className="modal-btn primary" onClick={handleJiraCreate} disabled={jiraBusy}>
            {jiraBusy ? '⏳ Creating…' : '⚡ Create in Jira'}
          </button>
        </div>
      </div>
    </div>
  )

  // F21: paste a bug's repro + expected result → a regression test (repro steps + a
  // plain-English check of the expected behaviour). Same close-first + toast flow.
  const bugPromptModal = bugPromptOpen && (
    <div className="modal-backdrop" onClick={() => setBugPromptOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🐛 Bug check — this page</span>
          <button className="modal-close" onClick={() => setBugPromptOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Steps to reproduce (plain English)</span>
            <textarea
              className="api-body"
              rows={4}
              placeholder={
                'e.g. log in as standard_user, add the backpack to the cart, then open the cart'
              }
              value={bugReproText}
              onChange={(e) => setBugReproText(e.target.value)}
              autoFocus
            />
          </label>
          <label className="api-field">
            <span>Expected result (what SHOULD happen)</span>
            <textarea
              className="api-body"
              rows={2}
              placeholder={'e.g. the cart shows 1 item and the backpack is listed'}
              value={bugExpectedText}
              onChange={(e) => setBugExpectedText(e.target.value)}
            />
          </label>
          <p className="api-hint">
            Adds a smart check for <strong>the page you’re on right now</strong>. The AI reproduces
            your steps (grounded to real elements on THIS page, so it can’t invent selectors), then
            adds a plain-English check of the expected result — one it reasons about like a human,
            not a rigid selector match. Replay it BEFORE the fix — the check fails; AFTER the fix —
            it passes. It only covers this one page: for a bug that spans several pages, record the
            navigation to reach each page, then run this on the page where the check belongs. Always
            review + Replay.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setBugPromptOpen(false)}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleGenerateRegressionTest}
            disabled={!bugReproText.trim()}
          >
            🐛 Build check
          </button>
        </div>
      </div>
    </div>
  )

  // F27: name the data a step creates. Enter saves, Esc/backdrop cancels.
  const createsDataModal = createsDataIndex !== null && (
    <div className="modal-backdrop" onClick={() => setCreatesDataIndex(null)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🗃️ What does this step create?</span>
          <button
            className="modal-close"
            onClick={() => setCreatesDataIndex(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Data created by this step</span>
            <input
              type="text"
              placeholder='e.g. "user account", "order"'
              value={createsDataDraft}
              onChange={(e) => setCreatesDataDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveCreatesData()
                if (e.key === 'Escape') setCreatesDataIndex(null)
              }}
              autoFocus
            />
          </label>
          <p className="api-hint">
            Tracked so a suite can flag it if nothing cleans it up. A test that creates data but has
            no 🧹 teardown step is an orphan — its records pile up in the environment run after run,
            and eventually a later run fails on data its own suite left behind.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setCreatesDataIndex(null)}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={handleSaveCreatesData}
            disabled={!createsDataDraft.trim()}
          >
            🗃️ Save
          </button>
        </div>
      </div>
    </div>
  )

  // F31: the living-docs modal, opened by 📖 Suite docs on the library screen.
  // It's declared here (above both returns) but only rendered in the welcome
  // branch, which is the sole screen that can open it.
  const docsModal = docOpen && (
    <div className="modal-backdrop" onClick={() => setDocOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📖 Living docs</span>
          <button className="modal-close" onClick={() => setDocOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <pre className="modal-code doc-preview">
          <code>{docContent}</code>
        </pre>
        <div className="modal-footer">
          {docSavedPath && <span className="saved-path">Saved to {docSavedPath}</span>}
          <button className="modal-btn" onClick={handleCopyDocs}>
            Copy
          </button>
          <button className="modal-btn" onClick={handleSaveDocs}>
            Save .md
          </button>
          <button className="modal-btn primary" onClick={() => setDocOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )

  // F31: acceptance-criteria checklist — enter ACs, AI maps them to covering tests.
  const acModal = acOpen && (
    <div className="modal-backdrop" onClick={closeAcChecklist}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">✅ AC checklist — which tests cover each requirement</span>
          <button className="modal-close" onClick={closeAcChecklist} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          <label className="api-field">
            <span>Acceptance criteria — one per line</span>
            <textarea
              className="api-body"
              rows={5}
              placeholder={
                'e.g. A user can log in with valid credentials\nInvalid login shows an error message\nThe cart shows the number of items added'
              }
              value={acText}
              onChange={(e) => setAcText(e.target.value)}
            />
          </label>
          <p className="api-hint">
            The AI reads your {savedTests.length} saved test{savedTests.length === 1 ? '' : 's'} and
            marks which cover each criterion — an <strong>uncovered AC is a real coverage gap</strong>.
            It judges coverage (needs the Claude CLI), so sanity-check the matches. Your criteria are
            saved between sessions.
          </p>
          {acFailed && (
            <p className="api-hint" style={{ color: '#f0b232' }}>
              ⚠ The AI is unavailable (needs the Claude CLI). Try again.
            </p>
          )}
          {acResult &&
            (() => {
              const covered = acResult.filter((r) => r.tests.length).length
              const gaps = acResult.length - covered
              return (
                <div className="ac-results">
                  <div className="ac-summary">
                    {covered} of {acResult.length} covered
                    {gaps > 0 ? ` · ${gaps} gap${gaps === 1 ? '' : 's'} ⚠` : ' · full coverage ✓'}
                  </div>
                  <ul className="ac-list">
                    {acResult.map((r, i) => (
                      <li key={i} className={`ac-row ${r.tests.length ? 'covered' : 'uncovered'}`}>
                        <span className="ac-mark">{r.tests.length ? '✓' : '⚠'}</span>
                        <span className="ac-text">{r.ac}</span>
                        <span className="ac-tests">
                          {r.tests.length
                            ? `covered by ${r.tests.join(', ')}`
                            : 'NOT covered by any test'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })()}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeAcChecklist}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleMatchAcs}
            disabled={acBusy || !acText.trim()}
          >
            {acBusy ? 'Matching…' : '🤖 Match to tests'}
          </button>
        </div>
      </div>
    </div>
  )

  // F32: the monitors dashboard — promote a saved test to a scheduled monitor,
  // see each one's status/last result, toggle/run/remove, and read its history.
  const monitorsModal = monitorsOpen && (
    <div className="modal-backdrop" onClick={() => setMonitorsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📡 Monitors — scheduled re-runs + failure alerts</span>
          <button className="modal-close" onClick={() => setMonitorsOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          <p className="api-hint">
            A monitor re-runs a saved test on a schedule (headless) and pops a desktop alert when it
            fails — catching regressions between your manual runs.{' '}
            <strong>It only runs while this app is open</strong> (there's no background service), and
            it needs Playwright installed (same as cross-browser).
          </p>
          {monRunningId && (
            <p className="api-hint" style={{ color: '#7fd39a' }}>
              ⏳ A monitor run is in progress (headless, ~10–30s)… the row updates when it finishes.
            </p>
          )}
          {/* Opening ANY modal shrinks the native browser pane to nothing, or the
              dialog would render underneath it. That is normally invisible — but
              a screenshot of a hidden view comes back EMPTY, so a variant that
              fails while this is open loses its failure screenshot. Now that this
              dashboard can be opened mid-batch from the workspace, say so instead
              of quietly costing evidence. */}
          {(suiteRun?.running ||
            dataRun?.running ||
            localeRun?.running ||
            edgeRun?.running) && (
            <p className="api-hint" style={{ color: '#e0b56b' }}>
              ⚠ A batch is running. The page is hidden while this dialog is open — the run
              continues normally, but a step that fails right now would save an empty failure
              screenshot. Close this to bring the page back.
            </p>
          )}
          {/* F32b: a failing run retries up to 3× before alerting (kills transient
              blips); alerts also POST to this webhook if set (off-machine reach). */}
          <label className="api-field">
            <span>Alert webhook — Slack / Discord / Teams (optional)</span>
            <input
              className="url-input"
              type="text"
              placeholder="https://hooks.slack.com/services/…  (also fires the desktop alert)"
              value={monWebhook}
              onChange={(e) => {
                setMonWebhook(e.target.value)
                const v = e.target.value.trim()
                if (v) localStorage.setItem('monitor.webhookUrl', v)
                else localStorage.removeItem('monitor.webhookUrl')
              }}
            />
          </label>
          <div className="mon-add">
            <select
              className="env-bar-select"
              value={monTestSel}
              onChange={(e) => setMonTestSel(e.target.value)}
            >
              <option value="">Pick a test to monitor…</option>
              {savedTests.map((t) => (
                <option key={t.fileName} value={t.fileName}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              className="env-bar-select"
              value={monInterval}
              onChange={(e) => setMonInterval(Number(e.target.value))}
            >
              <option value={5}>every 5 min</option>
              <option value={15}>every 15 min</option>
              <option value={30}>every 30 min</option>
              <option value={60}>every hour</option>
              <option value={240}>every 4 hours</option>
            </select>
            <select
              className="env-bar-select"
              value={monEnvId}
              onChange={(e) => setMonEnvId(e.target.value)}
              title="Which environment this monitor always runs against (independent of the global Run-against selection)"
            >
              <option value="">against recorded URLs</option>
              {envState.environments.map((env) => (
                <option key={env.id} value={env.id}>
                  against {env.name}
                </option>
              ))}
            </select>
            <label className="mon-alert-toggle" title="Fire a desktop notification when a run fails">
              <input
                type="checkbox"
                checked={monAlert}
                onChange={(e) => setMonAlert(e.target.checked)}
              />{' '}
              alert on fail
            </label>
            <button
              className="modal-btn primary"
              disabled={!monTestSel}
              onClick={async () => {
                const t = savedTests.find((s) => s.fileName === monTestSel)
                if (!t) return
                setMonitors(
                  await window.api.monitors.save({
                    id: `mon-${Date.now()}`,
                    fileName: t.fileName,
                    name: t.name,
                    intervalMin: monInterval,
                    enabled: true,
                    alertOnFail: monAlert,
                    envId: monEnvId || null,
                    lastRunAt: null,
                    runs: []
                  })
                )
                setMonTestSel('')
              }}
            >
              + Add monitor
            </button>
          </div>
          {monitors.length === 0 ? (
            <p className="api-hint">No monitors yet — pick a test above to start watching it.</p>
          ) : (
            <>
              <div className="mon-runall">
                <button
                  className="mon-btn primary"
                  disabled={monRunningId !== null}
                  onClick={runAllMonitorsNow}
                >
                  {monRunningId ? '⏳ running…' : `▶ Run all ${monitors.length} now`}
                </button>
                <span className="mon-runall-hint">
                  Runs every monitor once, in order — a one-click health check.
                </span>
              </div>
              <ul className="mon-list">
              {monitors.map((m) => {
                const last = m.runs[0]
                // One obvious status per monitor, so it's never a mystery whether
                // it's running, healthy, broken, or off.
                const running = monRunningId === m.id
                const status = running
                  ? { cls: 'running', label: '⏳ Running…' }
                  : !m.enabled
                    ? { cls: 'paused', label: '⏸ Paused' }
                    : !last
                      ? { cls: 'new', label: '• Never run' }
                      : last.status === 'passed'
                        ? { cls: 'pass', label: '✓ Passing' }
                        : last.status === 'failed'
                          ? { cls: 'fail', label: '✗ Failing' }
                          : { cls: 'err', label: '⚠ Can’t run' }
                // A monitor can outlive the environment it was pinned to. That used
                // to be near-silent — grey text reading "a deleted env" — while the
                // real consequence was severe: no pinned env means NO variables are
                // applied at all (see the `pinned` lookup in doMonitorRun), so a
                // test whose data rows use {{env:…}} logs in with an unresolved
                // token and fails on whatever assertion happens to come first.
                const envMissing = !!m.envId && !envState.environments.some((e) => e.id === m.envId)
                return (
                  <li key={m.id} className={`mon-card ${status.cls}`}>
                    <div className="mon-card-head">
                      <span className={`mon-status ${status.cls}`}>{status.label}</span>
                      <span className="mon-title">{m.name}</span>
                      <div className="mon-actions">
                        <button
                          className="mon-btn"
                          onClick={async () =>
                            setMonitors(await window.api.monitors.save({ ...m, enabled: !m.enabled }))
                          }
                          title={m.enabled ? 'Pause this monitor' : 'Resume this monitor'}
                        >
                          {m.enabled ? '⏸ pause' : '▶ resume'}
                        </button>
                        <button
                          className="mon-btn primary"
                          disabled={monRunningId !== null}
                          title={
                            monRunningId && !running
                              ? 'Another monitor is running — one headless run at a time'
                              : 'Run this test headless right now (~10–30s)'
                          }
                          onClick={() => runMonitorNow(m)}
                        >
                          {running ? '⏳ running…' : '▶ run now'}
                        </button>
                        <button
                          className="mon-btn"
                          onClick={() => setMonHistoryFor(monHistoryFor === m.id ? null : m.id)}
                        >
                          {monHistoryFor === m.id ? 'hide history' : `history (${m.runs.length})`}
                        </button>
                        <button
                          className="mon-btn danger"
                          onClick={async () => setMonitors(await window.api.monitors.delete(m.id))}
                        >
                          remove
                        </button>
                      </div>
                    </div>
                    <div className="mon-meta">
                      {/* The schedule is EDITABLE here. It used to be plain text,
                          set once when the monitor was created and never again —
                          so changing a monitor's cadence meant deleting it and
                          rebuilding it, which threw away its whole run history.
                          Takes effect immediately: the scheduler computes "due"
                          as lastRunAt + intervalMin, so shortening the interval
                          on a monitor that ran a while ago makes it due at once. */}
                      Runs{' '}
                      <select
                        className="mon-interval"
                        value={m.intervalMin}
                        title="How often this monitor re-runs (applies from its last run)"
                        onChange={async (e) =>
                          setMonitors(
                            await window.api.monitors.save({
                              ...m,
                              intervalMin: Number(e.target.value)
                            })
                          )
                        }
                      >
                        <option value={5}>every 5 min</option>
                        <option value={15}>every 15 min</option>
                        <option value={30}>every 30 min</option>
                        <option value={60}>every hour</option>
                        <option value={240}>every 4 hours</option>
                      </select>{' '}
                      · against{' '}
                      {/* Also editable now. Pinning was set once at creation, so a
                          monitor pointing at a deleted (or simply wrong) environment
                          could only be corrected by deleting and rebuilding it —
                          throwing away its whole run history to change one field. */}
                      <select
                        className={`mon-interval${envMissing ? ' missing' : ''}`}
                        value={envMissing ? '__missing' : (m.envId ?? '')}
                        title="Which environment's baseURL + variables this monitor runs against"
                        onChange={async (e) =>
                          setMonitors(
                            await window.api.monitors.save({
                              ...m,
                              envId: e.target.value === '' ? null : e.target.value
                            })
                          )
                        }
                      >
                        <option value="">recorded URLs</option>
                        {envState.environments.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                        {/* Kept selectable-looking so the dropdown shows the truth
                            rather than silently reading as "recorded URLs", which is
                            what it actually falls back to at run time. */}
                        {envMissing && (
                          <option value="__missing" disabled>
                            ⚠ deleted environment
                          </option>
                        )}
                      </select>
                      {m.alertOnFail ? ' · 🔔 alerts on failure' : ''} ·{' '}
                      {last
                        ? `last run ${last.status} at ${new Date(last.at).toLocaleTimeString()}`
                        : 'not run yet'}
                    </div>
                    {monHistoryFor === m.id && (
                      <div className="mon-history">
                        {m.runs.length === 0 ? (
                          <div className="mon-history-empty">No runs yet — hit “run now”.</div>
                        ) : (
                          m.runs.map((r, i) => (
                            <div key={i} className={`mon-history-row ${r.status}`}>
                              <span className="mon-history-mark">
                                {r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠'}
                              </span>
                              <span className="mon-history-when">
                                {new Date(r.at).toLocaleString()}
                              </span>
                              <span className="mon-history-detail">{r.detail || 'passed'}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
              </ul>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn primary" onClick={() => setMonitorsOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )

  // F23: the coverage gap map — crawl progress, then the tested/untested overlay.
  const coverageModal = coverageOpen && (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!coverageRun?.running) setCoverageOpen(false)
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🗺️ Coverage gap map</span>
          <button className="modal-close" onClick={() => setCoverageOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          {coverageRun?.running ? (
            <p className="api-hint">
              ⏳ Crawling from your current page… found <strong>{coverageRun.found}</strong> page
              {coverageRun.found === 1 ? '' : 's'} so far. The browser is walking the links — it
              returns to where you were when it's done.
            </p>
          ) : !coverageRun?.result || coverageRun.result.pages.length === 0 ? (
            <p className="api-hint">
              Nothing to map. Open your app in the browser first (navigate, and log in if it needs a
              session), then run 🗺️ Coverage from that page — it crawls outward from wherever you are.
            </p>
          ) : (
            (() => {
              const { result, coveredExact, coveredContains } = coverageRun
              const isCov = (path: string): boolean => {
                // Navigate coverage is scoped to THIS crawled site (origin+path),
                // so a same-path test on a different site isn't credited here.
                const full = result.origin + normCovPath(path)
                if (coveredExact.has(full)) return true
                // url-contains: matched against the PATH only (matching the full
                // URL would let a value like "https" cover everything), AND only
                // when the assert's own test drives this site, AND the value is
                // specific enough — a lone "/" or "" is too loose to be coverage.
                const p = normCovPath(path)
                return coveredContains.some(
                  (c) =>
                    c.value.replace(/\/+$/, '').length > 1 &&
                    c.origins.includes(result.origin) &&
                    p.includes(c.value)
                )
              }
              const seen = new Set<string>()
              const pages = result.pages.filter((p) => {
                const k = normCovPath(p.path)
                if (seen.has(k)) return false
                seen.add(k)
                return true
              })
              const coveredCount = pages.filter((p) => isCov(p.path)).length
              const gaps = pages.length - coveredCount
              const pct = Math.round((coveredCount / Math.max(1, pages.length)) * 100)
              const ordered = [...pages].sort(
                (a, b) => Number(isCov(a.path)) - Number(isCov(b.path))
              )
              return (
                <>
                  <p className="api-hint">
                    Crawled <strong>{pages.length}</strong> page{pages.length === 1 ? '' : 's'} from{' '}
                    <code>{result.origin}</code>
                    {result.capped ? ' (stopped at the 40-page cap)' : ''}. A page counts as tested
                    when a saved test <strong>navigates</strong> to it or <strong>asserts its URL</strong>
                    — one reached only by clicking through can still show as a gap, which is a nudge to
                    add an explicit check there.
                  </p>
                  <div className="ac-summary">
                    {coveredCount} of {pages.length} pages covered ({pct}%)
                    {gaps ? ` · ${gaps} gap${gaps === 1 ? '' : 's'} ⚠` : ' · full coverage ✓'}
                  </div>
                  <ul className="ac-list">
                    {ordered.map((p) => {
                      const cov = isCov(p.path)
                      return (
                        <li key={p.path} className={`ac-row ${cov ? 'covered' : 'uncovered'}`}>
                          <span className="ac-mark">{cov ? '✓' : '⚠'}</span>
                          <span className="ac-text">
                            <strong>{p.path}</strong>
                            <span className="mon-sub">
                              {cov ? 'covered by a test' : 'no test visits or verifies this page'}
                              {p.title && p.title !== p.path ? ` · ${p.title}` : ''}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )
            })()
          )}
        </div>
        <div className="modal-footer">
          <button
            className="modal-btn primary"
            onClick={() => setCoverageOpen(false)}
            disabled={coverageRun?.running}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )

  // === F40 modals (shared by BOTH views) ==============================
  // These live in a variable, not inline in the workspace JSX, because the
  // welcome view returns EARLY — and all three are triggered from there: the
  // secret migration fires at startup, and Export/Import bundle live in the
  // library, which IS the welcome screen. Inline, they were unreachable.
  const f40Modals = (
    <>
        {
          /* F40: the app just rewrote the user's test files. Say so, plainly, with
             what changed and where the backup is — a silent file rewrite would be
             indefensible even when it's an improvement.
             NOTE: top-level, NOT inside the suite-report block — it fires at
             STARTUP, when no suite run exists. */
          secretMigration && (
            <div className="modal-backdrop" onClick={() => setSecretMigration(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">🔑 Passwords moved out of your test files</span>
                  <button
                    className="modal-close"
                    onClick={() => setSecretMigration(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  <p>
                    Until now, a password field marked <strong>secret</strong> was masked on screen
                    and kept out of the export — but the value itself was still written into the
                    test&apos;s JSON file, in plain text, in a folder meant to be shared and
                    committed.
                  </p>
                  <p>
                    <strong>{secretMigration.migrated}</strong> test
                    {secretMigration.migrated === 1 ? '' : 's'} updated. The passwords now live in
                    your app data alongside your environments; each step keeps only a reference.
                    <strong> Nothing about how your tests run has changed.</strong>
                  </p>
                  <ul>
                    {secretMigration.tests.slice(0, 10).map((t) => (
                      <li key={t}>
                        <code>{t}</code>
                      </li>
                    ))}
                    {secretMigration.tests.length > 10 && (
                      <li>…and {secretMigration.tests.length - 10} more</li>
                    )}
                  </ul>
                  <p className="import-note">
                    A full copy of your library was saved to{' '}
                    <code>QATestFlow Tests/_backups/</code> before anything was changed.
                  </p>
                </div>
                <div className="assert-actions">
                  <button className="modal-btn primary" onClick={() => setSecretMigration(null)}>
                    Got it
                  </button>
                </div>
              </div>
            </div>
          )
        }
        {
          /* F40: what the export actually produced — and, just as importantly,
             what it deliberately left out. */
          bundleResult && (
            <div className="modal-backdrop" onClick={() => setBundleResult(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">
                    📦 Bundle exported — {bundleResult.manifest.testCount} test
                    {bundleResult.manifest.testCount === 1 ? '' : 's'}
                  </span>
                  <button
                    className="modal-close"
                    onClick={() => setBundleResult(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  <p className="bundle-path">
                    <code>{bundleResult.path}</code>
                  </p>
                  <p>
                    It’s a plain folder — commit it to git so test changes show up in pull
                    requests, or zip it and send it.
                  </p>
                  <h4>Included</h4>
                  <ul>
                    <li>
                      {bundleResult.manifest.testCount} test
                      {bundleResult.manifest.testCount === 1 ? '' : 's'}
                    </li>
                    {bundleResult.manifest.blocks.length > 0 && (
                      <li>
                        {bundleResult.manifest.blocks.length} linked block
                        {bundleResult.manifest.blocks.length === 1 ? '' : 's'} — without these the
                        🧩 steps would be broken
                      </li>
                    )}
                    {bundleResult.manifest.uploads.length > 0 && (
                      <li>
                        {bundleResult.manifest.uploads.length} upload file
                        {bundleResult.manifest.uploads.length === 1 ? '' : 's'}
                      </li>
                    )}
                    {bundleResult.manifest.hasAcceptanceCriteria && <li>Acceptance criteria</li>}
                  </ul>
                  <h4>Deliberately left out</h4>
                  <ul className="bundle-omitted">
                    {bundleResult.manifest.secretsPlaceholdered.length > 0 && (
                      <li>
                        <strong>Passwords</strong> —{' '}
                        {bundleResult.manifest.secretsPlaceholdered.length} test
                        {bundleResult.manifest.secretsPlaceholdered.length === 1 ? '' : 's'} carry{' '}
                        <code>{'{{env:PASSWORD}}'}</code> instead. Safe to commit.
                      </li>
                    )}
                    {bundleResult.manifest.dataScrubbed.length > 0 && (
                      <li>
                        <strong>Sensitive data columns</strong> —{' '}
                        {bundleResult.manifest.dataScrubbed
                          .map((d) => d.columns.join(', '))
                          .join('; ')}{' '}
                        replaced with env tokens.
                      </li>
                    )}
                    <li>
                      <strong>Saved sessions</strong> — a session file is a credential, and it
                      expires. They record their own.
                    </li>
                    <li>
                      <strong>Run history &amp; trust scores</strong> — those describe your machine.
                      Every test arrives as “new / untested”, which is the truth for them.
                    </li>
                    {bundleResult.manifest.visualWithoutBaseline.length > 0 && (
                      <li>
                        <strong>Visual baselines</strong> —{' '}
                        {bundleResult.manifest.visualWithoutBaseline.length === 1
                          ? '1 test takes a snapshot'
                          : `${bundleResult.manifest.visualWithoutBaseline.length} tests take a snapshot`}
                        . A baseline is tied to the screen it was captured on, so a shared
                        one fails elsewhere for no real reason. Their <em>first</em> run creates
                        theirs and passes without comparing anything — the second run is the first
                        real check. The README says so.
                      </li>
                    )}
                  </ul>
                </div>
                <div className="assert-actions">
                  <button
                    className="modal-btn"
                    onClick={() => window.api.xbrowser.revealBundle(bundleResult.path)}
                  >
                    📂 Show in folder
                  </button>
                  <button className="modal-btn primary" onClick={() => setBundleResult(null)}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          )
        }
        {
          /* F40: decide every collision BEFORE anything is written. */
          importPlan && (
            <div className="modal-backdrop" onClick={() => setImportPlan(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">
                    📥 Import bundle — {importPlan.tests.length} test
                    {importPlan.tests.length === 1 ? '' : 's'}
                  </span>
                  <button
                    className="modal-close"
                    onClick={() => setImportPlan(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  {(() => {
                    const clashes = importPlan.tests.filter((t) => t.collidesWith)
                    if (!clashes.length) {
                      return <p>No name clashes — everything here is new to your library.</p>
                    }
                    return (
                      <>
                        <p>
                          <strong>{clashes.length}</strong> of these already exist here. Choose what
                          happens to each — nothing is written until you hit Import.
                        </p>
                        <div className="import-allrow">
                          Apply to all clashes:
                          {(['keep-both', 'overwrite', 'skip'] as const).map((c) => (
                            <button
                              key={c}
                              type="button"
                              // Show which one is in force. Without this the
                              // button you click never changes, so on a long
                              // list (56 rows, most of them off-screen) it reads
                              // as "the button doesn't work" — the rows DID all
                              // change, you just couldn't see it happen.
                              // Derived, not remembered: it lights up whenever
                              // every clashing row already agrees, so picking
                              // rows individually keeps it honest too.
                              className={`modal-btn${
                                clashes.length > 0 &&
                                clashes.every((t) => importPlan.choices[t.file] === c)
                                  ? ' primary'
                                  : ''
                              }`}
                              onClick={() =>
                                setImportPlan((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        choices: Object.fromEntries(
                                          prev.tests.map((t) => [
                                            t.file,
                                            t.collidesWith ? c : 'overwrite'
                                          ])
                                        )
                                      }
                                    : prev
                                )
                              }
                            >
                              {c === 'keep-both'
                                ? 'Keep both'
                                : c === 'overwrite'
                                  ? 'Overwrite'
                                  : 'Skip'}
                            </button>
                          ))}
                          {/* At 56 rows — let alone a real team library — you
                              can't judge an import by reading every row. Say
                              what the current choices ADD UP TO. */}
                          {(() => {
                            const vals = Object.values(importPlan.choices)
                            const n = (c: string): number =>
                              importPlan.tests.filter(
                                (t) => t.collidesWith && importPlan.choices[t.file] === c
                              ).length
                            const fresh = importPlan.tests.length - clashes.length
                            return (
                              <span className="import-tally">
                                {fresh > 0 && (
                                  <>
                                    <strong>{fresh}</strong> new ·{' '}
                                  </>
                                )}
                                <strong>{n('keep-both')}</strong> kept alongside ·{' '}
                                <strong>{n('overwrite')}</strong> overwritten ·{' '}
                                <strong>{n('skip')}</strong> skipped
                                {vals.length === 0 && ' — nothing selected'}
                              </span>
                            )
                          })()}
                        </div>
                      </>
                    )
                  })()}
                  <ul className="import-list">
                    {importPlan.tests.map((t) => (
                      <li key={t.file} className={t.collidesWith ? 'clash' : ''}>
                        <div className="import-name">
                          <strong>{t.name}</strong>
                          {t.suite && <span className="import-suite">{t.suite}</span>}
                          <span className="import-meta">{t.stepCount} steps</span>
                          {(t.tags ?? []).map((tag) => (
                            <span key={tag} className="tag-chip">
                              {tag}
                            </span>
                          ))}
                        </div>
                        {t.collidesWith ? (
                          <div className="import-choice">
                            <span className="import-warn">
                              already exists ({t.existingStepCount} steps
                              {t.existingUpdatedAt
                                ? `, edited ${new Date(t.existingUpdatedAt).toLocaleDateString()}`
                                : ''}
                              )
                            </span>
                            {(['keep-both', 'overwrite', 'skip'] as const).map((c) => (
                              <button
                                key={c}
                                type="button"
                                className={`assert-kind${
                                  importPlan.choices[t.file] === c ? ' chosen' : ''
                                }`}
                                onClick={() =>
                                  setImportPlan((prev) =>
                                    prev
                                      ? { ...prev, choices: { ...prev.choices, [t.file]: c } }
                                      : prev
                                  )
                                }
                              >
                                {c === 'keep-both'
                                  ? 'Keep both'
                                  : c === 'overwrite'
                                    ? 'Overwrite'
                                    : 'Skip'}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="import-new">new</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {importPlan.manifest?.visualWithoutBaseline?.length ? (
                    <p className="import-note">
                      ⚠{' '}
                      {importPlan.manifest.visualWithoutBaseline.length === 1
                        ? '1 of these takes a visual snapshot'
                        : `${importPlan.manifest.visualWithoutBaseline.length} of these take a visual snapshot`}
                      , and baselines aren’t shared (they’re tied to the screen they were
                      captured on). Your <strong>first</strong> run creates your own baseline and
                      passes without comparing anything — the second run is the first real check.
                    </p>
                  ) : null}
                  {importPlan.manifest?.secretsPlaceholdered?.length ? (
                    <p className="import-note">
                      🔑{' '}
                      {importPlan.manifest.secretsPlaceholdered.length === 1
                        ? '1 test needs a password'
                        : `${importPlan.manifest.secretsPlaceholdered.length} tests need a password`}
                      . Set <code>PASSWORD</code> in your environment (🌐 Run against →
                      manage) before running them.
                    </p>
                  ) : null}
                </div>
                <div className="assert-actions">
                  <button className="modal-btn" onClick={() => setImportPlan(null)}>
                    Cancel
                  </button>
                  <button
                    className="modal-btn primary"
                    disabled={bundleBusy}
                    onClick={handleApplyImport}
                  >
                    Import
                  </button>
                </div>
              </div>
            </div>
          )
        }
    </>
  )

  // === Suite-run report (shared by BOTH views) ========================
  // In a variable, not inline, because a PARALLEL batch never leaves the
  // library — it does not touch the embedded browser, so switching to the
  // workspace would just show an empty pane. The report therefore has to be
  // reachable from the welcome view too. Same reasoning as f40Modals.
  const suiteReport = (
    <>
        {
          /* Day 11.5 + B: the suite-run REPORT — only once the run has FINISHED
             (suiteSummaryOpen). Without that gate it pops open mid-run and covers
             the live progress. */
          suiteSummaryOpen &&
          suiteRun &&
          (() => {
            const r = suiteRun.results
            const passed = r.filter((x) => x.status === 'passed').length
            const failed = r.length - passed
            const healedCount = r.reduce((s, x) => s + (x.healed ?? 0), 0)
            const healedSaves = suiteRun.healedSaves ?? []
            const byCat = new Map<string, number>()
            for (const x of r) {
              if (x.status === 'failed') {
                const c = x.category ?? 'unknown'
                byCat.set(c, (byCat.get(c) ?? 0) + 1)
              }
            }
            const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1])
            return (
              <div className="modal-backdrop" onClick={() => setSuiteRun(null)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <span className="modal-title">
                      {suiteRun.suite}: {passed} passed, {failed} failed
                      {healedCount ? ` · ${healedCount} auto-healed` : ''}
                    </span>
                    <button
                      className="modal-close"
                      onClick={() => setSuiteRun(null)}
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>

                  {/* F39: which engine ran what. A parallel result comes from the
                      exported spec, so it carries none of the in-app resilience —
                      the reader has to be able to tell the two apart. */}
                  {(() => {
                    const par = r.filter((x) => x.ranParallel).length
                    const skipped = r.filter(
                      (x) => !x.ranParallel && parallelSkipReasons.current.has(x.fileName)
                    )
                    // F39.1: the failures that came from the HEADLESS runner, as
                    // library entries so they can be handed straight back to
                    // handleRunSuite. A test missing from the library (deleted
                    // mid-run) is dropped rather than crashing the report.
                    const parFailedFiles = new Set(
                      r.filter((x) => x.ranParallel && x.status === 'failed').map((x) => x.fileName)
                    )
                    const parFailed = savedTests.filter((t) => parFailedFiles.has(t.fileName))
                    if (!parallelMode && !parallelNote) return null
                    return (
                      <div className="parallel-summary">
                        {parallelNote ? (
                          <div className="parallel-warn">⚠ {parallelNote}</div>
                        ) : (
                          <div>
                            ⚡ <strong>{par}</strong> ran in parallel ({parallelWorkers} at a time,
                            headless Playwright) · <strong>{r.length - par}</strong> ran in the app.
                          </div>
                        )}
                        {skipped.length > 0 && (
                          <details className="parallel-skips">
                            <summary>
                              {skipped.length} test{skipped.length === 1 ? '' : 's'} couldn’t run in
                              parallel — why?
                            </summary>
                            <ul>
                              {skipped.map((x) => (
                                <li key={x.fileName}>
                                  <strong>{x.name}</strong> —{' '}
                                  {parallelSkipReasons.current.get(x.fileName)}
                                </li>
                              ))}
                            </ul>
                            <p>
                              These ran the normal way instead. Running them headless would have
                              skipped those checks and still come back green — a false pass.
                            </p>
                          </details>
                        )}
                        {/* F39.1: the OTHER direction — a false FAIL.
                            headlessBlockers catches steps that would silently
                            check nothing headless. It cannot catch a test that
                            depends on SELF-HEAL, because healing happens when a
                            selector misses at RUNTIME — nothing static can
                            predict it. Surbhi's three F4 heal demos passed in the
                            app and timed out here, for exactly that reason.
                            So instead of pretending we can filter them out up
                            front, say it plainly and make re-checking one click. */}
                        {parFailed.length > 0 && (
                          <div className="parallel-recheck">
                            <div>
                              ⚠ <strong>{parFailed.length}</strong> failed headless. The headless
                              runner has <strong>no self-heal and no recovery pause</strong> — a
                              test that leans on either fails here but passes in the app.
                            </div>
                            <button
                              type="button"
                              className="modal-btn"
                              onClick={() => {
                                setSuiteRun(null)
                                handleRunSuite(
                                  `${parFailed.length} failed test${parFailed.length === 1 ? '' : 's'}`,
                                  parFailed,
                                  { forceSequential: true }
                                )
                              }}
                              title="Replay just these in the app, where self-heal and the recovery pause exist"
                            >
                              ↻ Re-run {parFailed.length} in the app
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* F39.2: any test in this run that started from a session
                      which has already expired. Shown whether it passed or
                      failed — a PASS is the dangerous case, because in the app
                      it rides on the embedded browser still being logged in
                      from ordinary use, and nothing else will be. */}
                  {(() => {
                    const stale = r
                      .map((x) => savedTests.find((t) => t.fileName === x.fileName))
                      .filter(
                        (t): t is SavedTestSummary =>
                          !!t?.storageState && !!sessionAge(t.storageState)?.expired
                      )
                    if (!stale.length) return null
                    const files = [...new Set(stale.map((t) => t.storageState!))]
                    return (
                      <div className="parallel-recheck session-stale">
                        <div>
                          ⚠ <strong>{stale.length}</strong> test
                          {stale.length === 1 ? '' : 's'} started from a session that has{' '}
                          <strong>{sessionAge(files[0])?.text}</strong> ({files.join(', ')}). In the
                          app these can still pass on the browser&apos;s leftover login — headless
                          and in CI they will not. Log in again and save over the session.
                        </div>
                      </div>
                    )
                  })()}

                  {/* B: failures grouped by cause (the suite-level triage view). */}
                  {cats.length > 0 && (
                    <div className="failure-breakdown">
                      <span className="failure-breakdown-label">Failures by type:</span>
                      {cats.map(([c, n]) => (
                        <span
                          key={c}
                          className={`category-chip cat-${c}`}
                          title={CATEGORY_WHY[c as FailureCategory] ?? ''}
                        >
                          {CATEGORY_LABELS[c as FailureCategory] ?? c} <strong>{n}</strong>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* F25: {{env:NAME}} tokens that resolved to nothing in this run.
                      ABOVE the per-test rows on purpose — it explains failures the
                      classifier can only describe. A test whose username token was
                      empty fails as "Expected URL to contain /inventory.html" and
                      gets tagged "stale data": plausible, and pointing at entirely
                      the wrong thing. Listed once with the affected tests rather
                      than repeated on every row. */}
                  {(() => {
                    const byVar = new Map<string, string[]>()
                    for (const r of suiteRun.results) {
                      for (const v of r.unresolvedEnv ?? []) {
                        byVar.set(v, [...(byVar.get(v) ?? []), r.name])
                      }
                    }
                    if (!byVar.size) return null
                    return (
                      <div className="edge-warn edge-warn-block">
                        ⚠ {byVar.size} environment {byVar.size === 1 ? 'variable' : 'variables'} had
                        no value in this run — every step using{' '}
                        {byVar.size === 1 ? 'it' : 'them'} typed an{' '}
                        <strong>empty string</strong>, so a failure below may be about the
                        environment rather than the test.
                        <ul className="env-missing-list">
                          {[...byVar.entries()].map(([v, tests]) => (
                            <li key={v}>
                              <code>{`{{env:${v}}}`}</code> — {tests.length}{' '}
                              {tests.length === 1 ? 'test' : 'tests'}: {tests.join(', ')}
                              {collidesWithOsEnv(v) && (
                                <>
                                  {' '}
                                  <em>
                                    (never read from the operating system, which defines this name
                                    too — that would supply your account name instead of a test
                                    value)
                                  </em>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                        Set {byVar.size === 1 ? 'it' : 'them'} in the environment you ran against,
                        or pick one that defines {byVar.size === 1 ? 'it' : 'them'}.
                      </div>
                    )
                  })()}

                  {/* B: heal review — persist every auto-healed selector in one click. */}
                  {healedSaves.length > 0 && (
                    <div className={`blast-radius${suiteRun.healedSaved ? ' blast-radius-safe' : ''}`}>
                      {suiteRun.healedSaved ? (
                        <span className="blast-radius-head">
                          ✓ Saved {healedCount} repaired selector{healedCount > 1 ? 's' : ''} across{' '}
                          {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''}.
                        </span>
                      ) : (
                        <>
                          <span className="blast-radius-head">
                            🤖 {healedCount} selector{healedCount > 1 ? 's' : ''} auto-healed across{' '}
                            {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''} — keep the
                            fixes:
                          </span>
                          <ul className="blast-list">
                            {healedSaves.map((h) => (
                              <li key={h.fileName}>{h.name}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {/* Option 2: failed tests self-heal COULD fix — review & accept.
                      We never auto-applied these (a low-confidence heal that "works"
                      could be a false pass); a human confirms before they go green. */}
                  {(suiteRun.healables ?? []).length > 0 && (
                    <div className="healable-review">
                      <div className="healable-head">
                        🔧 {suiteRun.healables!.length} failed test
                        {suiteRun.healables!.length > 1 ? 's' : ''} could be self-healed — review before
                        accepting (a low-confidence heal may target the wrong element):
                      </div>
                      <ul className="blast-list">
                        {suiteRun.healables!.map((hf) => {
                          const accepted = suiteRun.accepted?.includes(hf.fileName)
                          return (
                            <li key={hf.fileName} className="healable-row">
                              <span>
                                <strong>{hf.name}</strong> → suggests “{hf.healable.label}”{' '}
                                <span className="healable-meta">
                                  ({hf.healable.signals.join(' + ')} · {hf.healable.score}/100)
                                </span>
                              </span>
                              {accepted ? (
                                <span className="healable-accepted">✓ accepted</span>
                              ) : (
                                <span className="healable-actions">
                                  <button
                                    type="button"
                                    className="modal-btn"
                                    onClick={() => handleLoadTest(hf.fileName)}
                                    title="Open the test to replay + verify the fix yourself"
                                  >
                                    Open
                                  </button>
                                  {!hf.hasBlocks && (
                                    <button
                                      type="button"
                                      className="modal-btn"
                                      onClick={() => handleAcceptHealable(hf)}
                                      title="Trust this heal — patch the selector and save"
                                    >
                                      Accept &amp; save
                                    </button>
                                  )}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      {suiteRun.healables!.some(
                        (hf) => !hf.hasBlocks && !suiteRun.accepted?.includes(hf.fileName)
                      ) && (
                        <button
                          type="button"
                          className="modal-btn"
                          onClick={handleAcceptAllHealable}
                        >
                          Accept &amp; save all
                        </button>
                      )}
                    </div>
                  )}

                  <ul className="suite-summary">
                    {r.map((x) => (
                      <li key={x.fileName} className="suite-result">
                        <span className={`run-dot ${x.status}`} />
                        <span className="suite-result-name">{x.name}</span>
                        {/* Only when the name is ambiguous — two sections can
                            hold a test with the SAME name, and without this one
                            passing and one failing reads as a contradiction. */}
                        {r.filter((o) => o.name === x.name).length > 1 &&
                          x.fileName.includes('/') && (
                            <span className="suite-result-section">
                              {x.fileName.slice(0, x.fileName.lastIndexOf('/'))}
                            </span>
                          )}
                        {x.healed ? (
                          <span className="healed-tag ai-healed-tag">🤖 {x.healed}</span>
                        ) : null}
                        {x.status === 'failed' && x.category && (
                          <span
                            className={`category-chip cat-${x.category}`}
                            title={CATEGORY_WHY[x.category] ?? ''}
                          >
                            {CATEGORY_LABELS[x.category] ?? x.category}
                          </span>
                        )}
                        {/* F39.1: a red from the headless runner is NOT the same
                            claim as a red from the app — no self-heal, no
                            recovery pause. Mark it on the row, so the reader
                            never has to remember which engine ran what. */}
                        {x.status === 'failed' && x.ranParallel && (
                          <span
                            className="headless-tag"
                            title="Ran headless in the parallel batch — no self-heal, no recovery pause. Re-run it in the app to confirm."
                          >
                            ⚡ headless
                          </span>
                        )}
                        {x.status === 'failed' && (
                          <span className="suite-result-error">
                            {x.failedAt !== undefined ? `step ${x.failedAt + 1} — ` : ''}
                            {x.error}
                          </span>
                        )}
                        {x.screenshotPath && (
                          <button
                            type="button"
                            className="shot-link"
                            onClick={() => window.api.library.openScreenshot(x.screenshotPath!)}
                            title="Open the failure screenshot"
                          >
                            📷
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="modal-footer">
                    {/* Both numbers, because they differ and the banner above shows
                        the other one: N selectors were repaired, spread across M
                        test FILES, and saving writes the files. A bare "(3)" under
                        a "10 selectors auto-healed" heading reads like 7 fixes are
                        being dropped. */}
                    {healedSaves.length > 0 && !suiteRun.healedSaved && (
                      <button className="modal-btn primary" onClick={handleSaveAllHealed}>
                        💾 Save {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''} (
                        {healedCount} fix{healedCount > 1 ? 'es' : ''})
                      </button>
                    )}
                    <button className="modal-btn" onClick={handleCopySuiteReport}>
                      Copy report
                    </button>
                    <button className="modal-btn" onClick={handleSaveSuiteReport}>
                      Save .md
                    </button>
                    <button className="modal-btn" onClick={() => setSuiteRun(null)}>
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
    </>
  )

  // === Welcome view — shown before any navigation ===
  if (!hasNavigated) {
    return (
      <div className="welcome">
        {f40Modals}
        {suiteReport}
        {envManagerModal}
        {docsModal}
        {acModal}
        {monitorsModal}
        {/* Run All is launched from here; its host-mismatch warning must render
            on this screen too, before the suite navigates to the workspace. */}
        {envWarnModal}
        {/* F39.1: a parallel batch is launched from the library, which lives on
            THIS screen — so the banner has to render here or the one run it
            exists for is the one run it never shows up in. */}
        {parallelRunning && (
          <ParallelRunBanner count={suiteRun!.parallelBatch!} workers={parallelWorkers} />
        )}
        {/* F32b: the in-app alert toast must also render on the WELCOME screen —
            the 📡 Monitors dashboard lives here, so a monitor-failure toast fired
            from it has nowhere to show otherwise (the workspace toast is a
            separate return). */}
        {aiToast && <div className={`download-toast ${aiToast.tone}`}>{aiToast.msg}</div>}
        <div className="welcome-content">
          <h1 className="logo-text">QATestFlow Recorder</h1>
          <p className="tagline">No-code QA test recorder with AI-powered selectors</p>
          <form className="welcome-form" onSubmit={handleSubmit}>
            <input
              type="text"
              className="welcome-input"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Enter a website URL to test (e.g., saucedemo.com)"
              autoFocus
              spellCheck={false}
            />
            <button type="submit" className="welcome-go-btn">
              Open
            </button>
          </form>
          <div className="examples">
            <span className="examples-label">Try:</span>
            {EXAMPLE_URLS.map((url) => (
              <button
                key={url}
                className="example-chip"
                onClick={() => handleExampleClick(url)}
                type="button"
              >
                {url}
              </button>
            ))}
          </div>

          {/* Day 17(+): start a new recording ALREADY logged in by seeding a
              saved session into the live browser — no re-typing the password. */}
          {sessions.length > 0 && (
            <div className="use-session">
              <span className="examples-label">🔑 Start logged in:</span>
              <select
                className="use-session-select"
                value={useSessionSel}
                onChange={(e) => {
                  setUseSessionSel(e.target.value)
                  setUseSessionError(null)
                }}
              >
                <option value="">Choose a saved session…</option>
                {sessions.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/\.json$/, '')}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="use-session-btn"
                disabled={!useSessionSel || applyingSession}
                onClick={handleUseSession}
                title="Seed this session and open the URL above (or its own site) already logged in"
              >
                {applyingSession ? 'Opening…' : 'Use session'}
              </button>
              {useSessionError && <span className="use-session-error">{useSessionError}</span>}
              {!useSessionError && (
                <span className="use-session-hint">opens the URL above, logged in</span>
              )}
            </div>
          )}

          {/* Day 18: recover the most recent unsaved recording (until dismissed). */}
          {!draftDismissed && drafts.length > 0 && (
            <div className="recover-banner">
              <span className="recover-text">
                ↩ Unsaved recording — <strong>{draftLabel(drafts[0])}</strong> ·{' '}
                {drafts[0].stepCount} step{drafts[0].stepCount === 1 ? '' : 's'} ·{' '}
                {new Date(drafts[0].updatedAt).toLocaleString()}
              </span>
              <div className="recover-actions">
                <button
                  type="button"
                  className="recover-btn primary"
                  onClick={() => handleLoadDraft(drafts[0].id)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="recover-btn"
                  onClick={() => setDraftDismissed(true)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Day 18: Recent recordings — auto-saved unsaved drafts, newest first. */}
          {drafts.length > 0 && (
            <div className="test-library recent-drafts">
              <div className="library-heading">
                <span className="library-heading-title">Recent recordings</span>
                <span className="library-heading-sub">
                  unsaved — auto-kept so you don’t lose work
                </span>
              </div>
              <ul className="library-list">
                {drafts.map((d) => (
                  <li key={d.id} className="library-item">
                    <div className="library-item-head">
                      <button
                        type="button"
                        className="library-row"
                        onClick={() => handleLoadDraft(d.id)}
                        title="Restore this recording"
                      >
                        <span className="run-dot none" />
                        <span className="library-name" title={d.firstUrl || draftLabel(d)}>
                          {draftLabel(d)}
                        </span>
                        <span className="library-meta">
                          {d.stepCount} step{d.stepCount === 1 ? '' : 's'} ·{' '}
                          {new Date(d.updatedAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="library-delete"
                        onClick={() => handleDeleteDraft(d.id)}
                        title="Delete this draft"
                        aria-label="Delete draft"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* === Day 11 + 11.5: saved-test library, grouped into sections === */}
          {(savedTests.length > 0 || suites.length > 0) && (
            <div className="test-library">
              {/* F39: a parallel batch stays HERE rather than switching to the
                  workspace (it never drives the embedded browser, so that view
                  would just be an empty pane). So the progress line has to live
                  in the library too. */}
              {suiteRun?.running && (
                <div className="replay-status running">
                  {suiteRun.parallelBatch ? (
                    <>
                      Running {suiteRun.parallelBatch} test
                      {suiteRun.parallelBatch === 1 ? '' : 's'} at once, {parallelWorkers} at a
                      time…
                    </>
                  ) : (
                    <>
                      Running {suiteRun.suite} — {suiteRun.current} of {suiteRun.total}
                      {suiteRun.currentName ? `: ${suiteRun.currentName}` : ''}
                    </>
                  )}
                </div>
              )}
              <div className="library-heading">
                <span className="library-heading-title">Test Library</span>
                <span className="library-heading-sub">
                  {savedTests.length === 0
                    ? 'your saved test flows will appear here'
                    : `${savedTests.length} saved test flow${savedTests.length === 1 ? '' : 's'}`}
                </span>
              </div>

              {/* F25 (environment manager): pick which environment the whole
                  library runs against — Run All / Run selected honor it. */}
              <div className="env-bar">
                <span className="env-bar-label">🌐 Run against</span>
                <select
                  className="env-bar-select"
                  value={envState.activeId ?? ''}
                  onChange={(e) => setActiveEnv(e.target.value || null)}
                  title="The environment every test runs against — its base URL re-points navigations and its variables fill {{env:NAME}} credentials. The saved tests are never changed."
                >
                  <option value="">Recorded URLs (default)</option>
                  {envState.environments.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
                </select>
                {activeEnv?.baseURL && <span className="env-bar-base">{activeEnv.baseURL}</span>}
                <button
                  type="button"
                  className="env-bar-manage"
                  onClick={() => {
                    setEnvDraft(null)
                    setEnvManagerOpen(true)
                  }}
                >
                  Manage…
                </button>
                {/* F31: one plain-English coverage doc for the whole library. */}
                {savedTests.length > 0 && (
                  <button
                    type="button"
                    className="env-bar-manage"
                    onClick={handleSuiteDocs}
                    title="Suite docs: a plain-English coverage document across every saved test — what QA covers, with a ⚠ on tests that verify nothing"
                  >
                    📖 Suite docs
                  </button>
                )}
                {/* F31: acceptance-criteria checklist — enter ACs, see coverage gaps. */}
                <button
                  type="button"
                  className="env-bar-manage"
                  onClick={handleOpenAcChecklist}
                  title="AC checklist: enter your acceptance criteria and see which tests cover each — an uncovered AC is a coverage gap"
                >
                  ✅ AC checklist
                </button>
                {/* F32: promote saved tests to scheduled monitors + failure alerts. */}
                <button
                  type="button"
                  className={`env-bar-manage${monitors.some((m) => m.enabled) ? ' monitoring' : ''}`}
                  onClick={() => {
                    setMonTestSel('')
                    setMonHistoryFor(null)
                    setMonitorsOpen(true)
                  }}
                  title="Monitors: re-run a saved test on a schedule and get a desktop alert when it fails (runs while the app is open)"
                >
                  📡 Monitors{monitors.length ? ` (${monitors.length})` : ''}
                </button>
              </div>

              {/* A1 (scalable library): search + status filters, so a big library
                  stays navigable. Only shown once there are a few tests. */}
              {savedTests.length > 3 && (
                <div className="library-toolbar">
                  <input
                    className="library-search"
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="🔎 search tests by name…"
                    spellCheck={false}
                  />
                  <div className="library-filters">
                    {(['all', 'failing', 'passing', 'flaky'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`library-filter-chip${libraryFilter === f ? ' active' : ''}`}
                        onClick={() => setLibraryFilter(f)}
                      >
                        {f === 'all'
                          ? 'All'
                          : f === 'failing'
                            ? '✗ Failing'
                            : f === 'passing'
                              ? '✓ Passing'
                              : '⚡ Flaky'}
                      </button>
                    ))}
                    {/* F9 category drill-in, co-located with the status filters —
                        a quiet "by cause" toggle that expands the category chips
                        RIGHT HERE, beside the status chips (compose both without
                        jumping around the page). Only when something is failing. */}
                    {(() => {
                      const failing = savedTests.filter((t) => t.lastRun?.status === 'failed')
                      if (!failing.length) return null
                      const counts = new Map<string, number>()
                      for (const t of failing) {
                        const c = (t.lastRun?.category as string) || 'unknown'
                        counts.set(c, (counts.get(c) ?? 0) + 1)
                      }
                      const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
                      return (
                        <>
                          <button
                            type="button"
                            className={`library-filter-chip${breakdownOpen ? ' active' : ''}`}
                            onClick={() =>
                              setBreakdownOpen((o) => {
                                if (o) setFailureFilter(null) // collapsing clears the drill-in
                                return !o
                              })
                            }
                            title="Filter the failing tests by cause"
                          >
                            🩹 by cause {breakdownOpen ? '▾' : '▸'}
                          </button>
                          {breakdownOpen &&
                            ordered.map(([cat, n]) => (
                              <button
                                key={cat}
                                type="button"
                                className={`category-chip cat-${cat} breakdown-chip${
                                  failureFilter === cat ? ' active' : ''
                                }`}
                                onClick={() =>
                                  setFailureFilter((f) =>
                                    f === cat ? null : (cat as FailureCategory)
                                  )
                                }
                                title={`Show the ${n} test${n > 1 ? 's' : ''} that failed with "${
                                  CATEGORY_LABELS[cat as FailureCategory] ?? cat
                                }"`}
                              >
                                {CATEGORY_LABELS[cat as FailureCategory] ?? cat} <strong>{n}</strong>
                              </button>
                            ))}
                        </>
                      )
                    })()}
                    {anyLibraryFilter() && (
                      <button
                        type="button"
                        className="library-filter-clear"
                        onClick={() => {
                          setLibrarySearch('')
                          setLibraryFilter('all')
                          setFailureFilter(null)
                          setTagFilter(new Set()) // F38
                          // Collapses you made DURING a filter belonged to that
                          // filter — don't carry them into the unfiltered view.
                          setFilterCollapsed(new Set())
                        }}
                      >
                        clear ✕
                      </button>
                    )}
                    {/* A2: select every test currently matching the filters. */}
                    <button
                      type="button"
                      className="library-filter-clear"
                      onClick={() =>
                        setSelectedTests(
                          new Set(savedTests.filter(matchesLibraryFilters).map((t) => t.fileName))
                        )
                      }
                    >
                      select all{anyLibraryFilter() ? ' shown' : ''}
                    </button>
                  </div>
                  {/* F40: share the library. Exports whatever the filters/ticks
                      currently show — so "share the smoke suite" is just
                      filter by @smoke, then 📦 Export. */}
                  <div className="library-filters bundle-bar">
                    <button
                      type="button"
                      className="library-filter-clear"
                      disabled={bundleBusy}
                      onClick={handleExportBundle}
                      title="Export the tests currently shown (or ticked) as a portable folder you can commit to git or zip and send"
                    >
                      📦 Export bundle
                      {selectedTests.size
                        ? ` (${selectedTests.size} ticked)`
                        : anyLibraryFilter()
                          ? ' (shown)'
                          : ' (all)'}
                    </button>
                    <button
                      type="button"
                      className="library-filter-clear"
                      disabled={bundleBusy}
                      onClick={handleInspectBundle}
                      title="Import a bundle someone shared with you"
                    >
                      📥 Import bundle
                    </button>
                    {importDone && (
                      <span className="bundle-done">
                        ✓ {importDone}
                        <button type="button" className="tag-x" onClick={() => setImportDone(null)}>
                          ×
                        </button>
                      </span>
                    )}
                  </div>

                  {/* F39: parallel mode. Opt-in, and the note explains the
                      trade honestly — this is faster because it's a DIFFERENT
                      engine, not because the old one was wasting time. */}
                  <div className="library-filters parallel-bar">
                    <label className="parallel-toggle">
                      <input
                        type="checkbox"
                        checked={parallelMode}
                        onChange={(e) => setParallelMode(e.target.checked)}
                      />
                      ⚡ Run in parallel
                    </label>
                    {parallelMode && (
                      <>
                        <label className="parallel-workers">
                          workers
                          <input
                            type="number"
                            min={1}
                            max={16}
                            value={parallelWorkers}
                            onChange={(e) =>
                              setParallelWorkers(
                                Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 1))
                              )
                            }
                          />
                        </label>
                        <span className="parallel-hint">
                          Runs {parallelWorkers} tests at once through real Playwright, headless.{' '}
                          <strong>Not the in-app engine</strong> — no self-heal, no recovery pause.
                          Tests with AI checks, manual steps, a11y or visual snapshots run the
                          normal way instead (the report says which).
                        </span>
                      </>
                    )}
                  </div>
                  {/* F38: tag filters, on their own row so they don't crowd the
                      status chips. Only rendered once something IS tagged —
                      an empty filter row would just be clutter. */}
                  {(() => {
                    const tagList = allTags(savedTests)
                    if (!tagList.length) return null
                    return (
                      <div className="library-filters library-tagbar">
                        <span className="tagbar-label">Tags:</span>
                        {tagList.map(({ tag, count }) => (
                          <button
                            key={tag}
                            type="button"
                            className={`tag-chip filter${tagFilter.has(tag) ? ' active' : ''}`}
                            onClick={() =>
                              setTagFilter((prev) => {
                                const next = new Set(prev)
                                if (next.has(tag)) next.delete(tag)
                                else next.add(tag)
                                return next
                              })
                            }
                            title={`${count} test${count === 1 ? '' : 's'} tagged ${tag}`}
                          >
                            {tag} <strong>{count}</strong>
                          </button>
                        ))}
                        {tagFilter.size > 0 && (
                          <>
                            {/* The payoff: tick everything currently listed, then
                                ▶ Run selected. "Run all @smoke" without keeping a
                                second list of which tests those are.
                                Labelled "shown", NOT "@smoke": it ticks what the
                                WHOLE filter bar is showing — tags plus any search,
                                status or section drill-in. Naming it after the tags
                                alone promised 4 and delivered 1 the moment a search
                                was also active (Surbhi, Test 6). */}
                            <button
                              type="button"
                              className="library-filter-clear runtag"
                              onClick={() =>
                                setSelectedTests(
                                  new Set(
                                    savedTests
                                      .filter(matchesLibraryFilters)
                                      .map((t) => t.fileName)
                                  )
                                )
                              }
                              title="Tick every test currently shown — these tags plus any search, status or section filter — ready to ▶ Run selected"
                            >
                              ▶ select all shown
                            </button>
                            <button
                              type="button"
                              className="library-filter-clear"
                              onClick={() => setTagFilter(new Set())}
                            >
                              clear tags ✕
                            </button>
                          </>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* A2 (scalable library): bulk-action bar — appears once tests are
                  ticked. Run / delete the whole selection at once (the payoff of
                  the search + F9 category drill-in: operate on a group). */}
              {selectedTests.size > 0 && (
                <div className="library-bulkbar">
                  <span className="library-bulk-count">{selectedTests.size} selected</span>
                  <button type="button" className="library-bulk-btn" onClick={handleRunSelected}>
                    ▶ Run selected
                  </button>
                  <button
                    type="button"
                    className="library-bulk-btn danger"
                    onClick={handleDeleteSelected}
                  >
                    🗑 Delete
                  </button>
                  <button
                    type="button"
                    className="library-filter-clear"
                    onClick={() => setSelectedTests(new Set())}
                  >
                    clear ✕
                  </button>
                </div>
              )}

              {(() => {
                // Sections in display order: E2E + Daily always shown (even
                // empty, so they're discoverable), customs after, legacy
                // root-level tests last under "Unsorted".
                const groups = [...suites]
                for (const t of savedTests) {
                  if (t.suite && !groups.includes(t.suite)) groups.push(t.suite)
                }
                if (savedTests.some((t) => !t.suite)) groups.push('')
                return groups.map((suite) => {
                  // A1: search + status filter + F9 category drill-in, all ANDed.
                  const tests = savedTests
                    .filter((t) => t.suite === suite)
                    .filter(matchesLibraryFilters)
                  const suiteKey = suite || '(unsorted)'
                  const filtering = anyLibraryFilter()
                  // With any filter active, hide sections that have nothing to show,
                  // and force sections open so the matches are visible.
                  if (filtering && tests.length === 0) return null
                  const isOpen = filtering
                    ? !filterCollapsed.has(suiteKey)
                    : openSuites.has(suiteKey)
                  return (
                    <div key={suiteKey} className="library-section">
                      <div className="library-section-header">
                        {/* Tick the whole section. Sections were the one grouping
                            bulk actions couldn't reach: search/status/tags all
                            NARROW the list so "select all shown" can follow them,
                            but a section only expands — so with 58 tests the only
                            select-all ticked all 58 (Surbhi, Test 7).
                            Operates on `tests`, the section's tests AFTER filters,
                            so it means the same "all shown" as the top button.
                            Adds to the existing selection rather than replacing it,
                            so E2E + three extras works.
                            ONLY WHEN THE SECTION IS OPEN: on every collapsed header
                            it made a column of bright squares down the left edge —
                            an unchecked box ignores accent-color, so it reads as a
                            white block on a dark card — and it competed with the
                            caret and title for the start of the row. Collapsed is
                            also when you can't see what you'd be ticking. Open, it
                            sits directly above the row ticks it controls. */}
                        {isOpen && tests.length > 0 && (
                          <input
                            type="checkbox"
                            className="library-check section-check"
                            checked={tests.every((t) => selectedTests.has(t.fileName))}
                            ref={(el) => {
                              if (el) {
                                const n = tests.filter((t) => selectedTests.has(t.fileName)).length
                                el.indeterminate = n > 0 && n < tests.length
                              }
                            }}
                            onChange={() =>
                              setSelectedTests((prev) => {
                                const next = new Set(prev)
                                const all = tests.every((t) => next.has(t.fileName))
                                for (const t of tests) {
                                  if (all) next.delete(t.fileName)
                                  else next.add(t.fileName)
                                }
                                return next
                              })
                            }
                            title={`Select all ${tests.length} test${tests.length === 1 ? '' : 's'} in ${suite || 'Unsorted'}`}
                            aria-label={`Select all tests in ${suite || 'Unsorted'}`}
                          />
                        )}
                        <button
                          type="button"
                          className="section-toggle"
                          onClick={() => toggleSuite(suiteKey, filtering)}
                          aria-expanded={isOpen}
                          title={isOpen ? 'Collapse section' : 'Expand section'}
                        >
                          <span className="section-caret">{isOpen ? '▾' : '▸'}</span>
                          <span className="library-title">
                            {suite ? `${suite} test flows` : 'Unsorted'}
                          </span>
                          <span className="library-count">{tests.length}</span>
                          {/* Collapsed: one dot per test — suite health at a
                              glance without expanding */}
                          {!isOpen && tests.length > 0 && (
                            <span className="suite-health">
                              {tests.slice(0, 10).map((t) => (
                                <span
                                  key={t.fileName}
                                  className={`history-dot ${t.lastRun?.status ?? 'none'}`}
                                  title={`${t.name}: ${t.lastRun ? `last replay ${t.lastRun.status}` : 'never replayed'}`}
                                />
                              ))}
                              {tests.length > 10 && (
                                <span className="suite-health-more">+{tests.length - 10}</span>
                              )}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="run-suite-btn"
                          onClick={() => handleRunSuite(suite || 'Unsorted', tests)}
                          disabled={tests.length === 0}
                          title={
                            tests.length === 0
                              ? 'No tests in this section yet'
                              : `Replay all ${tests.length} test(s) in ${suite || 'Unsorted'}`
                          }
                        >
                          ▶ Run all
                        </button>
                      </div>
                      {!isOpen ? null : tests.length === 0 ? (
                        <p className="library-empty">No tests yet — save one with 💾</p>
                      ) : (
                        <ul className="library-list">
                          {tests.map((test) => {
                            // Every recorded run (newest-first). Older files kept
                            // only `lastRun`; treat that as a one-run history.
                            const allRuns =
                              test.runs && test.runs.length
                                ? test.runs
                                : test.lastRun
                                  ? [test.lastRun]
                                  : []
                            // Each failure can be a DIFFERENT error at a different
                            // time — keep them all so the user sees why AND when.
                            const failedRuns = allRuns.filter((r) => r.status === 'failed')
                            const currentlyFailing = test.lastRun?.status === 'failed'
                            // F2: one-word trust verdict from the run history.
                            const flaky = classifyRuns(allRuns)
                            // F5: composite 0–100 trust score (grade A–F).
                            const trust = trustScore(test, Date.now())
                            return (
                              <li key={test.fileName} className="library-item">
                                <div className="library-item-head">
                                  {/* A2: tick for a bulk action (run / delete). */}
                                  <input
                                    type="checkbox"
                                    className="library-check"
                                    checked={selectedTests.has(test.fileName)}
                                    onChange={() => toggleSelect(test.fileName)}
                                    title="Select for a bulk action (run / delete)"
                                    aria-label={`Select ${test.name}`}
                                  />
                                  <button
                                    type="button"
                                    className="library-row"
                                    onClick={() => handleLoadTest(test.fileName)}
                                    title={`Open "${test.name}"`}
                                  >
                                    <span
                                      className={`run-dot ${test.lastRun?.status ?? 'none'}`}
                                      title={
                                        test.lastRun
                                          ? `Last replay ${test.lastRun.status} — ${new Date(test.lastRun.at).toLocaleString()}`
                                          : 'Never replayed'
                                      }
                                    />
                                    <span className="library-name">{test.name}</span>
                                    {/* F2: last runs, NEWEST-FIRST (leftmost = most
                                        recent, next to the status dot) so the trend
                                        can't be read backwards. */}
                                    {test.runs && test.runs.length > 1 && (
                                      <span
                                        className="history-dots"
                                        title="Recent runs — leftmost is the most recent, going back in time to the right"
                                      >
                                        {test.runs.map((run, i) => (
                                          <span
                                            key={i}
                                            className={`history-dot ${run.status}${i === 0 ? ' newest' : ''}`}
                                            title={`${i === 0 ? 'most recent · ' : ''}${run.status} — ${new Date(run.at).toLocaleString()}`}
                                          />
                                        ))}
                                      </span>
                                    )}
                                    {/* F2: the one-word trust verdict (flaky / newly-broken / …). */}
                                    {flaky.tag !== 'untested' && (
                                      <span
                                        className={`flaky-tag ${flaky.tag}`}
                                        title={flaky.title}
                                      >
                                        {flaky.label}
                                      </span>
                                    )}
                                    {/* F5: composite trust grade + score, breakdown on hover. */}
                                    <span
                                      className={`trust-badge grade-${trust.grade}`}
                                      title={
                                        `Trust score ${trust.score}/100 (grade ${trust.grade}) — how much to trust this test:\n` +
                                        trust.factors
                                          .map((f) => `• ${f.label} ${f.score}/100 — ${f.note}`)
                                          .join('\n')
                                      }
                                    >
                                      {trust.grade} · {trust.score}
                                    </span>
                                    {/* F38: this test's labels, clickable to filter
                                        the library down to them. */}
                                    {(test.tags ?? []).map((tag) => (
                                      <span
                                        key={tag}
                                        className={`tag-chip row${tagFilter.has(tag) ? ' active' : ''}`}
                                        onClick={(e) => {
                                          // The whole row is a button that OPENS the
                                          // test — stop the click so tapping a tag
                                          // filters instead of navigating away.
                                          e.stopPropagation()
                                          setTagFilter((prev) => {
                                            const next = new Set(prev)
                                            if (next.has(tag)) next.delete(tag)
                                            else next.add(tag)
                                            return next
                                          })
                                        }}
                                        title={`Filter the library to ${tag}`}
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    <span className="library-meta">
                                      {test.stepCount} steps ·{' '}
                                      {new Date(test.updatedAt).toLocaleDateString()}
                                    </span>
                                  </button>
                                  {/* Any failure — current OR past — is inspectable
                                  here. A test that passes now but failed before
                                  gets a calmer "Past fail(s)" label so it doesn't
                                  read as currently broken. */}
                                  {failedRuns.length > 0 && (
                                    <button
                                      type="button"
                                      className={`library-why${errorOpenFor === test.fileName ? ' open' : ''}${currentlyFailing ? '' : ' past'}`}
                                      onClick={() =>
                                        setErrorOpenFor(
                                          errorOpenFor === test.fileName ? null : test.fileName
                                        )
                                      }
                                      title={
                                        currentlyFailing ? 'Why did it fail?' : 'Past failures'
                                      }
                                    >
                                      ⚠{' '}
                                      {failedRuns.length > 1
                                        ? `${failedRuns.length} fails`
                                        : currentlyFailing
                                          ? 'Why?'
                                          : 'Past fail'}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="library-clone"
                                    onClick={() => handleCloneTest(test)}
                                    title={`Clone "${test.name}" into an editable copy`}
                                    aria-label={`Clone ${test.name}`}
                                  >
                                    ⧉
                                  </button>
                                  <button
                                    type="button"
                                    className="library-delete"
                                    onClick={() => handleDeleteTest(test)}
                                    title="Delete test"
                                    aria-label={`Delete ${test.name}`}
                                  >
                                    ✕
                                  </button>
                                </div>
                                {errorOpenFor === test.fileName && failedRuns.length > 0 && (
                                  <div className="run-error-detail">
                                    {/* One entry per failed run — each shows WHEN it
                                      failed and WHY (the errors can differ run to
                                      run), with a jump to that run's screenshot. */}
                                    {failedRuns.map((run, ri) => (
                                      <div key={ri} className="run-fail-entry">
                                        <div className="run-fail-when">
                                          {new Date(run.at).toLocaleString()}
                                          {run.failedAt !== undefined
                                            ? ` · step ${run.failedAt + 1}`
                                            : ''}
                                        </div>
                                        <div className="run-error-msg">
                                          {run.error || 'No error message was recorded.'}
                                        </div>
                                        <div className="run-fail-actions">
                                          {run.screenshotPath && (
                                            <button
                                              type="button"
                                              className="run-error-shot"
                                              onClick={() =>
                                                window.api.library.openScreenshot(
                                                  run.screenshotPath!
                                                )
                                              }
                                            >
                                              📷 View failure screenshot
                                            </button>
                                          )}
                                          {run.traceId && (
                                            <button
                                              type="button"
                                              className="run-error-shot"
                                              onClick={() => openTrace(run.traceId!)}
                                            >
                                              ⏺ Open recording
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )
                })
              })()}

              {/* A1: nothing matches the active search/filter. */}
              {anyLibraryFilter() && savedTests.filter(matchesLibraryFilters).length === 0 && (
                <div className="library-no-match">
                  No tests match{librarySearch.trim() ? ` “${librarySearch.trim()}”` : ''}
                  {libraryFilter !== 'all' ? ` · ${libraryFilter}` : ''}
                  {failureFilter ? ` · ${CATEGORY_LABELS[failureFilter] ?? failureFilter}` : ''}.
                </div>
              )}

            </div>
          )}
        </div>
      </div>
    )
  }

  // === Chrome view — shown once user has navigated ===
  return (
    <div className="app">
      {/* Day 16(+): download confirmation toast — auto-clears after a few sec.
          Three states: ok (has content), empty (downloaded but 0 bytes), and
          failed (transfer didn't finish). */}
      {downloadToast &&
        (() => {
          if (downloadToast.phase === 'downloading') {
            return (
              <div className="download-toast progress">⬇ Downloading {downloadToast.name}…</div>
            )
          }
          const empty = downloadToast.completed && downloadToast.bytes <= 0
          const tone = !downloadToast.completed ? 'fail' : empty ? 'warn' : 'ok'
          const message = !downloadToast.completed
            ? `✗ Download failed: ${downloadToast.name}`
            : empty
              ? `⚠ Downloaded ${downloadToast.name}, but it's empty (0 bytes)`
              : `✓ Downloaded ${downloadToast.name} — ${formatBytes(downloadToast.bytes)}`
          return <div className={`download-toast ${tone}`}>{message}</div>
        })()}
      {/* F15: re-capture baseline progress (runs after the snapshot modal closes,
          so it can't live in the modal). Same top-right toast, safe over the pane. */}
      {snapToast && (
        <div
          className={`download-toast ${snapToast === 'busy' ? 'progress' : snapToast === 'ok' ? 'ok' : 'fail'}`}
        >
          {snapToast === 'busy'
            ? '📸 Re-capturing baseline…'
            : snapToast === 'ok'
              ? '✓ Baseline re-captured with these settings'
              : '⚠ Could not re-capture baseline (is the page loaded?)'}
        </div>
      )}
      {/* F18: AI step-generation progress (runs after the AI modal closes, so the
          browser can be read without flashing over it). Same top-right toast. */}
      {aiToast && <div className={`download-toast ${aiToast.tone}`}>{aiToast.msg}</div>}
      <div className="chrome">
        {/* Row 1 — the browser: navigation, URL bar, and the primary Record action. */}
        <div className="chrome-row browser">
          <button className="nav-btn" onClick={handleBack} title="Back" aria-label="Back">
            ←
          </button>
          <button
            className="nav-btn"
            onClick={() => window.api.browser.goForward()}
            title="Forward"
            aria-label="Forward"
          >
            →
          </button>
          <button
            className="nav-btn"
            onClick={() => window.api.browser.reload()}
            title="Reload"
            aria-label="Reload"
          >
            ⟳
          </button>
          <button className="nav-btn" onClick={handleHome} title="Home" aria-label="Home">
            ⌂
          </button>
          <button
            className="nav-btn"
            onClick={() => window.api.browser.clearData()}
            title="Clear cookies & site data (log out, empty cart) and reload"
            aria-label="Clear browser data"
          >
            🧹
          </button>
          <form className="url-form" onSubmit={handleSubmit}>
            <input
              className="url-input"
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Enter URL or domain..."
              spellCheck={false}
            />
            <button type="submit" className="go-btn">
              Go
            </button>
          </form>
          {/* F36: the device belongs HERE, next to the URL, not buried in the
              save panel. The save panel only opens once a test has steps — so
              until Surbhi hit this, there was NO WAY to choose a device before
              recording. That's backwards for the whole point of mobile testing:
              a responsive site shows different elements at phone width (a
              hamburger where desktop has a nav bar), so recording desktop-first
              captures selectors for elements the mobile layout doesn't have.
              This is also where a browser puts device mode, so it's where you'd
              look. The save panel keeps its copy — they share `deviceId`. */}
          <select
            className="device-select"
            value={deviceId ?? (viewport ? 'custom' : 'desktop')}
            disabled={isRecording || isReplaying}
            title="Render the page as this device — set it BEFORE recording so you capture the right layout"
            onChange={(e) => {
              const v = e.target.value
              applyDevice(v === 'desktop' ? undefined : v)
            }}
          >
            <option value="desktop">🖥 Desktop</option>
            {DEVICES.filter((d) => d.group === 'Basic').map((d) => (
              <option key={d.id} value={d.id}>
                {d.label.replace(' (size only)', ' (size)')}
              </option>
            ))}
            {DEVICES.filter((d) => d.group !== 'Basic').map((d) => (
              <option key={d.id} value={d.id}>
                {d.group === 'Tablet' ? '📲' : '📱'} {d.label}
              </option>
            ))}
            {/* A pre-F36 test carries a bare viewport and no device id — show it
                rather than silently displaying "Desktop" while it isn't. */}
            {!deviceId && viewport && (
              <option value="custom">
                🖥 {viewport.width}×{viewport.height} (size)
              </option>
            )}
          </select>
          <button
            className={`record-btn${isRecording ? ' recording' : ''}`}
            onClick={handleRecordToggle}
            title={
              isRecording
                ? 'Stop recording'
                : steps.length > 0
                  ? 'Resume recording — new steps are added to the end'
                  : 'Start recording'
            }
          >
            <span className="record-dot" />
            {isRecording ? 'Stop' : steps.length > 0 ? 'Resume' : 'Record'}
          </button>
        </div>

        {/* Row 2 — the QA tool belt, grouped by job: Author · Analyze · Network. */}
        <div className="chrome-row tools">
          {/* Author / capture a test. */}
          <div className="tool-group">
            <button
              className={`check-btn${isPicking ? ' picking' : ''}`}
              onClick={() => (isPicking ? handleCancelPick() : handleStartPick(null))}
              disabled={isReplaying}
              title={
                isPicking
                  ? 'Cancel picking (or press Esc)'
                  : 'Add a check: pick an element on the page'
              }
            >
              ✓ {isPicking ? 'Picking…' : 'Check'}
            </button>
            {/* F18: type an intent, get draft steps grounded to the current page. */}
            <button
              className="snapshot-btn"
              onClick={() => {
                setAiPromptText('')
                setAiPromptNote('')
                setAiPromptOpen(true)
              }}
              disabled={isReplaying || isPicking}
              title="AI step: describe what to do in plain English (e.g. 'log in as standard_user') and get draft steps for the current page"
            >
              🪄 AI step
            </button>
            {/* F22: turn a user story / PR diff into a draft test (no page needed). */}
            <button
              className="snapshot-btn"
              onClick={() => {
                setDraftStory('')
                setDraftDiff(null)
                setDraftResult(null)
                setDraftNote('')
                setDraftOpen(true)
              }}
              disabled={isReplaying || isPicking}
              title="Draft a whole test from a user story (or a PR diff from the app's local repo): navigations + real AI checks, with plain-English actions you ground by recording over them."
            >
              📝 Draft
            </button>
            {/* Day 19: capture the current page as a visual baseline. */}
            <button
              className="snapshot-btn"
              onClick={() => window.api.recorder.snapshot()}
              disabled={isReplaying || isPicking}
              title="Visual snapshot: capture how the page looks now as a baseline; replay flags any visual change"
            >
              📸 Snapshot
            </button>
          </div>

          {/* Analyze / inspect the current page. */}
          <div className="tool-group">
            {/* F21: paste a bug's repro + expected → a regression test (repro + a check). */}
            <button
              className="snapshot-btn"
              onClick={() => {
                setBugReproText('')
                setBugExpectedText('')
                setBugPromptOpen(true)
              }}
              disabled={isReplaying || isPicking}
              title="Turn a bug's repro + expected result into steps + a smart AI check for the page you're on. Covers this one page — for a multi-page bug, run it on each page."
            >
              🐛 Bug check
            </button>
            {/* F13: scan the current page for WCAG A/AA accessibility violations. */}
            <button
              className="a11y-btn"
              onClick={handleA11yScan}
              disabled={isReplaying || isPicking || a11yScanning}
              title="Accessibility scan: check this page for WCAG A/AA violations (missing labels, contrast, ARIA, keyboard traps)"
            >
              ♿ {a11yScanning ? 'Scanning…' : 'A11y'}
            </button>
            {/* F14: measure the current page's Core Web Vitals (LCP, CLS, …). */}
            <button
              className="perf-btn"
              onClick={handleMeasurePerf}
              disabled={isReplaying || isPicking || perfMeasuring}
              title="Performance: measure this page's Core Web Vitals (load speed, layout stability)"
            >
              ⚡ {perfMeasuring ? 'Measuring…' : 'Perf'}
            </button>
            {/* F23: crawl the app from here and overlay tested vs untested pages. */}
            <button
              className="a11y-btn"
              onClick={handleCoverageCrawl}
              disabled={isReplaying || isPicking || isRecording || coverageRun?.running}
              title="Coverage map: crawl the app from this page and show which pages your tests cover — untested pages are gaps. It walks the links (moving the browser around) then returns you here."
            >
              🗺️ {coverageRun?.running ? 'Crawling…' : 'Coverage'}
            </button>
          </div>

          {/* Network: capture responses, then mock them. */}
          <div className="tool-group">
            {/* F1: capture network into a HAR while recording (opt-in flake-killer). */}
            <button
              className={`har-btn${captureNetwork ? ' on' : ''}`}
              onClick={() => setCaptureNetwork((v) => !v)}
              disabled={isReplaying}
              title={
                captureNetwork
                  ? 'Network capture is ON — while recording, API responses are saved to a standard .har file with the test (openable in Chrome DevTools; usable with Playwright routeFromHAR). Click to turn off.'
                  : 'Capture network (HAR): while recording, save API responses to a .har file with the test — a standard archive for deterministic replay. Click to turn on.'
              }
            >
              🌐 {harCount > 0 ? `Net · ${harCount}` : captureNetwork ? 'Net ON' : 'Net'}
            </button>
            {/* F35: turn a captured response into a scenario mock + Playwright route. */}
            <button
              className="snapshot-btn"
              onClick={openMockStudio}
              disabled={isReplaying || isPicking || harCount === 0}
              title={
                harCount === 0
                  ? 'Mock Studio: record a flow with 🌐 Net capture ON first, then edit a captured response into a scenario (sold-out, a 500, an empty list) and export the Playwright mock.'
                  : 'Mock Studio: edit a captured API response into a scenario (sold-out, a 500, an empty list) and export the Playwright route/fulfill.'
              }
            >
              🎭 Mock
            </button>
          </div>
        </div>
      </div>

      {/* F1: the HAR status chips used to sit HERE, between the toolbar and the
          browser area — where the native WebContentsView paints over them. main
          positions that view at CHROME_HEIGHT (+ the tab strip) and knows nothing
          about any other band, so this bar was invisible the entire time a page
          was loaded, which is every moment it had something to say. Moved into
          the steps panel, which the native view never covers (it stops at
          width - PANEL_WIDTH). See the har-status block below. */}

      {/* Day 17: the tab strip — shown only with 2+ tabs (a popup opened one).
          Its height must match TAB_STRIP_HEIGHT in main so the native browser
          view, which starts just below it, lines up exactly. */}
      {tabs.length > 1 && (
        <div className="tab-strip">
          {tabs.map((t) => (
            <div
              key={t.ordinal}
              className={`browser-tab${t.active ? ' active' : ''}`}
              onClick={() => window.api.browser.switchTab(t.ordinal)}
              title={t.url}
            >
              <span className="browser-tab-title">{t.title || 'New Tab'}</span>
              {t.ordinal > 0 && (
                <button
                  className="browser-tab-close"
                  title="Close tab"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    window.api.browser.closeTab(t.ordinal)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The native embedded browser is painted OVER this area, so anything in
          here is invisible while the page is showing. It becomes visible at
          exactly one moment: when a modal opens and main shrinks the native view
          to nothing (browser:setOverlay) so it can't cover the dialog. Before,
          that left a large flat #1e1e1e void that read as "the app broke" —
          Surbhi kept a screenshot of it titled "back ground goes black". The
          page is still loaded the whole time; this just says so. */}
      <div className="workspace">
        <div className="browser-area">
          {/* Anchored to the TOP, not centred: modals are vertically centred, so
              a centred note sits directly behind the dialog and only its ends
              poke out — which looks like a rendering fault, not a message. */}
          <div className="browser-hidden-note">
            🗔 Page hidden while this dialog is open
            {(urlInput || baseURL) && (
              <span className="browser-hidden-url">{urlInput || baseURL}</span>
            )}
          </div>
        </div>
        <aside className="steps-panel">
          {/* === Day 11: current test identity (name + editable base URL) ===
              Show for an UNSAVED recording too (any steps) — otherwise the env
              switcher / base URL below are unreachable until you save, which is the
              one time you most need to point a fresh recording at an environment. */}
          {(testName || steps.length > 0) && (
            <div className="test-bar">
              {testSuite && <span className="test-suite-tag">{testSuite}</span>}
              <span
                className={`test-name${testName ? '' : ' unnamed'}`}
                title={testName || 'Unsaved recording — save to give it a name'}
              >
                {testName || 'Untitled recording'}
              </span>
              {editingBase ? (
                <input
                  className="test-base-input"
                  value={baseEditValue}
                  onChange={(e) => setBaseEditValue(e.target.value)}
                  onBlur={handleCommitBaseURL}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitBaseURL()
                    else if (e.key === 'Escape') setEditingBase(false)
                  }}
                  autoFocus
                  spellCheck={false}
                />
              ) : (
                <button
                  type="button"
                  className="test-base"
                  onClick={() => {
                    setBaseEditValue(baseURL)
                    setEditingBase(true)
                  }}
                  title="Base URL — click to edit. Changing it retargets every navigation step (e.g. staging vs production)."
                >
                  {baseURL || 'no base URL'}
                </button>
              )}
              {/* F25: a live badge of the environment this test will run against.
                  Click to SWITCH the active environment right here — no trip to the
                  welcome screen (which would drop an unsaved recording). Green when an
                  env is active so it's obvious you're NOT running the recorded URLs. */}
              <div className="test-env-switch">
                <button
                  type="button"
                  className={`test-env-chip${activeEnv ? ' active' : ''}`}
                  onClick={() => setEnvSwitchOpen((v) => !v)}
                  title={
                    activeEnv
                      ? `Running against "${activeEnv.name}" (${activeEnv.baseURL || 'no base URL'}). Click to switch environment.`
                      : 'Running against the recorded URLs. Click to switch environment.'
                  }
                >
                  🌐 {activeEnv ? activeEnv.name : 'recorded URLs'} ▾
                </button>
                {envSwitchOpen && (
                  <>
                    <div
                      className="env-switch-backdrop"
                      onClick={() => setEnvSwitchOpen(false)}
                    />
                    <div className="env-switch-menu" role="menu">
                      <button
                        type="button"
                        className={`env-switch-item${!activeEnv ? ' current' : ''}`}
                        onClick={() => {
                          setActiveEnv(null)
                          setEnvSwitchOpen(false)
                        }}
                      >
                        <span className="env-switch-check">{!activeEnv ? '✓' : ''}</span>
                        Recorded URLs (default)
                      </button>
                      {envState.environments.map((env) => (
                        <button
                          key={env.id}
                          type="button"
                          className={`env-switch-item${activeEnv?.id === env.id ? ' current' : ''}`}
                          onClick={() => {
                            setActiveEnv(env.id)
                            setEnvSwitchOpen(false)
                          }}
                          title={env.baseURL || 'no base URL'}
                        >
                          <span className="env-switch-check">
                            {activeEnv?.id === env.id ? '✓' : ''}
                          </span>
                          {env.name}
                        </button>
                      ))}
                      <div className="env-switch-sep" />
                      <button
                        type="button"
                        className="env-switch-item manage"
                        onClick={() => {
                          setEnvSwitchOpen(false)
                          setEnvDraft(null)
                          setEnvManagerOpen(true)
                        }}
                      >
                        ⚙ Manage environments…
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="steps-header">
            <span className="steps-title">
              Steps
              {steps.length > 0 && <span className="steps-count">{steps.length}</span>}
              {/* F6: how many assertions verify little/nothing — a nudge to strengthen them. */}
              {weakByIndex.size > 0 && (
                <span
                  className="weak-summary"
                  title="Some checks verify little or nothing (dead/weak assertions). Each is marked in the list below — hover it for why + how to fix."
                >
                  ⚠ {weakByIndex.size} weak check{weakByIndex.size === 1 ? '' : 's'}
                </span>
              )}
            </span>
            {/* Empty test: still offer Blocks, so you can START a test by
                inserting a saved block (e.g. "Add to Cart") as the first steps. */}
            {steps.length === 0 && !isRecording && (
              <div className="steps-actions">
                <button
                  className="data-btn"
                  onClick={() => openBlocksPanel(null)}
                  title="Insert a saved block to start this test"
                >
                  🧩 Blocks
                </button>
              </div>
            )}
            {steps.length > 0 && (
              <div className="steps-actions">
                <button
                  className="replay-btn"
                  onClick={handleReplay}
                  disabled={isReplaying || isRecording || enabledCount === 0}
                  title="Replay these steps in the browser"
                >
                  ▶ {isReplaying ? 'Replaying…' : 'Replay'}
                </button>
                {/* F21b: ride the whole flow once and drop a plain-English check
                    on each page it lands on — a check per page in one pass. */}
                <button
                  className="data-btn"
                  onClick={handleReplayAlongChecks}
                  disabled={isReplaying || isRecording || isPicking || enabledCount === 0}
                  title="Add checks along a replay: replays the whole flow once and pauses on each page so you can add a plain-English check for it — a check per page in one pass, no re-typing. (For a multi-page bug this is the fast path vs. 🐛 Bug check, which does one page at a time.)"
                >
                  🐛➰ Ride + checks
                </button>
                {/* Day 18: when to keep a full run recording (trace), like
                    Playwright's trace: retain-on-failure. */}
                <select
                  className="trace-mode"
                  value={traceMode}
                  onChange={(e) => setTraceMode(e.target.value as 'always' | 'failure' | 'off')}
                  disabled={isReplaying || isRecording}
                  title="When to keep a full run recording (every step's screenshot, console & network)"
                >
                  <option value="failure">⏺ on failure</option>
                  <option value="always">⏺ always</option>
                  <option value="off">⏺ off</option>
                </select>
                {/* F29 (chaos): replay under a throttled network to test resilience. */}
                <button
                  className={`data-btn${chaosSlowNet ? ' active' : ''}`}
                  onClick={() => setChaosSlowNet((v) => !v)}
                  disabled={isReplaying || isRecording}
                  title="Chaos: replay under a throttled (~Slow 3G) network — surfaces timing flakiness and tests the app under load. (Slow network only; error/500 injection is deferred — see notes.)"
                >
                  🐢 Slow net{chaosSlowNet ? ' ✓' : ''}
                </button>
                {/* Day 20: open the data-driven table (run the flow per row) */}
                <button
                  className={`data-btn${isDataDriven ? ' active' : ''}`}
                  onClick={() => setDataPanelOpen((o) => !o)}
                  disabled={isReplaying || isRecording}
                  title="Data-driven runs: run this flow once per row of a data table"
                >
                  🧪 Data{isDataDriven && dataRows.length > 0 ? ` (${dataRows.length})` : ''}
                </button>
                {/* F20: explode the happy path into empty/boundary/invalid/injection variants */}
                <button
                  className="data-btn"
                  onClick={handleOpenEdgeModal}
                  disabled={isReplaying || isRecording}
                  title="Edge cases: auto-generate empty / boundary / invalid / injection variants of your inputs and run them — negative testing without hand-writing 20 cases"
                >
                  🧨 Edge cases
                </button>
                {/* F28: run the flow under several locales; flag overflow / RTL / untranslated */}
                <button
                  className="data-btn"
                  onClick={() => setLocaleOpen(true)}
                  disabled={isReplaying || isRecording || steps.length === 0}
                  title="Localization sweep: replay the flow under several languages and flag text overflow, RTL layout, and strings that never got translated"
                >
                  🌐 Locales
                </button>
                {/* F17: run the current test on real WebKit / Firefox / Chromium */}
                <button
                  className="data-btn"
                  onClick={handleOpenXbrowser}
                  disabled={isReplaying || isRecording}
                  title="Cross-browser: run this test on real Chromium + Firefox + WebKit via Playwright (the embedded engine is Chromium only)"
                >
                  🧭 Cross-browser
                </button>
                {/* F32: the monitors dashboard, reachable from the workspace too.
                    NOT disabled while a replay or batch runs — unlike the buttons
                    around it, this one never touches the loaded test, and the one
                    moment you most need it (a scheduled run firing during a long
                    batch) is exactly when everything else is disabled. */}
                <button
                  className={`data-btn${monitors.some((m) => m.enabled) ? ' monitoring' : ''}`}
                  onClick={() => {
                    setMonTestSel('')
                    setMonHistoryFor(null)
                    setMonitorsOpen(true)
                  }}
                  title="Monitors: scheduled re-runs of saved tests, with failure alerts (runs while the app is open)"
                >
                  📡 Monitors{monitors.length ? ` (${monitors.length})` : ''}
                </button>
                {/* Pillar 4: save/insert reusable step blocks */}
                <button
                  className="data-btn"
                  onClick={() => openBlocksPanel(null)}
                  disabled={isReplaying || isRecording}
                  title="Reusable step blocks: save these steps as a block, or insert a saved one"
                >
                  🧩 Blocks
                </button>
                {/* F12: past edits of this test — shown once it has history. */}
                {testVersions.length > 0 && (
                  <button
                    className="data-btn"
                    onClick={() => {
                      setHistoryIdx(0)
                      setHistoryOpen(true)
                    }}
                    disabled={isReplaying || isRecording}
                    title="History: see what changed in this test across edits, and roll back"
                  >
                    🕘 History ({testVersions.length})
                  </button>
                )}
                <button
                  className="export-btn"
                  onClick={handleExport}
                  title="Export as Playwright test"
                >
                  {'</>'} Export
                </button>
                <button
                  className="save-test-btn"
                  onClick={handleOpenSavePanel}
                  disabled={isReplaying || isRecording}
                  title={testName ? `Save changes to "${testName}"` : 'Save test to library'}
                  aria-label="Save test"
                >
                  💾
                </button>
                <button
                  className="clear-btn"
                  onClick={handleClearSteps}
                  disabled={isReplaying || isRecording}
                  title="Clear all steps and start over"
                  aria-label="Clear all steps"
                >
                  🗑
                </button>
              </div>
            )}
          </div>
          {/* Day 11.5: suite-run progress line ("test 2 of 5") */}
          {suiteRun?.running && (
            <div className="replay-status running">
              {suiteRun.parallelBatch ? (
                <>
                  Running {suiteRun.parallelBatch} test
                  {suiteRun.parallelBatch === 1 ? '' : 's'} at once, {parallelWorkers} at a time…
                </>
              ) : (
                <>
                  Running section {suiteRun.suite} — test {suiteRun.current} of {suiteRun.total}
                  {suiteRun.currentName ? `: ${suiteRun.currentName}` : ''}
                </>
              )}
            </div>
          )}
          {/* Day 20: data-driven run progress ("row 2 of 5: locked_out_user") */}
          {dataRun?.running && (
            <div className="replay-status running">
              Running row {dataRun.current} of {dataRun.total}
              {dataRun.currentLabel ? `: ${dataRun.currentLabel}` : ''}
            </div>
          )}
          {/* F20: edge-case batch progress — shown inline (not a modal) so the
              browser stays visible and you watch each variant run. The full
              report modal opens once the batch finishes. */}
          {edgeRun?.running && (
            <div className="replay-status running">
              🧨 Edge case {edgeRun.current} of {edgeRun.total}
              {edgeRun.currentLabel ? `: ${edgeRun.currentLabel}` : ''}
            </div>
          )}
          {/* F28: localization sweep progress. */}
          {localeRun?.running && (
            <div className="replay-status running">
              🌐 Locale {localeRun.current} of {localeRun.total}
              {localeRun.currentLabel ? `: ${localeRun.currentLabel}` : ''}
            </div>
          )}
          {/* F20 (Option 2): past edge-case batches for this test — re-open the
              report (verdicts + 📷 + 🎬) any time, even after restarting the app.
              A just-finished run on an UNSAVED test shows as a session-only row. */}
          {!edgeRun?.running &&
            (edgeRunHistory.length > 0 ||
              (!!edgeRun && !edgeViewingHistory && !testFileName)) && (
              <div className="edge-history">
                <span className="edge-history-label">🧨 Edge runs</span>
                {!!edgeRun && !edgeViewingHistory && !testFileName && (
                  <div className="edge-history-row">
                    <button
                      className="edge-history-open"
                      onClick={() => setEdgeReportOpen(true)}
                      title="Re-open this session's edge-case report (save the test to keep it across restarts)"
                    >
                      <span className="edge-hist-when">current run · unsaved</span>
                      <span className="edge-hist-ok">
                        {edgeRun.results.filter((r) => !r.case.baseline).length} variants
                      </span>
                    </button>
                    <button
                      className="edge-hist-del"
                      onClick={() => {
                        setEdgeReportOpen(false)
                        setEdgeRun(null)
                      }}
                      title="Discard this unsaved run"
                      aria-label="Discard edge run"
                    >
                      🗑
                    </button>
                  </div>
                )}
                {edgeRunHistory.map((h) => (
                  <div key={h.id} className="edge-history-row">
                    <button
                      className="edge-history-open"
                      onClick={() => handleOpenEdgeRun(h.id)}
                      title="Re-open this edge-case report — verdicts, screenshots and recordings"
                    >
                      <span className="edge-hist-when">{new Date(h.at).toLocaleString()}</span>
                      <span className={h.acceptedCount ? 'edge-hist-warn' : 'edge-hist-ok'}>
                        {h.acceptedCount
                          ? `⚠ ${h.acceptedCount} accepted`
                          : `✓ ${h.variantCount} rejected`}
                      </span>
                    </button>
                    <button
                      className="edge-hist-del"
                      onClick={() => handleDeleteEdgeRun(h.id)}
                      title="Delete this edge run and its recordings"
                      aria-label="Delete edge run"
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}
          {/* Day 20: after a data run, the banner summarizes the whole MATRIX
              (all rows) and reopens the per-row summary — not just the last
              row, which the single-run banner would otherwise show. */}
          {dataRun && !dataRun.running ? (
            (() => {
              const failedRows = dataRun.results.filter((r) => r.status === 'failed')
              // Rows that actually CAPTURED something — drives whether the
              // Screenshots & recordings tab appears at all. With "⏺ on failure"
              // an all-pass run captures nothing, so the tab is hidden; "⏺ always"
              // records every row, so it shows all of them.
              const evidenceRows = dataRun.results.filter((r) => r.screenshotPath || r.traceId)
              // Screenshots are only captured on FAILURE; a passing row (Always
              // mode) has just a recording. So label the tab by what's actually
              // there — "Recordings" when no row failed, not "Screenshots &…".
              const hasShots = evidenceRows.some((r) => r.screenshotPath)
              // Rows with a kept recording — each can produce a whole-run HTML
              // report (pass or fail). Drives the dedicated Reports tab.
              const reportRows = dataRun.results.filter((r) => r.traceId)
              const tone = failedRows.length ? 'failed' : 'passed'
              const plural = dataRun.total === 1 ? '' : 's'
              const toggle = (tab: 'evidence' | 'explain' | 'reports'): void =>
                setDataTab(dataTab === tab ? null : tab)
              return (
                <div className="data-result">
                  <div className={`replay-status ${tone}`}>
                    {failedRows.length
                      ? `✗ ${failedRows.length} of ${dataRun.total} row${plural} failed`
                      : `✓ All ${dataRun.total} row${plural} passed`}
                    {/* Day 20: two tabs, expanded INLINE below (not a modal).
                        Each appears only when it has something to show. */}
                    {evidenceRows.length > 0 && (
                      <button
                        type="button"
                        className={`data-tab${dataTab === 'evidence' ? ' active' : ''}`}
                        onClick={() => toggle('evidence')}
                        title={
                          hasShots
                            ? "Each captured row's screenshot and run recording"
                            : "Each captured row's run recording"
                        }
                      >
                        {hasShots ? '📷 Screenshots & recordings' : '⏺ Recordings'}
                      </button>
                    )}
                    {reportRows.length > 0 && (
                      <button
                        type="button"
                        className={`data-tab${dataTab === 'reports' ? ' active' : ''}`}
                        onClick={() => toggle('reports')}
                        title="Save each row's whole-run HTML report (pass or fail) — prints to PDF"
                      >
                        📄 Reports
                      </button>
                    )}
                    {failedRows.length > 0 && (
                      <button
                        type="button"
                        className={`data-tab${dataTab === 'explain' ? ' active' : ''}`}
                        onClick={() => toggle('explain')}
                        title="Explain each failed row, one by one"
                      >
                        💡 Explain
                      </button>
                    )}
                  </div>

                  {/* Tab 1 — every captured row, with its screenshot + recording. */}
                  {dataTab === 'evidence' && evidenceRows.length > 0 && (
                    <div className="data-tab-content">
                      {evidenceRows.map((r, idx) => (
                        <div key={idx} className="data-evi-row">
                          <span className={`run-dot ${r.status}`} />
                          <span className="data-evi-name">{r.label}</span>
                          {r.screenshotPath && (
                            <button
                              type="button"
                              className="shot-link"
                              onClick={() => window.api.library.openScreenshot(r.screenshotPath!)}
                              title="Open this row's screenshot"
                            >
                              📷
                            </button>
                          )}
                          {r.traceId && (
                            <button
                              type="button"
                              className="shot-link trace-link"
                              onClick={() => openTrace(r.traceId!)}
                              title="Open this row's run recording"
                            >
                              ⏺
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reports tab — one whole-run HTML report per captured row. */}
                  {dataTab === 'reports' && reportRows.length > 0 && (
                    <div className="data-tab-content">
                      {reportRows.map((r, idx) => (
                        <div key={idx} className="data-evi-row">
                          <span className={`run-dot ${r.status}`} />
                          <span className="data-evi-name">{r.label}</span>
                          <button
                            type="button"
                            className="shot-link trace-link"
                            onClick={() => saveRunReport(r.traceId!)}
                            title="Save this row's HTML report (pass or fail) — prints to PDF"
                          >
                            📄 Save report
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tab 2 — failed rows, click one to explain it. */}
                  {dataTab === 'explain' && (
                    <div className="data-tab-content">
                      {failedRows.map((r, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className="data-explain-row"
                          onClick={() =>
                            handleExplain(
                              r.failedAt ?? 0,
                              r.error ?? 'Replay failed',
                              r.screenshotPath,
                              r.consoleErrors ?? [],
                              r.networkErrors ?? []
                            )
                          }
                          title={`Explain why "${r.label}" failed`}
                        >
                          <span className="run-dot failed" />
                          <span className="data-evi-name">{r.label}</span>
                          <span className="data-explain-cta">💡</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()
          ) : replayBanner ? (
            <>
              <div className={`replay-status ${replayBanner.tone}`}>
                {replayBanner.text}
                {/* Day 18: open the full run recording (trace) for this run */}
                {!isReplaying && lastTraceId && (
                  <button
                    type="button"
                    className="shot-link trace-link"
                    onClick={() => openTrace(lastTraceId)}
                    title="Open the full run recording (every step's screenshot, console & network)"
                  >
                    ⏺ recording
                  </button>
                )}
                {!isReplaying && lastTraceId && (
                  <button
                    type="button"
                    className="shot-link trace-link"
                    onClick={() => saveRunReport(lastTraceId)}
                    title="Save a shareable HTML report of this whole run (pass or fail) — prints to PDF"
                  >
                    📄 report
                  </button>
                )}
                {replayBanner.tone === 'failed' && lastFailures.length > 1 ? (
                  /* Day 20: several steps failed (Continue) — reveal EACH one's
                     screenshot / explanation inline, not just the first. */
                  <>
                    <button
                      type="button"
                      className={`data-tab${failDetail === 'shots' ? ' active' : ''}`}
                      onClick={() => setFailDetail(failDetail === 'shots' ? null : 'shots')}
                      title="Each failed step's screenshot"
                    >
                      📷 Screenshots
                    </button>
                    <button
                      type="button"
                      className="data-tab"
                      onClick={handleExplainAll}
                      title="Explain the whole test — all failed steps analyzed together"
                    >
                      💡 Explain
                    </button>
                  </>
                ) : (
                  <>
                    {/* Day 11.5: the page photographed at the (single) failing step */}
                    {replayBanner.tone === 'failed' && lastScreenshotPath && (
                      <button
                        type="button"
                        className="shot-link"
                        onClick={() => window.api.library.openScreenshot(lastScreenshotPath)}
                        title="Open the failure screenshot"
                      >
                        📷 view screenshot
                      </button>
                    )}
                    {/* Day 13: turn the failure into a plain-English diagnosis */}
                    {replayBanner.tone === 'failed' && failedIndex !== null && replayError && (
                      <button
                        type="button"
                        className="shot-link explain-link"
                        onClick={() =>
                          handleExplain(
                            failedIndex,
                            replayError,
                            lastScreenshotPath,
                            lastConsoleErrors,
                            lastNetworkErrors
                          )
                        }
                        title="Explain this failure: app bug, test bug, or just timing?"
                      >
                        💡 explain
                      </button>
                    )}
                  </>
                )}
                {/* F8: what changed on the page since the last green run */}
                {replayBanner.tone === 'failed' && whatChanged?.hasChanges && (
                  <button
                    type="button"
                    className={`shot-link explain-link${whatChangedOpen ? ' active' : ''}`}
                    onClick={() => setWhatChangedOpen((o) => !o)}
                    title="What changed on the page since this test last passed"
                  >
                    🔀 What changed
                  </button>
                )}
              </div>

              {/* F8: the diff panel — added/removed text + changed elements vs the
                  last green run, so you can tell an app change from a flaky one. */}
              {replayBanner.tone === 'failed' && whatChangedOpen && whatChanged?.hasChanges && (
                <div className="data-tab-content whatchanged-panel">
                  <div className="wc-lead">
                    Compared to the last time this test passed
                    {whatChanged.baselineAt
                      ? ` (${new Date(whatChanged.baselineAt).toLocaleString()})`
                      : ''}
                    :
                  </div>
                  {whatChanged.urlChanged && (
                    <div className="wc-group">
                      <div className="wc-title">Page URL changed</div>
                      <div className="wc-line">
                        <span className="wc-old">{whatChanged.urlChanged.from}</span> →{' '}
                        <span className="wc-new">{whatChanged.urlChanged.to}</span>
                      </div>
                    </div>
                  )}
                  {whatChanged.elementsChanged.length > 0 && (
                    <div className="wc-group">
                      <div className="wc-title">Elements changed</div>
                      {whatChanged.elementsChanged.map((c, ci) => (
                        <div key={ci} className="wc-line">
                          <code>{c.desc}</code>
                          <ul className="wc-changes">
                            {c.changes.map((ch, chi) => (
                              <li key={chi}>{ch}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                  {whatChanged.elementsRemoved.length > 0 && (
                    <div className="wc-group">
                      <div className="wc-title">Gone since last pass</div>
                      {whatChanged.elementsRemoved.map((e, ei) => (
                        <div key={ei} className="wc-line wc-removed">
                          <code>{e}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {whatChanged.elementsAdded.length > 0 && (
                    <div className="wc-group">
                      <div className="wc-title">New since last pass</div>
                      {whatChanged.elementsAdded.map((e, ei) => (
                        <div key={ei} className="wc-line wc-added">
                          <code>{e}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {(whatChanged.textRemoved.length > 0 || whatChanged.textAdded.length > 0) && (
                    <div className="wc-group">
                      <div className="wc-title">Text changed</div>
                      {whatChanged.textRemoved.map((t, ti) => (
                        <div key={`r${ti}`} className="wc-line wc-removed">
                          − {t}
                        </div>
                      ))}
                      {whatChanged.textAdded.map((t, ti) => (
                        <div key={`a${ti}`} className="wc-line wc-added">
                          + {t}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Day 20: inline lists when MORE THAN ONE step failed. */}
              {replayBanner.tone === 'failed' &&
                lastFailures.length > 1 &&
                failDetail === 'shots' && (
                  <div className="data-tab-content fail-detail">
                    {lastFailures.map((f, idx) => (
                      <div key={idx} className="data-evi-row">
                        <span className="run-dot failed" />
                        <span className="data-evi-name">Step {f.index + 1}</span>
                        {f.screenshotPath ? (
                          <button
                            type="button"
                            className="shot-link"
                            onClick={() => window.api.library.openScreenshot(f.screenshotPath!)}
                            title={`Open step ${f.index + 1}'s screenshot`}
                          >
                            📷
                          </button>
                        ) : (
                          <span className="data-evi-none">no shot</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
            </>
          ) : null}

          {/* F30: manual (wait-for-human) step — the run is holding here. Rendered
              INLINE in the steps panel (NOT a modal) because the embedded browser
              is a native view that draws over any HTML overlay — and the page must
              stay visible + clickable so you can do the manual action (2FA etc.). */}
          {manualPause && (
            <div className="assert-panel manual-panel">
              <div className="assert-target">
                <span className="assert-title">🙋 Manual step — step {manualPause.index + 1}</span>
              </div>
              <p className="manual-message">{manualPause.message}</p>
              <div className="assert-actions">
                <button
                  className="modal-btn primary"
                  onClick={() => {
                    window.api.recorder.manualContinue()
                    setManualPause(null)
                  }}
                >
                  ▶ Continue
                </button>
              </div>
            </div>
          )}

          {/* F21b: the ride landed on a page and is holding — offer to add a
              grounded plain-English check for it. Inline (not a modal) so the
              page stays visible on the left while you describe the check. */}
          {checkOffer && (
            <div className="assert-panel manual-panel">
              <div className="assert-target">
                <span className="assert-title">🐛 Add checks for this page</span>
              </div>
              <p className="manual-message">
                On{' '}
                <strong>
                  {(() => {
                    try {
                      return new URL(checkOffer.url).pathname || checkOffer.url
                    } catch {
                      return checkOffer.url
                    }
                  })()}
                </strong>{' '}
                — say in plain English what should be true on this page (each becomes an AI check). Add
                as many as you like; they run <em>after this page’s actions, before it navigates away</em>.
                Then ▶ Continue.
              </p>
              {ridePending.length > 0 && (
                <ul className="ride-pending">
                  {ridePending.map((c, i) => (
                    <li key={i}>✅ {c}</li>
                  ))}
                </ul>
              )}
              <input
                className="url-input"
                type="text"
                placeholder="e.g. the cart badge shows 1 after the item is added"
                value={rideClaim}
                onChange={(e) => setRideClaim(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && rideClaim.trim()) handleRideAddCheck()
                }}
                autoFocus
              />
              <div className="assert-actions">
                <button
                  className="modal-btn"
                  onClick={handleRideAddCheck}
                  disabled={!rideClaim.trim()}
                >
                  ➕ Add check
                </button>
                <button className="modal-btn primary" onClick={handleRideContinue}>
                  ▶ Continue{ridePending.length ? ` (${ridePending.length})` : ''}
                </button>
                <button className="modal-btn" onClick={handleRideStop}>
                  ■ Stop ride
                </button>
              </div>
            </div>
          )}

          {/* === Day 12: recovery panel — the replay is paused on a failed
              step, browser frozen at the scene. Not a modal: the page must
              stay visible (and clickable, for Re-pick). === */}
          {recovery && (
            <div className="assert-panel recovery-panel">
              <div className="assert-target">
                <span className="assert-title recovery-title">
                  ✗ Step {recovery.index + 1} failed — paused
                </span>
                {steps[recovery.index]?.label && (
                  <span className="assert-label">{steps[recovery.index].label}</span>
                )}
              </div>
              <code className="assert-selector recovery-error">{recovery.error}</code>
              {recoveryWarning && <div className="pick-warning">⚠ {recoveryWarning}</div>}
              {repickPending ? (
                <>
                  {/* Day 17: the pick looks different from the original — confirm */}
                  <div className="pick-warning">⚠ {repickPending.message}</div>
                  <div className="assert-actions recovery-actions">
                    <button className="modal-btn" onClick={() => setRepickPending(null)}>
                      Cancel
                    </button>
                    <button
                      className="modal-btn primary"
                      onClick={() => applyHeal(repickPending.picked, repickPending.healIndex)}
                    >
                      Heal anyway
                    </button>
                  </div>
                </>
              ) : repickIndex !== null ? (
                <div className="assert-actions recovery-actions">
                  <span className="recovery-hint">
                    Click the correct element in the page (Esc cancels)
                  </span>
                  <button className="modal-btn" onClick={handleRecoveryRepickCancel}>
                    Cancel re-pick
                  </button>
                </div>
              ) : (
                <>
                  {/* Day 18 (self-heal): the app auto-found a likely match for
                      the broken step by its label — one click to accept it.
                      Day 21 (ambiguity guard): if that label matched SEVERAL
                      equally-good elements (e.g. many "Add to cart" buttons),
                      "the best match" is just the first in DOM order and may be
                      the wrong one — so we DECLINE the one-click fix and ask for
                      a manual pick instead of silently healing to a guess. */}
                  {recovery.suggestion &&
                    ((recovery.suggestion.ambiguousCount ?? 1) > 1 ? (
                      <div className="self-heal self-heal-ambiguous">
                        <span className="self-heal-text">
                          🔧 Self-heal found <strong>{recovery.suggestion.ambiguousCount}</strong>{' '}
                          elements labelled <strong>“{recovery.suggestion.label}”</strong> — too
                          ambiguous to fix automatically. Use <strong>🎯 Pick manually</strong>{' '}
                          below to choose the right one.
                        </span>
                      </div>
                    ) : (
                      <div className="self-heal">
                        <span className="self-heal-text">
                          🔧 Self-heal found <strong>“{recovery.suggestion.label}”</strong> — use it
                          to fix this step?
                        </span>
                        <button
                          type="button"
                          className="modal-btn primary self-heal-accept"
                          onClick={() => applyHeal(recovery.suggestion!, recovery.index)}
                        >
                          ✓ Accept fix
                        </button>
                      </div>
                    ))}
                  <div className="assert-actions recovery-actions">
                    {recovery.screenshotPath && (
                      <button
                        type="button"
                        className="shot-link"
                        onClick={() => window.api.library.openScreenshot(recovery.screenshotPath!)}
                        title="Open the failure screenshot"
                      >
                        📷
                      </button>
                    )}
                    {/* Day 18: open the full run recording captured up to here */}
                    {recovery.traceId && (
                      <button
                        type="button"
                        className="shot-link trace-link"
                        onClick={() => openTrace(recovery.traceId!)}
                        title="Open the full run recording (every step's screenshot, console & network)"
                      >
                        ⏺
                      </button>
                    )}
                    {/* Day 13: ask for a diagnosis while deciding what to do */}
                    <button
                      type="button"
                      className="shot-link explain-link"
                      onClick={() =>
                        handleExplain(
                          recovery.index,
                          recovery.error,
                          recovery.screenshotPath,
                          recovery.consoleErrors ?? [],
                          recovery.networkErrors ?? [],
                          recovery.apiEvidence // F24: the HTTP exchange, mid-pause
                        )
                      }
                      title="Explain this failure: app bug, test bug, or just timing?"
                    >
                      💡
                    </button>
                    <button
                      className="modal-btn"
                      onClick={handleRecoveryRetry}
                      title={
                        retryIsUnsafe(recovery.index)
                          ? 'Re-sends this POST/PATCH — it may create a duplicate record, so it asks first'
                          : 'Run the same step again (maybe the page was just slow)'
                      }
                    >
                      🔁 Retry{retryIsUnsafe(recovery.index) ? ' ⚠' : ''}
                    </button>
                    {/* Day 19: a visual snapshot differs — if the new look is
                      intended, adopt it as the new baseline, then retry (passes). */}
                    {recovery.visual?.baselineId && (
                      <button
                        className="modal-btn"
                        onClick={async () => {
                          const v = recovery.visual!
                          const ok = await window.api.visual.updateBaseline(
                            v.baselineId!,
                            v.currentPath
                          )
                          if (ok) answerRecovery('retry')
                        }}
                        title="Adopt the current look as the new baseline (the visual change is intended), then retry"
                      >
                        📸 Update baseline
                      </button>
                    )}
                    {/* Day 18: manual pick heals a SELECTOR — only offer it when
                      the selector actually broke (not for assertion/timing
                      failures, where re-picking wouldn't help). */}
                    {recovery.selectorBroke && steps[recovery.index]?.selector && (
                      <button
                        className="modal-btn"
                        onClick={handleRecoveryRepick}
                        title="Point at the right element yourself — heals the selector, then retries"
                      >
                        🎯 Pick manually
                      </button>
                    )}
                    <button
                      className="modal-btn"
                      onClick={() => answerRecovery('continue')}
                      title="Ignore this failure and continue, to check the later steps. The run is still marked failed; the test isn't changed."
                    >
                      ⤵ Continue
                    </button>
                    <button
                      className="modal-btn"
                      onClick={handleRecoverySkipStep}
                      title="Permanently skip this step — disable it now and in future runs. 💾 Save to keep it."
                    >
                      ⊘ Skip step
                    </button>
                    <button
                      className="modal-btn danger"
                      onClick={() => answerRecovery('stop')}
                      title="End the run as failed"
                    >
                      ⏹ Stop
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Day 12: re-picked selectors live only in the panel until saved */}
          {healedIndices.size > 0 && !isReplaying && (
            <div className="replay-status healed">
              🔧 {healedIndices.size} selector{healedIndices.size > 1 ? 's' : ''} healed by re-pick
              — 💾 save to keep the fix
            </div>
          )}

          {/* F25: a {{env:NAME}} that resolved to nothing. Shown on PASS as well
              as fail: the token is substituted with '' either way, so a green run
              can be one that typed nothing and checked nothing. Named explicitly,
              because the resulting failure lands several steps later and reads
              like test-data rot — a real run failed "Expected URL to contain
              /inventory.html" when the actual cause was an unset USERNAME. */}
          {unresolvedEnv.length > 0 && !isReplaying && (
            <div className="replay-status branch-note">
              <strong>
                ⚠ {unresolvedEnv.length} environment{' '}
                {unresolvedEnv.length === 1 ? 'variable' : 'variables'} had no value
              </strong>
              <div>{unresolvedEnv.map((n) => `{{env:${n}}}`).join(', ')}</div>
              <div className="branch-note-why">
                Each was replaced with an <strong>empty string</strong>, so any step using it typed
                nothing. Set it in the active environment (⚙ Manage environments), or pick an
                environment that defines it, then run again.
                {unresolvedEnv.some((n) => collidesWithOsEnv(n)) && (
                  <>
                    {' '}
                    Note: a name the operating system also defines (e.g.{' '}
                    <code>USERNAME</code>) is <strong>never</strong> read from the OS — that would
                    silently supply your account name instead of a test value.
                  </>
                )}
              </div>
            </div>
          )}

          {/* F37: control flow that did NOT run. Shown on a PASSING run too —
              that's the whole point. A green tick on a test whose checks all sat
              in an untaken branch looks identical to one that checked everything,
              and this is the only thing that tells them apart. */}
          {branchNotes.length > 0 && !isReplaying && (
            <div className="replay-status branch-note">
              <strong>🔀 Some steps didn’t run this time</strong>
              {branchNotes.map((n, k) => (
                <div key={k}>{n}</div>
              ))}
              <div className="branch-note-why">
                That’s expected when a condition is false or a loop matches nothing — but any check
                inside those steps was <strong>not performed</strong>, so this run doesn’t vouch
                for it.
              </div>
            </div>
          )}

          {/* F1: HAR status — a captured/linked archive, and how the last run
              actually used it. Lives in the PANEL, not under the toolbar: the
              native browser view is painted from CHROME_HEIGHT down and covers
              any band between the toolbar and the page, so this was invisible
              whenever a page was loaded. The panel is beside the view, never
              under it. It also belongs here on merit — "N served from HAR, M
              live" is a run result, and every other run result is in this
              column. */}
          {(captureNetwork || harField || harCount > 0 || lastHarUsage) && (
            <div className="har-status">
              {harField ? (
                <span className="har-chip linked">🌐 network archive saved with this test</span>
              ) : harCount > 0 ? (
                <span className="har-chip captured">
                  🌐 {harCount} responses captured (save to keep)
                </span>
              ) : captureNetwork ? (
                <span className="har-chip arm">🌐 network capture on — record to capture</span>
              ) : null}
              {lastHarUsage && (
                <span className="har-chip usage">
                  last run: {lastHarUsage.served} served from HAR · {lastHarUsage.passthrough} live
                </span>
              )}
            </div>
          )}

          {/* F4 (self-heal 2.0): steps main repaired ON ITS OWN mid-run */}
          {aiHealedIndices.size > 0 && !isReplaying && (
            <div className="replay-status healed">
              🤖 {aiHealedIndices.size} broken selector{aiHealedIndices.size > 1 ? 's' : ''}{' '}
              auto-healed by AI &amp; re-verified — 💾 save to keep the fix
            </div>
          )}
          {/* F4: sticky note — what a 🤖 heal means and what to DO about it. */}
          {aiHealedIndices.size > 0 && !isReplaying && (
            <div className="help-note">
              <span className="help-note-title">📌 A selector was auto-healed — what now?</span>
              <ul>
                <li>
                  A step&apos;s selector broke (the app changed), so the tool re-found the element
                  by <strong>name / role / text / position / look</strong>, re-ran the step to
                  prove the fix works, and kept the run green. The 🤖 tag on each step shows{' '}
                  <em>which</em> clues matched.
                </li>
                <li>
                  <strong>If the change was expected</strong> (devs renamed an id / refactored
                  markup — the usual case): hit <strong>💾 Save</strong> to keep the new selector.
                  The test now points at the new element — you do <em>not</em> ask the devs to
                  change anything back.
                </li>
                <li>
                  <strong>If it looks wrong</strong> (the element moved somewhere odd, or only the
                  &ldquo;visual&rdquo; clue matched): don&apos;t save yet — open{' '}
                  <strong>🔀 What changed</strong> to see what differed from the last green run, and
                  raise it with the devs if it&apos;s a real regression.
                </li>
                <li>
                  The fix is <strong>in memory until you Save</strong>. Export to Playwright uses
                  the healed selector automatically (with a <code>⚠ auto-healed</code> comment) —
                  but exported CI tests don&apos;t self-heal, so Save + re-export to lock it in.
                </li>
              </ul>
            </div>
          )}

          {/* === Pillar 4: reusable step blocks (reuses the assert-panel look) === */}
          {blocksPanelOpen && (
            <div className={`assert-panel blocks-panel${blocksCollapsed ? ' collapsed' : ''}`}>
              <div className="assert-target">
                <span className="assert-title">🧩 Reusable step blocks</span>
                {/* F7: minimise arrow — collapse to give the step list the whole
                    sidebar (for editing a block with many steps). */}
                <button
                  type="button"
                  className="block-collapse"
                  onClick={() => setBlocksCollapsed((c) => !c)}
                  title={
                    blocksCollapsed
                      ? 'Expand the blocks panel'
                      : 'Minimise — give the step list the whole sidebar'
                  }
                  aria-label={blocksCollapsed ? 'Expand blocks panel' : 'Minimise blocks panel'}
                >
                  {blocksCollapsed ? '▸' : '▾'}
                </button>
              </div>
              {/* Minimised mid-edit: keep Update / Close reachable without expanding. */}
              {blocksCollapsed && editingBlockRef && (
                <div className="assert-actions">
                  <button className="modal-btn" onClick={closeBlocksPanel}>
                    Close
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleSaveBlock}
                    disabled={!blockNameInput.trim() || steps.length === 0}
                  >
                    Update block
                  </button>
                </div>
              )}

              <div className="block-body">
              {/* F7: blast-radius banner — always visible (no hover). Shows the
                  tests a block feeds the moment it's IN FOCUS: armed for delete
                  (red — "breaks these") or being edited (amber — "changes these").
                  Delete takes priority since it's the destructive, timed action. */}
              {(() => {
                const focusRef = pendingDeleteBlock ?? editingBlockRef
                if (!focusRef) return null
                const deleting = !!pendingDeleteBlock
                const name = deleting
                  ? (blocks.find((x) => x.fileName === focusRef)?.name ?? 'this block')
                  : blockNameInput
                const links = blockUsage[focusRef] ?? []
                const cls = deleting
                  ? 'blast-radius blast-radius-delete'
                  : links.length === 0
                    ? 'blast-radius blast-radius-safe'
                    : 'blast-radius'
                return (
                  <div className={cls}>
                    {links.length === 0 ? (
                      <span className="blast-radius-head">
                        {deleting
                          ? `Deleting “${name}” is safe — no test links it. Click ✕ again to confirm.`
                          : '✓ No test links this block yet — updating it affects nothing else.'}
                      </span>
                    ) : (
                      <>
                        <span className="blast-radius-head">
                          {deleting ? '⚠ Deleting ' : '⚠ Updating '}
                          <strong>“{name}”</strong>
                          {deleting ? ' breaks ' : ' changes '}
                          {links.length} linked test{links.length > 1 ? 's' : ''}
                          {deleting ? ' — click ✕ again to confirm:' : ':'}
                        </span>
                        <ul className="blast-list">
                          {links.map((l) => (
                            <li key={l.fileName}>
                              {l.name}
                              {l.suite && <span className="blast-suite"> · {l.suite}</span>}
                              {l.count > 1 && <span className="blast-count"> ×{l.count}</span>}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })()}

              {/* F7: while EDITING a block, hide the insert list so the block's
                  loaded steps sit in view right below the compact panel. */}
              {!editingBlockRef && (
                <>
                  <div className="block-section-label">
                    Insert a block{' '}
                    {blockInsertAt !== null ? `at step ${blockInsertAt + 1}` : 'at the end'}
                  </div>
              {blocks.length > 0 && (
                <div className="block-hint">
                  🔗 linked — stays in sync when you edit the block · ⧉ copy — an independent
                  snapshot you can edit here
                </div>
              )}
              {blocks.length === 0 ? (
                <div className="block-empty">
                  No saved blocks yet — save some steps below to reuse them across tests.
                </div>
              ) : (
                <ul className="block-list">
                  {blocks.map((b) => {
                    // F7: which tests link THIS block — drives the usage chip + the
                    // sharper delete warning ("breaks N tests").
                    const links = blockUsage[b.fileName] ?? []
                    const usedBy = links.length
                    const linkNames = links
                      .map((l) => `• ${l.name}${l.suite ? ` (${l.suite})` : ''}${l.count > 1 ? ` ×${l.count}` : ''}`)
                      .join('\n')
                    return (
                      <li key={b.fileName} className="block-row">
                      <button
                        type="button"
                        className="block-insert"
                        onClick={() => handleInsertBlockLinked(b)}
                        title={`Insert "${b.name}" as a LIVE link (${b.stepCount} steps) — editing the block later updates this test`}
                      >
                        🔗 {b.name} <span className="block-count">{b.stepCount} steps</span>
                      </button>
                      {/* F7: blast-radius at a glance — how many tests this block
                          feeds; hover to see which. "unused" = safe to change. */}
                      <span
                        className={`block-usage${usedBy === 0 ? ' block-usage-none' : ''}`}
                        title={
                          usedBy === 0
                            ? 'No test links this block — safe to edit or delete'
                            : `Used by ${usedBy} test${usedBy > 1 ? 's' : ''}:\n${linkNames}`
                        }
                      >
                        {usedBy === 0 ? 'unused' : `used by ${usedBy}`}
                      </span>
                      <button
                        type="button"
                        className="block-mini"
                        onClick={() => handleInsertBlock(b.fileName)}
                        title="Insert a one-time COPY (snapshot, not linked)"
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        className="block-mini"
                        onClick={() => handleEditBlock(b)}
                        title={`Edit "${b.name}" — updates every test linked to it`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={`block-del${
                          pendingDeleteBlock === b.fileName ? ' confirming' : ''
                        }`}
                        onClick={() => armOrDeleteBlock(b.fileName)}
                        title={
                          pendingDeleteBlock === b.fileName
                            ? `Click again to permanently delete "${b.name}"${usedBy ? ` — BREAKS ${usedBy} linked test${usedBy > 1 ? 's' : ''}` : ''}`
                            : `Delete block "${b.name}"${usedBy ? ` (breaks ${usedBy} linked test${usedBy > 1 ? 's' : ''})` : ''}`
                        }
                        aria-label={`Delete block ${b.name}`}
                      >
                        {pendingDeleteBlock === b.fileName ? 'Sure?' : '✕'}
                      </button>
                    </li>
                    )
                  })}
                </ul>
              )}
                </>
              )}

              {/* F7: a clear "you're editing a block" cue when the insert list is hidden. */}
              {editingBlockRef && (
                <div className="block-editing-hint">
                  ✎ Editing block — its steps are loaded in the list below. Change them, then{' '}
                  <strong>Update block</strong> to push the fix to every linked test.
                </div>
              )}

              <div className="block-section-label">
                {editingBlockRef ? `Update block "${blockNameInput}"` : 'Save steps as a new block'}
              </div>
              <input
                className="assert-value"
                value={blockNameInput}
                onChange={(e) => setBlockNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveBlock()
                  else if (e.key === 'Escape') closeBlocksPanel()
                }}
                placeholder="block name (e.g. Login)…"
                spellCheck={false}
              />
              <div className="block-range">
                <span>Steps</span>
                <input
                  type="number"
                  min={1}
                  max={steps.length}
                  value={blockFrom}
                  onChange={(e) => setBlockFrom(Number(e.target.value))}
                />
                <span>to</span>
                <input
                  type="number"
                  min={1}
                  max={steps.length}
                  value={blockTo}
                  onChange={(e) => setBlockTo(Number(e.target.value))}
                />
                <span className="block-hint">of {steps.length}</span>
              </div>
              <div className="assert-actions">
                <button className="modal-btn" onClick={closeBlocksPanel}>
                  Close
                </button>
                <button
                  className="modal-btn primary"
                  onClick={handleSaveBlock}
                  disabled={!blockNameInput.trim() || steps.length === 0}
                >
                  {editingBlockRef ? 'Update block' : 'Save block'}
                </button>
              </div>
              </div>
            </div>
          )}
          {/* === Day 11: save panel (reuses the assert-panel look) === */}
          {savePanelOpen && (
            <div className="assert-panel">
              <div className="assert-target">
                <span className="assert-title">Save test</span>
              </div>
              <input
                className="assert-value"
                value={saveNameInput}
                onChange={(e) => setSaveNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTest()
                  else if (e.key === 'Escape') setSavePanelOpen(false)
                }}
                placeholder="test name…"
                autoFocus
                spellCheck={false}
              />
              {/* Day 11.5: which section this test belongs to */}
              <div className="assert-kinds">
                {suites.map((suite) => (
                  <button
                    key={suite}
                    type="button"
                    className={`assert-kind${
                      saveSuite === suite && !newSuiteInput.trim() ? ' chosen' : ''
                    }`}
                    onClick={() => {
                      setSaveSuite(suite)
                      setNewSuiteInput('')
                    }}
                  >
                    {suite}
                  </button>
                ))}
              </div>
              <input
                className="assert-value"
                value={newSuiteInput}
                onChange={(e) => setNewSuiteInput(e.target.value)}
                placeholder="…or type a new section name"
                spellCheck={false}
              />
              <code className="assert-selector">
                {baseURL || deriveBaseURL(steps)
                  ? `base URL: ${baseURL || deriveBaseURL(steps)}`
                  : 'no base URL detected'}
              </code>
              {/* Day 17: session reuse — start this test already logged in */}
              <div className="session-block">
                <label className="session-label">Start logged in (session):</label>
                <select
                  className="session-select"
                  value={storageState ?? ''}
                  onChange={(e) => setStorageState(e.target.value || undefined)}
                >
                  <option value="">None — fresh login each run</option>
                  {sessions.map((s) => {
                    // F39.2: an expired login is the single most misleading thing
                    // a test can carry, so it's named right in the picker.
                    const age = sessionAge(s)
                    return (
                      <option key={s} value={s}>
                        {s}
                        {age ? ` — ⚠ ${age.text}` : ''}
                      </option>
                    )
                  })}
                </select>
                {(() => {
                  const age = sessionAge(storageState)
                  if (!age) return null
                  return (
                    <p className="session-expiry-warn">
                      ⚠ This session <strong>{age.text}</strong>.
                      {age.expired
                        ? ' A run in the app may still pass — the embedded browser is probably still logged in from ordinary use — but the saved file no longer works, so this test will fail headless, in a parallel run, and in CI. Log in again and save over it.'
                        : ' Save it again before it lapses, or this test starts failing everywhere except in the app.'}
                    </p>
                  )
                })()}
                <div className="session-save-row">
                  <input
                    className="assert-value"
                    value={sessionNameInput}
                    onChange={(e) => setSessionNameInput(e.target.value)}
                    placeholder="name to save the CURRENT logged-in browser as…"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={handleSaveSession}
                    disabled={!sessionNameInput.trim()}
                    title="Capture the embedded browser's current cookies + storage as a reusable session"
                  >
                    Save session
                  </button>
                </div>
              </div>
              {/* F38: tags. Sits BELOW the section chips deliberately — the two
                  look similar but mean different things, and the note spells the
                  difference out so they don't get used interchangeably. */}
              <div className="session-block">
                <label className="session-label">Tags:</label>
                <div className="tag-row">
                  {tags.map((t) => (
                    <span key={t} className="tag-chip editable">
                      {t}
                      <button
                        type="button"
                        className="tag-x"
                        onClick={() => setTags(tags.filter((x) => x !== t))}
                        title={`Remove ${t}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="tag-input"
                    value={tagInput}
                    placeholder="@smoke…"
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter / comma commits; comma too because typing a list is
                      // the natural thing to do in a box that shows several.
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        const added = parseTags(tagInput).filter((t) => !tags.includes(t))
                        if (added.length) setTags([...tags, ...added])
                        setTagInput('')
                      } else if (e.key === 'Backspace' && !tagInput && tags.length) {
                        setTags(tags.slice(0, -1))
                      }
                    }}
                    onBlur={() => {
                      const added = parseTags(tagInput).filter((t) => !tags.includes(t))
                      if (added.length) setTags([...tags, ...added])
                      setTagInput('')
                    }}
                    spellCheck={false}
                  />
                </div>
                <div className="tag-suggest">
                  {SUGGESTED_TAGS.filter((t) => !tags.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="tag-add"
                      onClick={() => setTags([...tags, normalizeTag(t)])}
                    >
                      + {t}
                    </button>
                  ))}
                </div>
                <p className="tag-note">
                  A test lives in <strong>one section</strong> but can carry{' '}
                  <strong>many tags</strong> — that&apos;s the difference. The section is where it
                  files; tags are what it&apos;s <em>for</em>. Tag the fast, critical ones{' '}
                  <code>@smoke</code> and you can run just those before a merge, then{' '}
                  <code>npx playwright test --grep @smoke</code> does the same in CI.
                </p>
              </div>

              {/* Day 17 viewport → F36 device emulation. Desktop and the two
                  "size only" presets are Day-17 behaviour, unchanged. The real
                  devices below them add userAgent + touch + pixel density. */}
              <div className="session-block">
                <label className="session-label">Device:</label>
                <div className="assert-kinds">
                  <button
                    type="button"
                    className={`assert-kind${!viewport && !deviceId ? ' chosen' : ''}`}
                    onClick={() => applyDevice(undefined)}
                  >
                    Desktop
                  </button>
                  {DEVICES.filter((d) => d.group === 'Basic').map((d) => {
                    // A pre-F36 test has no deviceId — match it on SIZE so its
                    // saved viewport still lights up the right chip.
                    const active =
                      deviceId === d.id ||
                      (!deviceId &&
                        !!viewport &&
                        viewport.width === d.viewport.width &&
                        viewport.height === d.viewport.height)
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={`assert-kind${active ? ' chosen' : ''}`}
                        onClick={() => applyDevice(d.id)}
                        title="Resizes the window only — the page still sees a desktop browser, with no touch and a desktop user-agent."
                      >
                        {/* "(size only)" used to be stripped here to keep the chip
                            short. That hid the single most important fact about
                            these presets: the page is NOT told it's a phone. The
                            grey note below said so, but a label you read every
                            time beats a paragraph you read once (Surbhi, Test 10). */}
                        {d.label}
                      </button>
                    )
                  })}
                </div>
                <div className="assert-kinds device-real">
                  {DEVICES.filter((d) => d.group !== 'Basic').map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`assert-kind${deviceId === d.id ? ' chosen' : ''}`}
                      onClick={() => applyDevice(d.id)}
                      title={deviceSummary(d)}
                    >
                      {d.group === 'Tablet' ? '📲' : '📱'} {d.label}
                    </button>
                  ))}
                </div>
                <p className="device-note">
                  {deviceId && deviceById(deviceId)?.userAgent ? (
                    <>
                      <strong>{deviceSummary(deviceById(deviceId))}</strong>
                      <br />
                      The page sees a real phone: mobile user-agent, touch events, and{' '}
                      {deviceById(deviceId)?.deviceScaleFactor}× pixel density — so layouts that
                      switch on UA or <code>pointer: coarse</code> switch here too.
                      {deviceById(deviceId)?.realEngine === 'webkit' && (
                        // Its own line, not a trailing clause. This is the most
                        // important sentence in the box — the one place the app
                        // admits the emulation isn't the real engine — and buried
                        // at the end of a dense paragraph the eye slid past it.
                        <span className="device-caveat">
                          ⚠ In-app this is Chromium wearing an iOS costume — the embedded browser is
                          Chromium-only. The export and 🧭 cross-browser run it on real WebKit.
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      &ldquo;Size only&rdquo; resizes the window and nothing else — the page still
                      sees a desktop browser with no touch. Pick a real device below to test the
                      mobile path properly.
                    </>
                  )}
                </p>
              </div>
              <div className="assert-actions">
                <button className="modal-btn" onClick={() => setSavePanelOpen(false)}>
                  Cancel
                </button>
                <button className="modal-btn primary" onClick={handleSaveTest}>
                  Save
                </button>
              </div>
            </div>
          )}
          {/* === Day 20: data-driven table — run the flow once per row === */}
          {dataPanelOpen && (
            <div className="assert-panel data-panel">
              <div className="assert-target">
                <span className="assert-title">🧪 Data-driven runs</span>
                <button
                  className="modal-close"
                  onClick={() => setDataPanelOpen(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              {!isDataDriven ? (
                <p className="data-hint">
                  No variables yet. On a <strong>Type</strong>, <strong>Select</strong>, or value{' '}
                  <strong>Check</strong> step, click <code>{'{}'}</code> to turn its value into a
                  variable like <code>{'{{username}}'}</code> — or ✎ edit a value and type the token
                  yourself. Each variable becomes a column here, and the flow runs once per row.
                </p>
              ) : (
                <>
                  <div className="data-grid-wrap">
                    <table className="data-grid">
                      <thead>
                        <tr>
                          {dataCols.map((c) => (
                            <th key={c} title={`Variable {{${c}}}`}>
                              {c}
                            </th>
                          ))}
                          <th className="data-grid-rowact" aria-label="row actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {dataRows.map((row, r) => (
                          <tr key={r}>
                            {dataCols.map((c) => (
                              <td key={c}>
                                <input
                                  className="data-cell"
                                  value={row[c] ?? ''}
                                  onChange={(e) => setCell(r, c, e.target.value)}
                                  placeholder={c}
                                  spellCheck={false}
                                />
                              </td>
                            ))}
                            <td className="data-grid-rowact">
                              <button
                                className="data-row-del"
                                onClick={() => deleteDataRow(r)}
                                title="Delete this row"
                                aria-label="Delete row"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="data-note">
                    Tip: a cell can be <code>{'{{env:NAME}}'}</code> to pull a real secret from your
                    environment instead of typing it here.
                  </div>
                  <div className="assert-actions">
                    <button className="modal-btn" onClick={addDataRow}>
                      ＋ Add row
                    </button>
                    <button
                      className="modal-btn primary"
                      onClick={handleRunData}
                      disabled={isReplaying || isRecording || dataRows.length === 0}
                      title="Run the whole flow once for every row"
                    >
                      ▶ Run {dataRows.length} row{dataRows.length === 1 ? '' : 's'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {isPicking && repickIndex === null && (
            <div className="replay-status running">
              Click an element in the page to check it (Esc cancels)
              <div className="page-checks">
                <span className="page-checks-label">or check the page itself:</span>
                <button type="button" className="page-check-chip" onClick={handleAddUrlCheck}>
                  URL
                </button>
                <button type="button" className="page-check-chip" onClick={handleAddTitleCheck}>
                  Title
                </button>
              </div>
              {/* F19: plain-English AI check — no element, judged by the LLM. */}
              <div className="page-checks ai-check">
                <span className="page-checks-label">🤖 or check it in plain English:</span>
                <input
                  className="assert-value ai-check-input"
                  value={nlClaim}
                  onChange={(e) => setNlClaim(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddNlCheck()
                  }}
                  placeholder='e.g. "an order confirmation number is shown"'
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="page-check-chip"
                  onClick={handleAddNlCheck}
                  disabled={!nlClaim.trim()}
                  title="Add an AI check — the LLM judges this claim against the page at replay"
                >
                  Add AI check
                </button>
              </div>
            </div>
          )}

          {/* === Assertion chooser — opens when an element was picked === */}
          {pickedElement && (
            <div className="assert-panel" ref={checkPanelRef}>
              <div className="assert-target">
                <span className="assert-title">Add check:</span>
                <span className="assert-label">{pickedElement.label}</span>
              </div>
              <code className="assert-selector">{pickedElement.selector}</code>
              {/* Day 12: warn NOW about an element replay will refuse later */}
              {pickedElement.unreliable && (
                <div className="pick-warning">
                  ⚠ This element has no stable hooks (no id / role / text) — a check on it cannot
                  replay reliably. Pick a more specific element instead (its label, or a container
                  with an id).
                </div>
              )}
              <div className="assert-kinds">
                {ASSERT_KINDS.filter(
                  (kind) =>
                    (kind !== 'checked' && kind !== 'unchecked') ||
                    pickedElement.checked !== undefined
                ).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`assert-kind${assertKind === kind ? ' chosen' : ''}`}
                    onClick={() => handleChooseKind(kind)}
                  >
                    {ASSERT_LABELS[kind]}
                  </button>
                ))}
              </div>
              {assertKind === 'attribute' && (
                <input
                  className="assert-value"
                  value={assertAttr}
                  onChange={(e) => setAssertAttr(e.target.value)}
                  placeholder="attribute name (e.g. href, src, alt)…"
                  spellCheck={false}
                />
              )}
              {assertNeedsValue(assertKind) && (
                <input
                  className="assert-value"
                  value={assertValue}
                  onChange={(e) => setAssertValue(e.target.value)}
                  placeholder={
                    assertKind === 'count'
                      ? 'expected number of matches…'
                      : assertKind === 'class'
                        ? 'class name (one token, e.g. error)…'
                        : assertKind === 'attribute'
                          ? 'expected attribute value…'
                          : 'expected value…'
                  }
                  spellCheck={false}
                />
              )}
              <div className="assert-actions">
                <button
                  className="modal-btn"
                  onClick={() => {
                    setPickedElement(null)
                    setInsertAt(null)
                  }}
                >
                  Cancel
                </button>
                <button
                  className="modal-btn primary"
                  onClick={handleAddAssert}
                  disabled={pickedElement.unreliable}
                  title={
                    pickedElement.unreliable
                      ? 'No reliable selector — this check would always fail on replay'
                      : undefined
                  }
                >
                  Add check
                </button>
              </div>
            </div>
          )}
          {steps.length === 0 ? (
            <>
              <p className="steps-empty">
                {isRecording
                  ? 'Recording… interact with the page.'
                  : 'Press Record, then use the page to capture steps.'}
              </p>
              {/* An API step used to be reachable ONLY from a step's ＋ menu, and an
                  empty test has no steps — so the first thing in any test was forced to
                  be a UI action. That made a pure-API test (a health check, a contract
                  check, an API login before any page loads) impossible to write at all.
                  This is the same ＋ menu's api entry, hoisted to the empty state. */}
              {!isRecording && (
                <button
                  type="button"
                  className="steps-empty-api"
                  onClick={() => handleAddApiStep(0)}
                  title="Start this test with an HTTP request — no UI step needed first. For an API-only test (health check, contract check) or an API login that authenticates the browser before the first page."
                >
                  🔌 …or start with an API request
                </button>
              )}
            </>
          ) : (
            <ol className="steps-list">
              {/* F37: a broken loop/if structure stops replay before it starts,
                  so say so HERE rather than letting Replay fail — the fix is a
                  step edit, not a test problem. */}
              {controlFlow.errors.length > 0 && (
                <li className="control-error">
                  <strong>⚠ This test can’t run yet</strong>
                  {controlFlow.errors.map((e, n) => (
                    <div key={n}>{e}</div>
                  ))}
                </li>
              )}
              {steps.map((step, i) => {
                // Day 16(+): upload steps aren't text-editable but DO get a ✎ —
                // it opens a file picker to swap the uploaded file.
                const editable = editableValue(step) !== null || step.type === 'upload'
                const canEdit = !isRecording && !isReplaying
                // F37: indent by nesting depth so a loop/if body reads as being
                // INSIDE it — the flat list is how it's stored, not how it should
                // look.
                const stepDepth = controlFlow.depth[i] ?? 0
                const isControl = isControlStep(step)
                return (
                  <li
                    key={i}
                    style={stepDepth > 0 ? { marginLeft: stepDepth * 16 } : undefined}
                    className={`step-item${step.disabled ? ' disabled' : ''}${
                      step.optional ? ' optional' : ''
                    }${isControl ? ' control-step' : ''}${
                      i === failedIndex
                        ? ' failed'
                        : i === replayingIndex
                          ? ' running'
                          : skippedIndices.has(i)
                            ? ' skipped'
                            : doneIndices.has(i)
                              ? ' done'
                              : ''
                    }`}
                  >
                    <span className="step-num">
                      {doneIndices.has(i) ? '✓' : skippedIndices.has(i) ? '»' : i + 1}
                    </span>
                    <div className="step-body">
                      {editingIndex === i ? (
                        <input
                          className="step-edit-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCommitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitEdit()
                            else if (e.key === 'Escape') setEditingIndex(null)
                          }}
                          autoFocus
                          spellCheck={false}
                        />
                      ) : step.type === 'api' ? (
                        <>
                          <span
                            className="step-text step-text-api"
                            onClick={() => canEdit && openApiEditor(i)}
                            title="Edit this API request"
                          >
                            {stepText(step)}
                          </span>
                          {/* F24: what the server ACTUALLY sent back — shown for a
                              passing step too, because a green tick you can't
                              inspect proves nothing. */}
                          {apiResponses[i] && (
                            <button
                              type="button"
                              className={`api-chip${statusIsOk(apiResponses[i].status) ? ' ok' : ' bad'}`}
                              onClick={() => setApiPanelIndex(i)}
                              title="Show the response the server actually sent"
                            >
                              ↩ {apiResponses[i].status ?? 'no response'}
                              {apiResponses[i].durationMs != null
                                ? ` · ${apiResponses[i].durationMs} ms`
                                : ''}
                            </button>
                          )}
                        </>
                      ) : step.type === 'snapshot' ? (
                        <span
                          className="step-text step-text-api"
                          onClick={() => canEdit && openSnapEditor(i)}
                          title="Mask dynamic regions / freeze animations for this snapshot"
                        >
                          {stepText(step)}
                          {(step.maskSelectors ?? '').trim() && (
                            <span className="mask-badge" title="Has masked regions">
                              {' '}
                              🎭
                            </span>
                          )}
                        </span>
                      ) : step.type === 'repeat' ? (
                        /* F37: a loop header edits inline — how many times, or
                           which element to iterate over. */
                        <span className="step-text step-text-control">
                          🔁 Repeat
                          {step.repeatKind === 'each' ? (
                            <>
                              {' for each '}
                              <button
                                type="button"
                                className="control-pick"
                                disabled={!canEdit}
                                onClick={() => handleStartPickFor(i)}
                                title="Pick the element to loop over — the loop runs once per match"
                              >
                                {step.label ? `"${step.label}"` : 'pick an element…'}
                              </button>
                              {' on the page'}
                            </>
                          ) : (
                            <>
                              {' '}
                              <input
                                className="control-num"
                                type="number"
                                min={1}
                                value={step.value ?? '1'}
                                disabled={!canEdit}
                                onChange={(e) => updateStepField(i, { value: e.target.value })}
                              />
                              {' times'}
                            </>
                          )}
                        </span>
                      ) : step.type === 'if' ? (
                        /* F37: the condition — what decides which branch runs. */
                        <span className="step-text step-text-control">
                          🔀 If{' '}
                          <select
                            className="control-sel"
                            value={step.condKind ?? 'element-visible'}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateStepField(i, { condKind: e.target.value as ConditionKind })
                            }
                          >
                            <option value="element-visible">element is visible</option>
                            <option value="element-absent">element is NOT there</option>
                            <option value="text-present">page contains text</option>
                            <option value="text-absent">page does NOT contain text</option>
                            <option value="url-contains">URL contains</option>
                          </select>{' '}
                          {step.condKind === 'text-present' ||
                          step.condKind === 'text-absent' ||
                          step.condKind === 'url-contains' ? (
                            <input
                              className="control-text"
                              value={step.value ?? ''}
                              placeholder="text…"
                              disabled={!canEdit}
                              onChange={(e) => updateStepField(i, { value: e.target.value })}
                            />
                          ) : (
                            <button
                              type="button"
                              className="control-pick"
                              disabled={!canEdit}
                              onClick={() => handleStartPickFor(i)}
                              title="Pick the element this condition tests"
                            >
                              {step.label ? `"${step.label}"` : 'pick an element…'}
                            </button>
                          )}
                        </span>
                      ) : isControl ? (
                        <span className="step-text step-text-control">{stepText(step)}</span>
                      ) : (
                        <span className="step-text">{withUrlBreaks(stepText(step))}</span>
                      )}
                      {/* F26: optional step — skipped (not failed) if absent. */}
                      {step.optional && (
                        <span
                          className="optional-badge"
                          title="Optional — replay skips this (doesn’t fail) if its element isn’t present. Export wraps it in try/catch."
                        >
                          ◆ optional
                        </span>
                      )}
                      {step.teardown && (
                        <span
                          className="teardown-badge"
                          title="Teardown — runs even when an earlier step fails and ends the run, so the data this test created is always cleaned up."
                        >
                          🧹 teardown
                        </span>
                      )}
                      {/* F27: this step creates persistent data — tracked for orphan risk. */}
                      {step.createsData && (
                        <span
                          className="createsdata-badge"
                          title={`Creates data: ${step.createsData}. A suite flags this test if nothing (a 🧹 teardown) cleans it up.`}
                        >
                          🗃️ creates: {step.createsData}
                        </span>
                      )}
                      {/* F24.2: this step enforces a contract. Without a badge, a contract
                          was invisible from the list — you had to open each response modal
                          one at a time to find out which steps had one, which is how one
                          ends up pinned to the wrong step and nobody notices. */}
                      {step.type === 'api' &&
                        step.apiContract &&
                        Object.keys(step.apiContract).length > 0 && (
                          <span
                            className="contract-badge"
                            title={`Contract — ${fieldCount(Object.keys(step.apiContract).length)} enforced: ${Object.keys(
                              step.apiContract
                            )
                              .slice(0, 12)
                              .join(', ')}${Object.keys(step.apiContract).length > 12 ? ', …' : ''}. The step fails if any is renamed, dropped, or changes type — even when the status is 200.`}
                          >
                            📐 {fieldCount(Object.keys(step.apiContract).length)}
                          </span>
                        )}
                      {/* F6: dead/weak assertion warning — a check that verifies
                          little or nothing, with a fix hint on hover. */}
                      {weakByIndex.has(i) && (
                        <span
                          className={`weak-check ${weakByIndex.get(i)!.severity}`}
                          title={`${weakByIndex.get(i)!.severity === 'dead' ? 'Dead check (always passes)' : 'Weak check'} — ${weakByIndex.get(i)!.reason}`}
                        >
                          ⚠ {weakByIndex.get(i)!.severity === 'dead' ? 'dead check' : 'weak check'}
                        </span>
                      )}
                      {step.type === 'block' && (
                        <span
                          className="block-badge"
                          title="A live-linked block — editing the block updates this test. Expand it from the 🧩 Blocks panel."
                        >
                          🔗 {step.blockRef ? (blockCache[step.blockRef]?.length ?? '…') : 0} steps
                        </span>
                      )}
                      {/* Day 17/18: tab provenance. In a multi-tab recording EVERY
                          step shows which tab it RUNS ON — the original is "main
                          tab", popups are tab 1, 2, 3… (Day 18: original was
                          previously unbadged, which read as "never shows tab 0"). */}
                      {multiWindow && (
                        <span
                          className="window-badge"
                          title={
                            (step.windowId ?? 0) === 0
                              ? 'Runs on the main (original) tab'
                              : `Runs on tab ${step.windowId} — a stable id = the order this tab was opened in the recording (like Playwright's page0/page1…). Ids never repeat, so a number can be higher than the count of tabs open right now.`
                          }
                        >
                          ⧉ {(step.windowId ?? 0) === 0 ? 'main tab' : `tab ${step.windowId}`}
                        </span>
                      )}
                      {step.opensWindow !== undefined && (
                        <span
                          className="window-badge opens"
                          title={`This click opens tab ${step.opensWindow} — a new browser tab. Tab numbers are stable open-order ids and never reuse, so they can climb past the number of tabs currently open.`}
                        >
                          ↗ opens tab {step.opensWindow}
                        </span>
                      )}
                      {step.selector && (
                        <button
                          type="button"
                          className="step-selector"
                          onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
                          title={`stability ${primaryCandidate(step)?.score ?? '?'}/100 — click to see all ways to find this element`}
                        >
                          <span
                            className={`stability-dot ${stabilityClass(primaryCandidate(step)?.score)}`}
                          />
                          <code>{step.selector}</code>
                          <span className="selector-caret">{expandedIndex === i ? '▾' : '▸'}</span>
                        </button>
                      )}
                      {primaryCandidate(step)?.kind === 'anchored' && (
                        <span
                          className="anchored-note"
                          title="No stable id / role / text of its own — located via a parent element and its position. Reliable for now, but may break if the page's structure changes."
                        >
                          ⚓ position-based
                        </span>
                      )}
                      {healedIndices.has(i) && (
                        <span
                          className="healed-tag"
                          title="Selector healed by re-pick — 💾 save to keep it"
                        >
                          🔧 healed
                        </span>
                      )}
                      {/* F4: main auto-repaired this selector mid-run. Shows live
                          (aiHealedIndices) AND after save/reload (step.healedByAi). */}
                      {(aiHealedIndices.has(i) || step.healedByAi) && (
                        <span
                          className="healed-tag ai-healed-tag"
                          title={
                            step.healedByAi
                              ? `Selector auto-healed by AI and re-verified by re-running the step (confidence ${step.healedByAi.score}/100) — 💾 save to keep the fix`
                              : 'Selector auto-healed by AI this run — 💾 save to keep it'
                          }
                        >
                          🤖 fixed by AI
                          {/* Surface the matched clues INLINE (no hover needed) — the
                              3-clue → 5-clue story is visible at a glance. */}
                          {step.healedByAi?.signals?.length ? (
                            <span className="ai-healed-signals">
                              {' · '}
                              {step.healedByAi.signals.join(' + ')}
                            </span>
                          ) : null}
                        </span>
                      )}
                      {/* Day 16(+): downloads auto-save silently — give a one-click
                          way to confirm/open the saved file in its folder. */}
                      {step.type === 'download' && step.downloadPath && (
                        <button
                          type="button"
                          className="step-selector"
                          onClick={() => window.api.recorder.revealDownload(step.downloadPath!)}
                          title={`Show "${step.label}" in its folder`}
                        >
                          📂 Show in folder
                        </button>
                      )}
                      {insertMenuIndex === i && canEdit && (
                        <div className="insert-menu">
                          <button type="button" onClick={() => handleStartPick(i + 1)}>
                            ✓ Add check here
                          </button>
                          <button type="button" onClick={() => handleAddWait(i + 1, 'time')}>
                            ⏱ Wait 2s (fixed pause)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddWait(i + 1, 'network-idle')}
                            title="Wait until the page stops making network requests — better than a guessed sleep after a load"
                          >
                            🌐 Wait for network idle
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddWait(i + 1, 'text')}
                            title="Wait until specific text appears on the page — then edit the text on the new step"
                          >
                            🔤 Wait for text…
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddWait(i + 1, 'manual')}
                            title="Pause replay for a human step (2FA / CAPTCHA / manual check), then continue when you're done"
                          >
                            🙋 Wait for me (manual)…
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddApiStep(i + 1)}
                            title="Fire an HTTP request and assert on the response (status / body), inline with the UI flow — API setup/teardown or contract checks"
                          >
                            🔌 API request…
                          </button>
                          <button type="button" onClick={() => openBlocksPanel(i + 1)}>
                            🧩 Insert block here
                          </button>
                          {/* F37: loops + branching. Each inserts a matched PAIR
                              of markers, so the structure is always valid — you
                              can't create an unclosed loop by accident, and the
                              steps you want inside just get dragged in. */}
                          <button
                            type="button"
                            onClick={() => handleAddRepeat(i + 1, 'times')}
                            title="Repeat the steps inside this loop a fixed number of times"
                          >
                            🔁 Repeat N times…
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddRepeat(i + 1, 'each')}
                            title="Repeat the steps inside once per matching element — pick the element after adding"
                          >
                            🔁 For each element…
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddIf(i + 1)}
                            title="Run the steps inside only when a condition is true (e.g. a cookie banner appeared)"
                          >
                            🔀 If… / Otherwise
                          </button>
                        </div>
                      )}
                      {expandedIndex === i && step.candidates && step.candidates.length > 0 && (
                        <ul className="candidate-list">
                          {step.candidates
                            // Hide the bare-tag last resort (kind 'css', e.g.
                            // locator('a')): replay refuses to use it, so
                            // offering it as a pick would be a false choice.
                            .map((c, ci) => ({ c, ci }))
                            .filter(({ c }) => c.kind !== 'css')
                            .map(({ c, ci }) => (
                              <li key={ci}>
                                <button
                                  type="button"
                                  className={`candidate${step.selector === c.locator ? ' chosen' : ''}`}
                                  onClick={() => handlePickCandidate(i, ci)}
                                  disabled={!canEdit}
                                  title={
                                    step.selector === c.locator
                                      ? 'Current primary selector'
                                      : 'Use this selector instead'
                                  }
                                >
                                  <span className={`stability-dot ${stabilityClass(c.score)}`} />
                                  <span className="candidate-kind">{c.kind}</span>
                                  <code className="candidate-locator">{c.locator}</code>
                                  <span className="candidate-score">{c.score}</span>
                                  {step.selector === c.locator && (
                                    <span className="candidate-check">✓</span>
                                  )}
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                    {/* A <fieldset disabled> natively disables every control inside it, so
                        the bar can be SHOWN-but-inert while recording/replaying without
                        touching all ten buttons. It used to be omitted entirely, which
                        made the panel look like it had simply lost the ＋ — with nothing
                        anywhere saying that stopping the recording brings it back. */}
                    {editingIndex !== i && (
                      <fieldset
                        className={`step-actions${canEdit ? '' : ' locked'}`}
                        disabled={!canEdit}
                        title={
                          canEdit
                            ? undefined
                            : isRecording
                              ? '⏹ Stop recording to edit steps or add an API request'
                              : 'Steps can’t be edited while a replay is running'
                        }
                      >
                        <button
                          className="step-action"
                          onClick={() => handleMoveStep(i, -1)}
                          disabled={i === 0}
                          title="Move up"
                          aria-label="Move up"
                        >
                          ↑
                        </button>
                        <button
                          className="step-action"
                          onClick={() => handleMoveStep(i, 1)}
                          disabled={i === steps.length - 1}
                          title="Move down"
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                        {editable && (
                          <button
                            className="step-action"
                            onClick={() => handleStartEdit(i)}
                            title={step.type === 'upload' ? 'Change file' : 'Edit value'}
                            aria-label={step.type === 'upload' ? 'Change file' : 'Edit value'}
                          >
                            ✎
                          </button>
                        )}
                        {/* Day 20: turn this value into a {{variable}} for the
                            data table (the only way to parameterize a password). */}
                        {canParameterize(step) && (
                          <button
                            className="step-action"
                            onClick={() => handleParameterize(i)}
                            title="Make this value a variable ({{…}}) for data-driven runs"
                            aria-label="Make variable"
                          >
                            {'{}'}
                          </button>
                        )}
                        {/* F26: mark this step optional — skipped (not failed)
                            when its element isn't present (e.g. a cookie banner). */}
                        {canBeOptional(step) && (
                          <button
                            className={`step-action${step.optional ? ' optional-on' : ''}`}
                            onClick={() => handleToggleOptional(i)}
                            title={
                              step.optional
                                ? 'Optional — currently skipped if not present. Click to make required.'
                                : 'Make optional — skip this step (don’t fail) if its element isn’t present'
                            }
                            aria-label={step.optional ? 'Make required' : 'Make optional'}
                          >
                            {step.optional ? '◆' : '◇'}
                          </button>
                        )}
                        {/* F24.4: mark an API step as CLEANUP — it runs even when
                            an earlier step failed and ended the run, so a broken
                            test still deletes the data it created. */}
                        {step.type === 'api' && (
                          <button
                            className={`step-action${step.teardown ? ' teardown-on' : ''}`}
                            onClick={() =>
                              editSteps(
                                steps.map((s, idx) =>
                                  idx === i ? { ...s, teardown: !s.teardown } : s
                                )
                              )
                            }
                            title={
                              step.teardown
                                ? 'Teardown — runs even if the test fails earlier, so cleanup always happens. Click to make it a normal step.'
                                : 'Make this a teardown (cleanup) step — it will run even when an earlier step fails, so the data this test created is never orphaned'
                            }
                            aria-label={step.teardown ? 'Make normal step' : 'Make teardown step'}
                          >
                            🧹
                          </button>
                        )}
                        {/* F27: mark a step that creates persistent data (orphan tracking). */}
                        <button
                          className={`step-action${step.createsData ? ' creates-data-on' : ''}`}
                          onClick={() => handleToggleCreatesData(i)}
                          title={
                            step.createsData
                              ? `Creates data: ${step.createsData} — click to clear`
                              : 'Mark as "creates data": a suite flags tests that create data but have no teardown to clean it up'
                          }
                          aria-label={step.createsData ? 'Clear creates-data marker' : 'Mark as creates data'}
                        >
                          🗃️
                        </button>
                        <button
                          className="step-action"
                          onClick={() => handleToggleDisabled(i)}
                          title={step.disabled ? 'Enable step' : 'Disable step'}
                          aria-label={step.disabled ? 'Enable step' : 'Disable step'}
                        >
                          {step.disabled ? '↺' : '⊘'}
                        </button>
                        <button
                          className="step-action"
                          onClick={() => setInsertMenuIndex(insertMenuIndex === i ? null : i)}
                          title="Insert a step below this one"
                          aria-label="Insert below"
                        >
                          ＋
                        </button>
                        {/* Duplicate: drop a copy of this step right below it. */}
                        <button
                          className="step-action"
                          onClick={() => handleDuplicateStep(i)}
                          title="Duplicate this step"
                          aria-label="Duplicate step"
                        >
                          ⎘
                        </button>
                        <button
                          className="step-action danger"
                          onClick={() => handleDeleteStep(i)}
                          title="Delete step"
                          aria-label="Delete step"
                        >
                          ✕
                        </button>
                      </fieldset>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </aside>
      </div>

      {f40Modals}
      {suiteReport}

      {/* === Day 20: data-run overview popup — auto-appears when the matrix
           finishes (which rows passed / failed). Drilling into a row's
           screenshot/recording/explanation is done from the inline panel tabs. */}
      {dataPopupOpen && dataRun && (
        <div className="modal-backdrop" onClick={() => setDataPopupDismissed(true)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                Data run: {dataRun.results.filter((r) => r.status === 'passed').length} passed,{' '}
                {dataRun.results.filter((r) => r.status === 'failed').length} failed
              </span>
              <button
                className="modal-close"
                onClick={() => setDataPopupDismissed(true)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <ul className="suite-summary">
              {dataRun.results.map((r, ri) => (
                <li key={ri} className="suite-result">
                  <span className={`run-dot ${r.status}`} />
                  <span className="suite-result-name">{r.label}</span>
                  {r.status === 'failed' && (
                    // title: the CSS clamps at 5 lines, so a genuinely enormous error is
                    // still recoverable on hover rather than lost.
                    <span
                      className="suite-result-error"
                      title={`${r.failedAt !== undefined ? `step ${r.failedAt + 1} — ` : ''}${r.error ?? ''}`}
                    >
                      {r.failedAt !== undefined ? `step ${r.failedAt + 1} — ` : ''}
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="modal-footer">
              <span className="data-popup-hint">
                Screenshots, recordings &amp; explanations are in the panel tabs.
              </span>
              <button className="modal-btn primary" onClick={() => setDataPopupDismissed(true)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Day 13: failure analysis + bug report modal. One overlay, two
          views: the diagnosis first, the generated report after the button.
          A modal is safe here even mid-recovery — setOverlay hides the
          native pane while it's open and restores it on close. === */}
      {analysisOpen && (
        <div className="modal-backdrop" onClick={closeAnalysis}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {bugReport ? '🐞 Bug report' : '💡 Failure analysis'}
              </span>
              <button className="modal-close" onClick={closeAnalysis} aria-label="Close">
                ✕
              </button>
            </div>
            {bugReport ? (
              <pre className="modal-code">
                <code>{bugReport}</code>
              </pre>
            ) : analyzing ? (
              <div className="analysis-body">
                <p className="analysis-waiting">
                  {isDeep
                    ? '🔬 Deep RCA — reading the whole trace and every step screenshot to find the root cause. This takes longer than a normal explain…'
                    : 'Analyzing the failure… asking Claude first — if it isn’t available, this falls back to the built-in rules automatically.'}
                </p>
              </div>
            ) : analysis ? (
              <div className="analysis-body">
                <div className="analysis-meta">
                  <span className={`verdict-chip ${analysis.verdict}`}>
                    {VERDICT_LABELS[analysis.verdict] ?? analysis.verdict}
                  </span>
                  {analysis.category && (
                    <span className={`category-chip cat-${analysis.category}`}>
                      {CATEGORY_LABELS[analysis.category] ?? analysis.category}
                    </span>
                  )}
                  <span className="analysis-source">
                    {isDeep && <span className="deep-badge">🔬 Deep RCA · </span>}
                    {analysis.source === 'ai'
                      ? 'analyzed by Claude'
                      : 'built-in rules (Claude unavailable)'}
                  </span>
                </div>
                <p className="analysis-text">{analysis.explanation}</p>
                {analysis.impact && (
                  <p className="analysis-impact">
                    <strong>Impact:</strong> {analysis.impact}
                  </p>
                )}
                {analysis.suggestion && (
                  <p className="analysis-suggestion">→ {analysis.suggestion}</p>
                )}
                {lastEvidence &&
                (lastEvidence.consoleErrors.length > 0 || lastEvidence.networkErrors.length > 0) ? (
                  <div className="analysis-evidence">
                    {lastEvidence.consoleErrors.length > 0 && (
                      <>
                        <span className="evidence-title">
                          Console errors ({lastEvidence.consoleErrors.length})
                        </span>
                        <pre className="evidence-lines">
                          {lastEvidence.consoleErrors.slice(0, 6).join('\n')}
                        </pre>
                      </>
                    )}
                    {lastEvidence.networkErrors.length > 0 && (
                      <>
                        <span className="evidence-title">
                          Network problems ({lastEvidence.networkErrors.length})
                        </span>
                        <div className="evidence-lines">
                          {siteFirstLines(lastEvidence.networkErrors)
                            .slice(0, 6)
                            .map((line, li) => (
                              <div
                                key={li}
                                className={`evidence-line${isThirdPartyLine(line) ? ' dim' : ''}`}
                              >
                                {line}
                              </div>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="analysis-noevidence">
                    No console or network errors were captured during this run.
                  </p>
                )}
              </div>
            ) : null}
            <div className="modal-footer">
              {bugReport ? (
                <>
                  {reportSavedPath && (
                    <span className="saved-path">Saved to {reportSavedPath}</span>
                  )}
                  <button className="modal-btn" onClick={() => setBugReport(null)}>
                    ← Analysis
                  </button>
                  <button className="modal-btn" onClick={handleCopyReport}>
                    Copy
                  </button>
                  {/* F34: turn this failure into a Jira ticket. */}
                  <button
                    className="modal-btn"
                    onClick={handleOpenJira}
                    title="Create a Jira ticket from this failure — pre-filled summary + the whole report as the description. Push it via API, or copy + open Jira's create page."
                  >
                    🎫 Jira
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleSaveReport}
                    title="Save as Markdown — paste into GitHub, Jira, Slack, a wiki, or Claude"
                  >
                    Save .md
                  </button>
                </>
              ) : (
                <>
                  <button className="modal-btn" onClick={closeAnalysis}>
                    Close
                  </button>
                  {/* F9 Stage 3: opt-in deep root-cause over the whole trace —
                      only when a run trace was kept, and not mid-analysis. */}
                  {lastTraceId && !analyzing && (
                    <button
                      className="modal-btn"
                      onClick={handleDeepRca}
                      title="Deep RCA: feed the WHOLE run trace — every step's screenshot, DOM, console/network — to Claude to find a root cause that may be earlier than where it failed. Slower; uses the saved trace."
                    >
                      🔬 Deep RCA
                    </button>
                  )}
                  <button
                    className="modal-btn primary"
                    onClick={handleGenerateReport}
                    disabled={analyzing || !lastEvidence}
                    title="Turn this failure into a ready-to-paste markdown bug report"
                  >
                    🐞 Generate bug report
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* === F12: version history — past edits on the left, a git-style diff
           of the selected version vs the current steps on the right, with a
           one-click restore. === */}
      {historyOpen && (
        <div className="modal-backdrop" onClick={() => setHistoryOpen(false)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🕘 Version history — {testName || 'this test'}</span>
              <button
                className="modal-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="history-body">
              <div className="history-versions">
                {testVersions.map((v, vi) => {
                  const c = diffCounts(v.steps as RecorderStep[], steps)
                  return (
                    <button
                      key={vi}
                      className={`history-version${vi === historyIdx ? ' active' : ''}`}
                      onClick={() => setHistoryIdx(vi)}
                    >
                      <span className="history-version-when">
                        {vi === 0 ? 'Previous edit' : `Edit −${vi}`} ·{' '}
                        {new Date(v.at).toLocaleString()}
                      </span>
                      <span className="history-version-counts">
                        {(v.steps as RecorderStep[]).length} steps
                        {c.added > 0 && <span className="diff-add"> +{c.added}</span>}
                        {c.removed > 0 && <span className="diff-del"> −{c.removed}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="history-diff">
                <div className="history-diff-head">
                  This version → <strong>current</strong> (green = added since, red = removed)
                </div>
                {testVersions[historyIdx] &&
                  diffSteps(testVersions[historyIdx].steps as RecorderStep[], steps).map(
                    (line, li) => (
                      <div key={li} className={`diff-line ${line.kind}`}>
                        <span className="diff-mark">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                        </span>
                        {line.text}
                      </div>
                    )
                  )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setHistoryOpen(false)}>
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleRestoreVersion}
                title="Replace the current steps with this version (your current steps are saved as a new version when you next save)"
              >
                ↩ Restore this version
              </button>
            </div>
          </div>
        </div>
      )}

      {/* F25: environment / config manager — defined once above (opened from the
          library AND this workspace), rendered here for the workspace screen. */}
      {envManagerModal}
      {/* F32: the monitors dashboard. It was rendered ONLY in the welcome return,
          so monitors were invisible and unmanageable the moment you loaded a
          test — you couldn't watch a scheduled run, pause one that was about to
          fire, or reschedule it without going Home (which drops an unsaved
          recording). Same modal object, rendered on both screens. */}
      {monitorsModal}
      {/* F23: coverage gap map — crawled from the workspace's live browser. */}
      {coverageModal}

      {/* === F20: edge-case picker — choose which text fields and which families
           (empty / boundary / invalid / injection) to explode, then run. === */}
      {edgeModalOpen &&
        (() => {
          const fields = fillableFields(edgeFlat)
          const count = countEdgeCases(edgeFlat, [...edgeFields], edgeGroups)
          // Only a real `assert` is a success check. A snapshot/a11y/perf step is NOT a
    // pass/fail signal for "was the bad input accepted" — the exported negative suite
    // says exactly this and negates `assert` steps only (playwrightExport.ts). Counting
    // snapshots here let the verdict claim a certainty the evidence couldn't support.
    const hasAssertion = edgeFlat.some((s) => s.type === 'assert')
          return (
            <div className="modal-backdrop" onClick={() => setEdgeModalOpen(false)}>
              <div className="env-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">🧨 Explode into edge cases</span>
                  <button
                    className="modal-close"
                    onClick={() => setEdgeModalOpen(false)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                {fields.length === 0 ? (
                  <div className="env-list">
                    <div className="env-empty">
                      This test has no text input fields to explode. Record a flow that types into
                      a form first (e.g. a login or signup).
                    </div>
                    <div className="modal-footer">
                      <button className="modal-btn" onClick={() => setEdgeModalOpen(false)}>
                        Close
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="env-edit">
                    <p className="env-list-intro">
                      Generate negative variants of your inputs and run them. Each variant is your
                      flow with ONE field swapped for a hostile value; everything else keeps its
                      valid value. The saved test isn&rsquo;t changed.
                    </p>

                    <div className="edge-section">
                      <span className="env-field-label">Fields to explode</span>
                      {fields.map((f) => (
                        <label key={f.index} className="edge-check">
                          <input
                            type="checkbox"
                            checked={edgeFields.has(f.index)}
                            onChange={(e) => {
                              const next = new Set(edgeFields)
                              if (e.target.checked) next.add(f.index)
                              else next.delete(f.index)
                              setEdgeFields(next)
                            }}
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>

                    {/* F20 (B): show HOW the verdict will be reached before the run,
                        and let it be overridden. A verdict the user can't see the
                        basis of is the reason "accepted vs rejected" was trusted
                        when it was a guess. */}
                    <div className="edge-section">
                      <span className="env-field-label">How success is judged</span>
                      <p className="env-list-intro edge-judge-note">
                        {hasAssertion ? (
                          <>
                            This test has a ✓ check, so that decides it: a variant whose check
                            still passes was <strong>accepted</strong>; one that fails was{' '}
                            <strong>rejected</strong>.
                          </>
                        ) : (
                          <>
                            No ✓ check in this test, so the valid-input <strong>baseline</strong>{' '}
                            runs first to learn what success looks like. A variant that ends on a
                            different page was <strong>rejected</strong>. If the baseline
                            doesn&rsquo;t move the page at all, no verdict is possible and every
                            variant is reported undetermined rather than guessed.
                          </>
                        )}
                      </p>
                      <label className="env-field-label edge-judge-label" htmlFor="edge-success-url">
                        Or set it explicitly — success = URL contains
                      </label>
                      <input
                        id="edge-success-url"
                        className="env-input"
                        value={edgeSuccessUrl}
                        onChange={(e) => setEdgeSuccessUrl(e.target.value)}
                        placeholder="e.g. inventory.html  (leave blank to judge automatically)"
                      />
                    </div>

                    <div className="edge-section">
                      <span className="env-field-label">Families</span>
                      {(Object.keys(EDGE_GROUP_LABELS) as EdgeGroup[]).map((g) => (
                        <label key={g} className="edge-check">
                          <input
                            type="checkbox"
                            checked={edgeGroups.has(g)}
                            onChange={(e) => {
                              const next = new Set(edgeGroups)
                              if (e.target.checked) next.add(g)
                              else next.delete(g)
                              setEdgeGroups(next)
                            }}
                          />
                          {EDGE_GROUP_LABELS[g]}
                        </label>
                      ))}
                    </div>

                    {!hasAssertion && (
                      <div className="edge-warn">
                        ⚠ This test has no success check (assertion). Edge cases can still run, but
                        &ldquo;the app accepted vs rejected the bad input&rdquo; can&rsquo;t be
                        judged reliably — add a check (e.g. <code>URL contains …</code>) for a
                        meaningful verdict.
                      </div>
                    )}

                    <div className="modal-footer">
                      <span className="edge-count">
                        {count} variant{count === 1 ? '' : 's'} + 1 baseline
                      </span>
                      <button className="modal-btn" onClick={() => setEdgeModalOpen(false)}>
                        Cancel
                      </button>
                      <button
                        className="modal-btn primary"
                        disabled={count === 0}
                        onClick={handleRunEdgeCases}
                      >
                        Generate &amp; run
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

      {/* === F20: edge-case report — per-variant verdict (accepted / rejected),
           computed against the happy-path baseline. Only shown once the batch
           is DONE; while running, progress is an inline strip in the steps panel
           (above) so the browser stays visible. === */}
      {edgeRun &&
        !edgeRun.running &&
        edgeReportOpen &&
        (() => {
          const baseline = edgeRun.results.find((r) => r.case.baseline)
          const baselineOk = !!baseline?.ok
          const variants = edgeRun.results.filter((r) => !r.case.baseline)
          const ctx = edgeCtxOf(edgeRun)
          const verdictOf = (r: (typeof variants)[number]): 'accepted' | 'rejected' | 'unknown' =>
            edgeVerdict(r, ctx).verdict
          const ranked = [...variants].sort(
            (a, b) => (verdictOf(a) === 'accepted' ? 0 : 1) - (verdictOf(b) === 'accepted' ? 0 : 1)
          )
          const acceptedCount = variants.filter((r) => verdictOf(r) === 'accepted').length
          const rejectedCount = variants.filter((r) => verdictOf(r) === 'rejected').length
          const undeterminedCount = variants.length - acceptedCount - rejectedCount
          const basisNote = edgeBasisNote(ctx)
          return (
            <div className="modal-backdrop" onClick={() => setEdgeReportOpen(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">
                    🧨 Edge cases — {variants.length} run
                    {edgeViewingHistory ? ' (saved)' : ''}
                  </span>
                  <button
                    className="modal-close"
                    onClick={() => setEdgeReportOpen(false)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                {edgeRun.running && (
                  <div className="edge-progress">
                    Running <strong>{edgeRun.currentLabel}</strong> ({edgeRun.current}/
                    {edgeRun.total})…
                  </div>
                )}

                {!baselineOk && baseline && (
                  <div className="edge-warn edge-warn-block">
                    ⚠ The happy-path baseline FAILED — fix the test first. Verdicts below are
                    unreliable until the valid inputs pass.
                  </div>
                )}
                {/* Only warn when we genuinely can't judge. With no ✓ check we now
                    fall back to the baseline's final URL, so "no assertion" is no
                    longer the same thing as "no verdict". */}
                {undeterminedCount === variants.length && baselineOk && (
                  <div className="edge-warn edge-warn-block">
                    ⚠ No success check in this test, and the valid-input baseline didn&rsquo;t move
                    the page — so there is nothing to compare each variant against and accepted vs
                    rejected <strong>cannot be determined</strong>. Nothing below is a finding. Add a
                    ✓ check, or set a success rule in the 🧨 dialog, and re-run.
                  </div>
                )}
                {basisNote && <div className="edge-basis-note">{basisNote}</div>}

                {!edgeRun.running && (
                  <div className="edge-summary">
                    {/* Only show accepted/rejected when they mean something. A red
                        "14 accepted" beside "0 rejected" reads as a security finding;
                        with no success check it is nothing of the kind. */}
                    {undeterminedCount === variants.length ? (
                      <span className="edge-summary-unknown">
                        ? {undeterminedCount} undetermined — no verdict possible for this run
                      </span>
                    ) : (
                      <>
                        <span className="edge-summary-accepted">
                          ⚠ {acceptedCount} accepted (review)
                        </span>
                        <span className="edge-summary-rejected">
                          ✓ {rejectedCount} rejected (handled)
                        </span>
                        {undeterminedCount > 0 && (
                          <span className="edge-summary-unknown">
                            ? {undeterminedCount} undetermined
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}

                <ul className="edge-list">
                  {ranked.map((r) => {
                    const v = verdictOf(r)
                    return (
                      <li key={r.case.id} className={`edge-item ${v}`}>
                        <span className={`edge-badge ${v}`}>
                          {v === 'accepted'
                            ? '⚠ accepted'
                            : v === 'rejected'
                              ? '✓ rejected'
                              : baselineOk
                                ? '? undetermined'
                                : '· baseline broken'}
                        </span>
                        <span className="edge-item-field">{r.case.fieldLabel}</span>
                        {r.case.group && (
                          <span className={`edge-group-chip ${r.case.group}`}>
                            {r.case.edgeLabel}
                          </span>
                        )}
                        <code className="edge-item-value">{r.case.value || '(empty)'}</code>
                        {v === 'accepted' && <span className="edge-item-hint">{r.case.hint}</span>}
                        {r.screenshotPath && (
                          <button
                            type="button"
                            className="shot-link"
                            onClick={() => window.api.library.openScreenshot(r.screenshotPath!)}
                            title="Open the screenshot from this variant"
                          >
                            📷
                          </button>
                        )}
                        {r.traceId && (
                          <button
                            type="button"
                            className="shot-link"
                            onClick={() => openTrace(r.traceId!)}
                            title="Open this variant's full run recording (every step's screenshot, console & network)"
                          >
                            🎬
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>

                {edgeSuiteSaved && (
                  <div className="edge-saved-note">
                    ✓ Negative suite saved to <code>{edgeSuiteSaved}</code> — run it with{' '}
                    <code>npx playwright test</code>. A green suite = your validation holds.
                  </div>
                )}

                <div className="modal-footer">
                  <span className="edge-foot-hint">
                    ⚠ Accepted = the app took the bad input and still succeeded — investigate.
                    ✓ Rejected = the app blocked it.
                  </span>
                  {/* Export needs the flow's steps. Live runs always have them;
                      saved runs now persist them too, so it shows on both. (Only
                      a legacy run saved before steps were persisted lacks them.) */}
                  {edgeRun.results.some((r) => r.case.steps && r.case.steps.length > 0) && (
                    <button
                      className="modal-btn"
                      onClick={handleExportEdgeSuite}
                      title="Export every variant as a runnable Playwright test that asserts the app rejects it — so these negative/security checks run in CI"
                    >
                      ⤓ Export negative suite
                    </button>
                  )}
                  <button className="modal-btn" onClick={handleCopyEdgeReport}>
                    Copy report
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={() => setEdgeReportOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

      {/* === F17: cross-browser runner — pick engines, run real Playwright,
           show per-browser pass/fail. The embedded engine is Chromium only, so
           WebKit/Firefox run via shelled-out Playwright. === */}
      {xbOpen && (
        <div className="modal-backdrop" onClick={() => !xbRunning && setXbOpen(false)}>
          <div className="env-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🧭 Cross-browser</span>
              <button
                className="modal-close"
                onClick={() => setXbOpen(false)}
                disabled={xbRunning}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {xbInstalled === false ? (
              <div className="env-list">
                <div className="edge-warn">
                  ⚠ Cross-browser needs real Playwright (the embedded engine is Chromium only).
                  Install it once, then reopen this:
                  <pre className="xb-install">npm i -D @playwright/test{'\n'}npx playwright install</pre>
                  Tip: you can run these right here by typing{' '}
                  <code>! npm i -D @playwright/test</code> then{' '}
                  <code>! npx playwright install</code>.
                </div>
                <div className="modal-footer">
                  <button className="modal-btn" onClick={() => setXbOpen(false)}>
                    Close
                  </button>
                  <button
                    className="modal-btn"
                    onClick={async () => setXbInstalled((await window.api.xbrowser.check()).installed)}
                  >
                    Re-check
                  </button>
                </div>
              </div>
            ) : xbBrowsers && (!xbBrowsers.chromium || xbNeedDownload) ? (
              // The runner shipped with the app, but the engines it drives are a
              // separate ~400 MB download that no installer should carry. This
              // is a first-run state on a teammate's machine, so it has to be
              // self-explanatory and fixable from right here.
              <div className="env-list">
                <div className="edge-warn">
                  ⚠ The test browsers aren&rsquo;t downloaded yet.
                  <p className="env-list-intro">
                    QATestFlow ships the Playwright test runner, but the browser engines it
                    drives (Chromium, Firefox, WebKit) are about 400 MB, so they&rsquo;re
                    fetched once on first use and shared with any other Playwright project on
                    this machine. Recording and in-app replay work without them &mdash; headless
                    runs, parallel suite runs and cross-browser need them.
                  </p>
                  {xbInstalling && <pre className="xb-install">{xbInstallLog}</pre>}
                  {!xbInstalling && xbInstallLog && <p className="env-list-intro">{xbInstallLog}</p>}
                </div>
                <div className="modal-footer">
                  {xbInstalling ? (
                    // Mid-download the only useful control is a way OUT. A few
                    // hundred MB with no escape is a trap on a slow or metered
                    // connection — and a first-time user is exactly who mis-clicks.
                    <button className="modal-btn danger" onClick={handleCancelInstall}>
                      Cancel download
                    </button>
                  ) : (
                    <>
                      <button className="modal-btn" onClick={() => setXbOpen(false)}>
                        Close
                      </button>
                      <button
                        className="modal-btn"
                        onClick={() => handleInstallBrowsers(['chromium'])}
                      >
                        Chromium only (~150 MB)
                      </button>
                      <button
                        className="modal-btn primary"
                        onClick={() => handleInstallBrowsers(['chromium', 'firefox', 'webkit'])}
                      >
                        ⬇ Download all three (~400 MB)
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="env-edit">
                <p className="env-list-intro">
                  Run this test on real browser engines via Playwright. Chromium is what the app
                  already uses; Firefox &amp; WebKit catch engine-specific bugs. Session / HAR /
                  upload assets aren&rsquo;t included in this run (v1).
                </p>

                <div className="edge-section">
                  <span className="env-field-label">Browsers</span>
                  {(['chromium', 'firefox', 'webkit'] as const).map((b) => (
                    <label key={b} className="edge-check">
                      <input
                        type="checkbox"
                        checked={xbSel.has(b)}
                        onChange={(e) => {
                          const next = new Set(xbSel)
                          if (e.target.checked) next.add(b)
                          else next.delete(b)
                          setXbSel(next)
                        }}
                      />
                      {b === 'chromium' ? 'Chromium' : b === 'firefox' ? 'Firefox' : 'WebKit (Safari)'}
                    </label>
                  ))}
                </div>

                {xbResult && (
                  <div className="xb-results">
                    {xbResult.message && <div className="edge-warn">{xbResult.message}</div>}
                    {xbResult.results.map((r) => (
                      <div key={r.browser} className={`xb-result ${r.ok ? 'pass' : 'fail'}`}>
                        <span className="xb-result-icon">{r.ok ? '✓' : '✗'}</span>
                        <span className="xb-result-name">{r.browser}</span>
                        {!r.ok && r.error && <span className="xb-result-error">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}

                <div className="modal-footer">
                  {xbRunning && (
                    <span className="edge-count">
                      Running on {xbSel.size} engine{xbSel.size === 1 ? '' : 's'}… (first WebKit run
                      can take a minute)
                    </span>
                  )}
                  <button className="modal-btn" onClick={() => setXbOpen(false)} disabled={xbRunning}>
                    Close
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleRunXbrowser}
                    disabled={xbRunning || xbSel.size === 0}
                  >
                    {xbRunning ? 'Running…' : `▶ Run on ${xbSel.size}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* F25 guard: host-mismatch warning, blocks the run until answered. */}
      {envWarnModal}

      {/* F39.1: same banner in the workspace return — the welcome view returns
          EARLY, so anything rendered in only one of the two is invisible in the
          other half the time. */}
      {parallelRunning && (
        <ParallelRunBanner count={suiteRun!.parallelBatch!} workers={parallelWorkers} />
      )}

      {/* F24: the API-request step editor. */}
      {apiEditorModal}

      {/* F24: what the server actually sent back (pass or fail). */}
      {apiResponseModal}

      {/* F15: the visual-snapshot settings editor. */}
      {snapEditorModal}

      {/* F18: the AI-prompt step composer. */}
      {aiPromptModal}
      {draftModal}
      {mockModal}
      {jiraModal}
      {bugPromptModal}
      {/* F27: name the data a step creates (replaces window.prompt, which
          Electron does not implement — it silently returned null). */}
      {createsDataModal}
      {/* F28: localization sweep — locale picker. */}
      {localeOpen && (
        <div className="modal-backdrop" onClick={() => setLocaleOpen(false)}>
          <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🌐 Localization sweep</span>
              <button className="modal-close" onClick={() => setLocaleOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="api-editor-body">
              <p className="api-hint">
                Replays this flow under each language and flags <strong>text overflow</strong>,{' '}
                <strong>RTL layout</strong>, and strings that never changed from the base (likely{' '}
                <strong>untranslated</strong>). The first selected locale is the base for comparison.
              </p>
              <div className="edge-section">
                <span className="env-field-label">Languages</span>
                {LOCALE_PRESETS.map((l) => (
                  <label key={l.code} className="edge-check">
                    <input
                      type="checkbox"
                      checked={localeSel.has(l.code)}
                      onChange={(e) => {
                        const next = new Set(localeSel)
                        if (e.target.checked) next.add(l.code)
                        else next.delete(l.code)
                        setLocaleSel(next)
                      }}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setLocaleOpen(false)}>
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleRunLocaleSweep}
                disabled={localeSel.size === 0}
              >
                ▶ Run on {localeSel.size} locale{localeSel.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* F28: localization sweep — per-locale results. */}
      {localeRun && !localeRun.running && localeReportOpen && (
        <div className="modal-backdrop" onClick={() => setLocaleReportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                🌐 Localization sweep — {localeRun.results.length} locale
                {localeRun.results.length === 1 ? '' : 's'}
              </span>
              <button
                className="modal-close"
                onClick={() => setLocaleReportOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="ac-body">
              <p className="api-hint">
                Each language replays your test, then checks three things: did the text
                actually <strong>translate</strong>, did the <strong>layout hold</strong>{' '}
                (no text cut off that fit fine in the base language), and did
                right-to-left languages like Arabic <strong>flip direction</strong>{' '}
                correctly. A green ✓ means all three are fine. Hover a row for the raw
                numbers.
              </p>
              {(() => {
                const rows = localeRun.results.map((r, i) => {
                  const preset = LOCALE_PRESETS.find((l) => l.code === r.locale)
                  const rtlIssue = !!preset?.rtl && r.dir !== 'rtl'
                  const untr =
                    i > 0 ? Math.round((r.unchanged / Math.max(1, r.totalTexts)) * 100) : null
                  // Overflow RELATIVE TO THE BASE locale — a site trims the same
                  // footer/menu bits in every language (even the base) by design, so
                  // only overflow the TRANSLATION adds is a real finding. Text can't be
                  // matched across locales (it's translated), so compare counts.
                  const baseOverflow = localeRun.results[0]?.overflowCount ?? 0
                  const extraOverflow = i === 0 ? 0 : Math.max(0, r.overflowCount - baseOverflow)
                  // Only flag "unchanged" when a locale is BARELY translated (≥85%
                  // identical to base = the site likely ignored the language). A normal
                  // page keeps brand names/URLs identical, so a 60% cutoff cried wolf.
                  const clean =
                    r.ok && extraOverflow === 0 && !rtlIssue && (untr === null || untr < 85)
                  return { r, i, rtlIssue, untr, baseOverflow, extraOverflow, clean }
                })
                const good = rows.filter((x) => x.clean).length
                const issues = rows.length - good
                return (
                  <>
                    <div className="ac-summary">
                      {good} of {rows.length} language{rows.length === 1 ? '' : 's'} look good
                      {issues > 0 ? ` · ${issues} need${issues === 1 ? 's' : ''} a look ⚠` : ' ✓'}
                    </div>
                    <ul className="ac-list">
                      {rows.map(({ r, i, rtlIssue, untr, baseOverflow, extraOverflow, clean }) => {
                        // Plain-English verdict. The raw dir/overflow/% live in the
                        // hover title for anyone who wants the exact numbers.
                        const plain = i === 0
                          ? 'Baseline — every other language is compared against this one.'
                          : extraOverflow > 0
                            ? `After translating, text was cut off in ${extraOverflow} spot${extraOverflow === 1 ? '' : 's'} that fit fine in the base language — the layout may break here${r.overflow.length ? ` (e.g. “${r.overflow.slice(0, 2).join('”, “')}”)` : ''}.`
                            : rtlIssue
                              ? 'This language should read right-to-left, but the page stayed left-to-right.'
                              : untr !== null && untr >= 85
                                ? `Hardly translated — ${untr}% of the on-screen text is still the base language.`
                                : r.dir === 'rtl'
                                  ? 'Translated, the layout held up, and it correctly switched to right-to-left.'
                                  : 'Translated and the layout held up — no text overflowed.'
                        const raw = `dir=${r.dir} · overflow ${r.overflowCount} (base ${baseOverflow})${untr !== null ? ` · ${untr}% unchanged from base` : ''}`
                        return (
                          <li key={r.locale} className={`ac-row ${clean ? 'covered' : 'uncovered'}`}>
                            <span className="ac-mark">{clean ? '✓' : '⚠'}</span>
                            <span className="ac-text">
                              <strong>{r.locale}</strong>
                              {i === 0 ? ' (base)' : ''}
                              {r.screenshotPath && (
                                <button
                                  className="ac-shot"
                                  onClick={() =>
                                    window.api.library.openScreenshot(r.screenshotPath!)
                                  }
                                >
                                  📷
                                </button>
                              )}
                            </span>
                            {r.ok ? (
                              <span className="ac-tests" title={raw}>
                                {plain}
                              </span>
                            ) : (
                              <span className="ac-tests" title={r.error || undefined}>
                                Couldn’t finish the run
                                {r.failedAt != null ? ` — stopped at step ${r.failedAt + 1}` : ''}
                                {r.error ? `: ${r.error}` : ''}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )
              })()}
            </div>
            <div className="modal-footer">
              <button className="modal-btn primary" onClick={() => setLocaleReportOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === F13: accessibility scan panel — WCAG A/AA violations for the
           current page, grouped by rule, each expandable to the offending
           elements + how to fix. Safe over the native pane: setOverlay hides
           it while this is open. === */}
      {a11yPanelOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!a11yScanning) setA11yScan(null)
          }}
        >
          <div className="a11y-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                ♿ Accessibility
                {a11yScan && !a11yScan.error && a11yScan.violations.length > 0 && (
                  <span className="a11y-title-count">
                    {a11yScan.violations.length} rule
                    {a11yScan.violations.length === 1 ? '' : 's'} · {a11yScan.nodeCount} element
                    {a11yScan.nodeCount === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <button
                className="modal-close"
                onClick={() => setA11yScan(null)}
                disabled={a11yScanning}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {a11yScanning ? (
              <div className="a11y-body a11y-loading">
                <span className="a11y-spinner" />
                <p>Injecting axe-core and checking this page for WCAG A/AA violations…</p>
              </div>
            ) : a11yScan?.error ? (
              <div className="a11y-body">
                <p className="a11y-error">{a11yScan.error}</p>
              </div>
            ) : a11yScan ? (
              <>
                <div className="a11y-summary">
                  <span className="a11y-summary-url" title={a11yScan.url}>
                    {a11yScan.title || a11yScan.url || 'this page'}
                  </span>
                  <span className="a11y-summary-stats">
                    {a11yScan.passCount} checks passed
                    {a11yScan.incompleteCount > 0 && ` · ${a11yScan.incompleteCount} need review`}
                  </span>
                </div>
                <div className="a11y-body">
                  {a11yScan.violations.length === 0 ? (
                    <p className="a11y-clean">🎉 No WCAG A/AA violations found on this page.</p>
                  ) : (
                    [...a11yScan.violations]
                      .sort((a, b) => a11yImpactRank(a.impact) - a11yImpactRank(b.impact))
                      .map((v) => (
                        <details className="a11y-rule" key={v.id}>
                          <summary>
                            <span className={`a11y-impact ${v.impact}`}>{v.impact}</span>
                            <span className="a11y-help">{v.help}</span>
                            <span className="a11y-node-count">
                              {v.nodes.length}
                              {v.nodes.length === 1 ? ' element' : ' elements'}
                            </span>
                          </summary>
                          <div className="a11y-rule-body">
                            <p className="a11y-desc">{v.description}</p>
                            {v.nodes.map((n, i) => (
                              <div className="a11y-node" key={i}>
                                <code className="a11y-target">{n.target}</code>
                                <pre className="a11y-html">{n.html}</pre>
                                {n.summary && <p className="a11y-fix">{n.summary}</p>}
                              </div>
                            ))}
                            <button
                              className="a11y-learn"
                              onClick={() => window.api.a11y.openHelp(v.helpUrl)}
                            >
                              Learn how to fix ↗
                            </button>
                          </div>
                        </details>
                      ))
                  )}
                  {/* F13: sticky note — what the severities mean + what to edit. */}
                  <div className="help-note">
                    <span className="help-note-title">
                      📌 What the severities mean &amp; what to edit
                    </span>
                    <ul>
                      <li>
                        <strong>critical</strong> blocks a disabled user entirely ·{' '}
                        <strong>serious</strong> major barrier · <strong>moderate</strong>{' '}
                        noticeable · <strong>minor</strong> cosmetic.
                      </li>
                      <li>
                        Each is <strong>axe-core&apos;s</strong> own rating of how much the issue
                        blocks someone using a screen reader / keyboard.
                      </li>
                      <li>
                        <strong>To edit the gate</strong> (dropdown below, or the ✎ on the step):
                        it&apos;s the <em>least severe</em> issue that still fails — e.g.{' '}
                        <em>&ldquo;serious + critical&rdquo;</em> ignores moderate/minor,{' '}
                        <em>&ldquo;any violation&rdquo;</em> fails on everything.
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : null}

            <div className="modal-footer">
              {a11yScan && !a11yScan.error && (
                <span className="a11y-add">
                  <label htmlFor="a11y-level" className="a11y-add-label">
                    Fail replay on
                  </label>
                  <select
                    id="a11y-level"
                    className="a11y-level-select"
                    value={a11yAddLevel}
                    onChange={(e) => setA11yAddLevel(e.target.value)}
                    title="Which severities should fail a replay when added as a test step"
                  >
                    <option value="critical">critical only</option>
                    <option value="serious">serious + critical</option>
                    <option value="moderate">moderate and up</option>
                    <option value="minor">any violation</option>
                  </select>
                  <button
                    className="modal-btn"
                    onClick={handleAddA11yStep}
                    title="Add this as a test step — replay fails if the page regresses on accessibility"
                  >
                    ➕ Add as test step
                  </button>
                </span>
              )}
              <button
                className="modal-btn"
                onClick={() => setA11yScan(null)}
                disabled={a11yScanning}
              >
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleA11yScan}
                disabled={a11yScanning}
              >
                ↻ Re-scan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === F14: performance panel — Core Web Vitals for the current page,
           each graded good / needs-improvement / poor, with an option to bank
           it as a "Performance check" gate step. === */}
      {perfPanelOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!perfMeasuring) setPerfResult(null)
          }}
        >
          <div className="a11y-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">⚡ Performance — Core Web Vitals</span>
              <button
                className="modal-close"
                onClick={() => setPerfResult(null)}
                disabled={perfMeasuring}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {perfMeasuring ? (
              <div className="a11y-body a11y-loading">
                <span className="a11y-spinner" />
                <p>Measuring load speed and layout stability on this page…</p>
              </div>
            ) : perfResult?.error ? (
              <div className="a11y-body">
                <p className="a11y-error">{perfResult.error}</p>
              </div>
            ) : perfResult ? (
              <>
                <div className="a11y-summary">
                  <span className="a11y-summary-url" title={perfResult.url}>
                    {perfResult.title || perfResult.url || 'this page'}
                  </span>
                  <span className="a11y-summary-stats">measured from this page load</span>
                </div>
                <div className="a11y-body">
                  <div className="perf-grid">
                    {perfResult.metrics.map((m) => (
                      <div className={`perf-metric${m.core ? ' core' : ''}`} key={m.key}>
                        <span className="perf-metric-main">
                          <span className="perf-metric-label">
                            {m.label}
                            {m.core && <span className="perf-core-tag">core</span>}
                          </span>
                          {PERF_METRIC_HELP[m.key] && (
                            <span className="perf-metric-desc">{PERF_METRIC_HELP[m.key]}</span>
                          )}
                        </span>
                        <span className="perf-metric-value">
                          {m.value == null ? '—' : `${m.value.toLocaleString()}${m.unit}`}
                        </span>
                        {m.rating ? (
                          <span className={`perf-rating ${m.rating}`}>
                            {m.rating === 'needs-improvement' ? 'needs work' : m.rating}
                          </span>
                        ) : (
                          <span className="perf-rating info">info</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* F14: sticky note — what the grades mean + what to edit. */}
                  <div className="help-note">
                    <span className="help-note-title">📌 How to read this &amp; what to edit</span>
                    <ul>
                      <li>
                        <strong>CORE</strong> (LCP, CLS) = Google&apos;s Core Web Vitals — these are
                        the <strong>only</strong> two that pass/fail the test. The rest are context.
                      </li>
                      <li>
                        <strong>Grades</strong> use Google&apos;s official limits — LCP: good ≤2.5s,
                        poor &gt;4s · CLS: good ≤0.1, poor &gt;0.25.
                      </li>
                      <li>
                        <strong>To edit the gate</strong> (dropdown below, or the ✎ on the step):{' '}
                        <em>&ldquo;a vital is poor&rdquo;</em> = lenient ·{' '}
                        <em>&ldquo;a vital is not good&rdquo;</em> = strict.
                      </li>
                      <li>
                        <strong>INFO</strong> = shown for context, no official pass/fail line, so
                        not graded.
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : null}

            <div className="modal-footer">
              {perfResult && !perfResult.error && (
                <span className="a11y-add">
                  <label htmlFor="perf-level" className="a11y-add-label">
                    Fail replay when
                  </label>
                  <select
                    id="perf-level"
                    className="a11y-level-select"
                    value={perfAddLevel}
                    onChange={(e) => setPerfAddLevel(e.target.value)}
                    title="How strict the performance gate should be when added as a test step"
                  >
                    <option value="needs-improvement">a vital is poor</option>
                    <option value="good">a vital is not good</option>
                  </select>
                  <button
                    className="modal-btn"
                    onClick={handleAddPerfStep}
                    title="Add this as a test step — replay fails if a Core Web Vital regresses"
                  >
                    ➕ Add as test step
                  </button>
                </span>
              )}
              <button
                className="modal-btn"
                onClick={() => setPerfResult(null)}
                disabled={perfMeasuring}
              >
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleMeasurePerf}
                disabled={perfMeasuring}
              >
                ↻ Re-measure
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Day 18: run-trace viewer — filmstrip of every step on the left,
           the selected step's screenshot + console/network on the right. === */}
      {traceView && (
        <div className="modal-backdrop" onClick={closeTrace}>
          <div className="trace-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trace-header">
              <span className="trace-title">
                ⏺ Run recording{traceView.testName ? ` — ${traceView.testName}` : ''}
              </span>
              <span className={`trace-result ${traceView.ok ? 'ok' : 'fail'}`}>
                {traceView.ok ? '✓ passed' : '✗ failed'}
              </span>
              <span className="trace-when">{new Date(traceView.at).toLocaleString()}</span>
              {traceSavedAt ? (
                <span className="trace-saved" title={traceSavedAt}>
                  ✓ saved
                </span>
              ) : (
                <button
                  type="button"
                  className="trace-save"
                  onClick={saveTraceRecording}
                  title="Copy this recording to a folder you choose"
                >
                  💾 Save recording
                </button>
              )}
              <button className="trace-close" onClick={closeTrace} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="trace-body">
              <ol className="trace-steps">
                {traceView.steps.map((s, pos) => (
                  <li
                    key={pos}
                    className={`trace-step ${s.status}${pos === traceStepIdx ? ' active' : ''}`}
                    onClick={() => selectTraceStep(pos)}
                  >
                    <span className="trace-step-num">{s.index + 1}</span>
                    {s.thumbData ? (
                      <img className="trace-thumb" src={s.thumbData} alt="" />
                    ) : (
                      <span className="trace-thumb empty" />
                    )}
                    <span className="trace-step-text">{s.text}</span>
                    <span className={`trace-dot ${s.status}`} />
                  </li>
                ))}
              </ol>
              <div className="trace-preview">
                {(() => {
                  const step = traceView.steps[traceStepIdx]
                  if (!step) return null
                  return (
                    <>
                      <div className="trace-preview-head">
                        <span className="trace-preview-title">
                          Step {step.index + 1}: {step.text}
                        </span>
                        <span className="trace-preview-meta">
                          {step.durationMs} ms · {step.status}
                        </span>
                      </div>
                      {step.error && <div className="trace-error">{step.error}</div>}
                      <div className="trace-shot">
                        {traceImg ? (
                          <img src={traceImg} alt="step screenshot" />
                        ) : (
                          <span className="trace-shot-loading">
                            {step.screenshotFile
                              ? 'Loading screenshot…'
                              : step.status === 'pending'
                                ? "This step didn't run — the run stopped before reaching it."
                                : step.status === 'skipped'
                                  ? 'This step was skipped — it did not run.'
                                  : 'No screenshot for this step'}
                          </span>
                        )}
                      </div>
                      {(step.consoleErrors.length > 0 || step.networkErrors.length > 0) && (
                        <div className="trace-evidence">
                          {step.consoleErrors.length > 0 && (
                            <div className="trace-ev-block">
                              <div className="trace-ev-label">Console</div>
                              {step.consoleErrors.map((l, i) => (
                                <div key={i} className="trace-ev-line">
                                  {l}
                                </div>
                              ))}
                            </div>
                          )}
                          {step.networkErrors.length > 0 && (
                            <div className="trace-ev-block">
                              <div className="trace-ev-label">Network</div>
                              {step.networkErrors.map((l, i) => (
                                <div key={i} className="trace-ev-line">
                                  {l}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="trace-file-actions">
                        {step.screenshotFile && (
                          <button
                            type="button"
                            onClick={() =>
                              window.api.trace.openFile(traceView.id, step.screenshotFile!)
                            }
                          >
                            🖼 Open full image
                          </button>
                        )}
                        {step.domFile && (
                          <button
                            type="button"
                            onClick={() => window.api.trace.openFile(traceView.id, step.domFile!)}
                          >
                            {'</>'} Open page HTML
                          </button>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* === Export preview modal === */}
      {exportCode !== null && (
        <div className="modal-backdrop" onClick={() => setExportCode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Playwright test</span>
              <button
                className="modal-close"
                onClick={() => setExportCode(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {/* An {{env:…}} token whose name the OS also defines. Warned HERE
                because this is the last moment the name can be changed — once the
                spec is in CI the symptom is a credentials failure that points
                nowhere near the cause. */}
            {exportEnvWarning.length > 0 && (
              <div className="edge-warn edge-warn-block">
                ⚠ <strong>{exportEnvWarning.join(', ')}</strong>{' '}
                {exportEnvWarning.length === 1 ? 'is also an' : 'are also'} operating-system
                environment variable{exportEnvWarning.length === 1 ? '' : 's'} — on Windows{' '}
                <code>USERNAME</code> is your login name. Read directly, the test would silently use
                that instead of your value. This export reads{' '}
                <code>QA_{exportEnvWarning[0]}</code> instead and fails fast if it isn&rsquo;t set.
                To remove the guard, rename the token to something app-specific (e.g.{' '}
                <code>{'{{env:APP_' + exportEnvWarning[0] + '}}'}</code>).
              </div>
            )}
            {/* Day 17: choose inline vs full Page Object Model output */}
            <div className="export-modes">
              <button
                type="button"
                className={`export-mode${!poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(false)}
              >
                Inline
              </button>
              <button
                type="button"
                className={`export-mode${poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(true)}
                title="Full Page Object Model: a page class (locators + methods) + a spec that drives it. Single-page tests only."
              >
                Page Object
              </button>
              {/* In POM mode, two files — tabs to switch between spec and page class */}
              {exportPage && (
                <div className="export-file-tabs">
                  <button
                    type="button"
                    className={`export-file-tab${exportTab === 'spec' ? ' chosen' : ''}`}
                    onClick={() => setExportTab('spec')}
                  >
                    spec.ts
                  </button>
                  <button
                    type="button"
                    className={`export-file-tab${exportTab === 'page' ? ' chosen' : ''}`}
                    onClick={() => setExportTab('page')}
                  >
                    {exportPageFileName}
                  </button>
                </div>
              )}
            </div>
            <pre className="modal-code">
              <code>{exportTab === 'page' && exportPage ? exportPage : exportCode}</code>
            </pre>
            <div className="modal-footer">
              {savedPath && (
                <span className="saved-path">
                  {/* Every file, named. This used to list the CI workflow and the
                      config but NOT the page class — the one file that lands in a
                      folder the user never picked, so it looked like the POM
                      export had saved only half of itself. */}
                  Saved to {savedPath}
                  {savedExtras.map((p) => (
                    <span key={p} className="saved-path-extra">
                      + {p}
                    </span>
                  ))}
                  {savedPageOverwritten && (
                    <span className="saved-path-warn">
                      ⚠ A different page class already existed at that path and was replaced. The
                      class name comes from the TEST name, so another test called “{testName ||
                        'recorded flow'}” shares this file — its spec now imports a class that no
                      longer matches it. Rename one of the tests and re-export.
                    </span>
                  )}
                </span>
              )}
              {/* F33: opt-in — write a GitHub Actions workflow beside the spec so
                  the exported tests run on every PR. */}
              <label
                className="export-ci-toggle"
                title="Also write .github/workflows/playwright.yml — runs these tests on every push / PR"
              >
                <input
                  type="checkbox"
                  checked={exportCi}
                  onChange={(e) => setExportCi(e.target.checked)}
                />
                ⚙️ CI workflow
              </label>
              {/* F17: opt-in — write a cross-browser playwright.config.ts beside
                  the spec so `npx playwright test` runs on all three engines. */}
              <label
                className="export-ci-toggle"
                title="Also write playwright.config.ts — runs the exported test on Chromium + Firefox + WebKit"
              >
                <input
                  type="checkbox"
                  checked={exportXbrowser}
                  onChange={(e) => setExportXbrowser(e.target.checked)}
                />
                🧭 Cross-browser config
              </label>
              <button className="modal-btn" onClick={handleCopyExport}>
                Copy
              </button>
              <button className="modal-btn primary" onClick={handleSaveExport}>
                {exportPage || exportCi || exportXbrowser ? 'Save files' : 'Save .ts'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default App
