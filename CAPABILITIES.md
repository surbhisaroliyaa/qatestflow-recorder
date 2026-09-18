# What QATestFlow Recorder can do — and how well each part is proven

The independent QA audit (25 Aug 2026) found that the docs described everything as "built and
working" without saying how anyone knew. This page says, for each capability, **how it is proven**
and **where the evidence is**. It is updated as capabilities are tested; if a line here is wrong,
that is a bug.

| Mark                 | Meaning                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| ✅ **Hand-verified** | Exercised by hand in the real app on the date given, **and** covered by automated tests. |
| 🧪 **Automated**     | Covered by automated tests (named). Not re-checked by hand in the latest round.          |
| ⚠️ **Partial**       | Works, with the limits stated.                                                           |
| ❌ **Not built**     | Not in the product yet.                                                                  |

Hand-test rounds referenced below: **2026-09-18** (audit remediation + Electron 44 checklist) and
**Aug 2026** (integration rounds 1–11 across the whole app).

Test files: `test/` = unit (`npm test`), `test-dom/` = browser (`npm run test:dom`).

## Recording

| Capability                                                     | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clicks, typing, dropdowns, keyboard, hover, Back               | ✅ 2026-09-18 | `test-dom/observer.spec.ts`, `test/observerSource.test.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| Recording continues after the page navigates                   | ✅ 2026-09-18 | hand-test E1; `test-dom/observer.spec.ts` (nonce re-arm)                                                                                                                                                                                                                                                                                                                                                                         |
| Checkbox / radio / label click → one canonical tick step       | ✅ 2026-09-18 | `test-dom/observer.spec.ts` (checkbox contract), `test/legacyCheckSteps.test.ts`                                                                                                                                                                                                                                                                                                                                                 |
| Steps named from the page's own labels ("Tick Sports")         | ✅ 2026-09-18 | `test/selector.test.ts`, `test-dom/observer.spec.ts`                                                                                                                                                                                                                                                                                                                                                                             |
| Popups / new tabs                                              | ✅ 2026-09-18 | hand-test E2; `test/__snapshots__/multitab.spec.ts` (export)                                                                                                                                                                                                                                                                                                                                                                     |
| iframes                                                        | ✅ 2026-09-18 | hand-test E2b (practice.expandtesting.com/iframe)                                                                                                                                                                                                                                                                                                                                                                                |
| Open shadow roots                                              | 🧪            | `test-dom/observer.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                      |
| Native dialogs (alert/confirm/prompt)                          | 🧪            | `test-dom/observer.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                      |
| File upload                                                    | 🧪            | `test/portablePath.test.ts`, `test/bundle.test.ts`                                                                                                                                                                                                                                                                                                                                                                               |
| ✓ Check picker (assertions, 17 kinds)                          | ✅ 2026-09-18 | hand-test E4; `test-dom/checks.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                          |
| A tested page cannot forge steps or reach app internals        | 🧪            | The recorder runs in each frame's isolated world and sends over IPC the page can't reach; page-scripted clicks/changes are ignored. `test/observerSource.test.ts`, `test/recorderMessages.test.ts`, `test-dom/observer.spec.ts`, and `tools/e2e-smoke.mjs` — which in the real, sandboxed app also tries a page-scripted click and an imitation of the old recorder message, and requires both to be ignored. Hand-test pending. |
| Script-written iframes (rich-text editors, widgets)            | 🧪            | `tools/e2e-smoke.mjs` records **and replays** a click inside one                                                                                                                                                                                                                                                                                                                                                                 |
| Electron sandbox on for the app window and the page under test | 🧪            | `tools/check-preload-sandbox.mjs` (CI), `tools/e2e-smoke.mjs`                                                                                                                                                                                                                                                                                                                                                                    |
| Drag-and-drop, scroll, comment step types                      | ❌            | —                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Replay and resilience

| Capability                                          | Status        | Evidence                                                                                                                                                          |
| --------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay in the embedded browser                      | ✅ 2026-09-18 | hand-test E3; `test/replay.test.ts`                                                                                                                               |
| Selector ladder with fallback                       | 🧪            | `test-dom/ladder.spec.ts`, `test/selector.test.ts`                                                                                                                |
| Self-heal (auto + manual re-pick)                   | ✅ Aug 2026   | integration rounds; `test/replay.test.ts`                                                                                                                         |
| Pause-on-failure recovery (retry / continue / skip) | ✅ Aug 2026   | integration rounds                                                                                                                                                |
| Loops and if-blocks                                 | 🧪            | `test/controlFlow.test.ts`, `test/__snapshots__/controlflow.spec.ts`                                                                                              |
| HAR network capture                                 | ✅ 2026-09-18 | hand-test E5b; `test/harCapture.test.ts`, `test/har.test.ts`                                                                                                      |
| HAR replay inside the app                           | ⚠️            | `test/har.test.ts` (which response is served). Replay passed by hand (E5b); the "served from HAR" count was not recorded in that test. Only XHR/fetch are served. |
| Visual regression snapshots                         | ✅ 2026-09-18 | hand-test E6. Baselines may need re-capturing once after the Electron 44 upgrade.                                                                                 |

## Export

| Capability                                                                     | Status        | Evidence                                                                                                            |
| ------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Inline Playwright export                                                       | ✅ 2026-09-18 | `test-dom/exported-spec.spec.ts` (**runs** the generated specs in real Playwright), `test/playwrightExport.test.ts` |
| Page Object export                                                             | ✅ 2026-09-18 | same gate, both styles; `test/__snapshots__/*.pom.spec.ts`                                                          |
| Data-driven export, passwords per distinct value (`PASSWORD_1`, `PASSWORD_2`…) | ✅ 2026-09-18 | hand-test A3; `test-dom/exported-spec.spec.ts` (protected-matrix, with a teeth test)                                |
| CI workflow file (GitHub Actions)                                              | 🧪            | `test/playwrightExport.test.ts`                                                                                     |
| YAML / JSON test round-trip                                                    | ❌            | —                                                                                                                   |

## Test management and running

| Capability                                            | Status              | Evidence                                                                 |
| ----------------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Library, suites, tags, search                         | ✅ Aug 2026         | integration rounds; `test/library.test.ts`                               |
| Version history and rollback                          | 🧪                  | `test/library.test.ts`                                                   |
| Data-driven runs (per-row data tables)                | ✅ 2026-09-18       | hand-test A2 (6-row negative login); `test/dataDriven.test.ts`           |
| Environments and `{{env:…}}` variables                | 🧪                  | `test/runInputs.test.ts`, `test/osEnvNames.test.ts`                      |
| Parallel suite runs (headless Playwright)             | 🧪                  | `test/headless.test.ts`                                                  |
| Cross-browser runs                                    | 🧪                  | `test/xbrowser.test.ts`                                                  |
| Monitors (scheduled runs)                             | ⚠️                  | Aug 2026 rounds. **Only while the app is open** — no background service. |
| Shareable bundles (git-committable)                   | 🧪                  | `test/bundle.test.ts`                                                    |
| Projects above suites                                 | ❌                  | —                                                                        |
| General CLI runner, GitLab template, results postback | ❌                  | —                                                                        |
| 100+ test suites without stalling                     | ❌ not demonstrated | —                                                                        |

## Evidence and reporting

| Capability                                                           | Status        | Evidence                                                         |
| -------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| Run traces (screenshots, DOM, console, network)                      | ✅ 2026-09-18 | hand-test A4; `test/trace.test.ts`                               |
| HTML / Markdown / Jira-style reports                                 | 🧪            | `test/edgeReport.test.ts`, `test/livingDocs.test.ts`             |
| AI failure explanation (with rules fallback)                         | 🧪            | `test/translator.test.ts`                                        |
| Page-load errors shown in the app (URL, reason, Retry, Copy details) | 🧪            | `test/phase3Layout.test.ts`; checked in the built app 2026-09-18 |
| Video recordings                                                     | ❌            | —                                                                |
| Hosted share links                                                   | ❌            | —                                                                |

## Security and privacy

| Capability                                                                              | Status        | Evidence                                                                 |
| --------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| Passwords encrypted at rest (OS protection)                                             | ✅ 2026-09-18 | hand-tests 16–19; `test/secretsCodec.test.ts`                            |
| No readable password in tests, history, data tables, drafts, backups, traces, baselines | ✅ 2026-09-18 | hand-tests A1–A5 + a sweep of a real library; `test/secretCells.test.ts` |
| Passwords deleted when nothing refers to them                                           | ✅ 2026-09-18 | hand-test 19                                                             |
| Dependency audit gate (high and above blocks CI)                                        | 🧪            | `.github/workflows/ci.yml`                                               |
| Signed installer                                                                        | ❌            | unsigned; ready to sign — see RELEASING.md                               |

## The app's own accessibility

| Capability                                                                             | Status        | Evidence                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialogs: focus moves in, Tab stays inside, Esc closes, focus returns                   | ✅ 2026-09-18 | hand-tests 11–14; `test-dom/modal-a11y.spec.ts`                                                                                                                                                                                                          |
| No serious/critical axe violations (WCAG 2.1 A/AA) on the welcome screen and workspace | 🧪            | `test-dom/app-shell-a11y.spec.ts` — scans the **built** app screens on every push; on first run it found 5 contrast failures QF-004 had missed, now fixed. Screens that need saved data (library rows, step rows, most dialogs) are not in the scan yet. |
| Page language, 24×24 targets, reduced motion                                           | 🧪            | `test-dom/app-shell-a11y.spec.ts` (language); CSS                                                                                                                                                                                                        |
| Heading structure for screen readers                                                   | 🧪            | `test-dom/app-shell-a11y.spec.ts` (one h1, "Steps" h2)                                                                                                                                                                                                   |
| Resizable, collapsible steps panel; toolbar wraps on small windows                     | 🧪            | `test/phase3Layout.test.ts`; checked in the built app 2026-09-18                                                                                                                                                                                         |

## Team features

| Capability                                           | Status |
| ---------------------------------------------------- | ------ |
| Shared workspace, sign-in, roles, sync between users | ❌     |
| Comments, assignments, review/approval, audit trail  | ❌     |
