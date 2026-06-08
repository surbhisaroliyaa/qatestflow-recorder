# QA Platform — Product Requirements Document

**Product (working name):** Recorder
**Type:** Desktop application (Electron) with embedded browser, React UI, Node.js backend, PostgreSQL database
**Status:** Draft v1.0
**Owner:** Sameer
**Last updated:** June 1, 2026

---

## 1. Overview

### 1.1 Problem

Manual QA work is repetitive and brittle. Testers click through the same flows release after release, file bugs by hand, and re-do regression passes that barely change. The teams that *do* automate hit a different wall: writing and maintaining Playwright/Selenium scripts is an engineering skill, selectors break on every UI change, and the people who know the product best (the QAs) can't author or fix the tests themselves. The result is a gap — automation lives with developers, product knowledge lives with QA, and the handoff between them is slow and lossy.

### 1.2 Solution

A desktop QA workbench with a built-in, instrumented browser. A QA records a real session by simply *using* the app. The platform captures every interaction, resolves resilient selectors automatically, and turns the session into a clean, editable, reusable test — exportable as a Playwright script, YAML, or JSON. Recorded tests become a shared, versioned library that the whole team can replay, parameterize, schedule, and maintain — without writing code.

### 1.3 Vision

> Any QA can turn a manual test pass into durable automation in minutes, and the whole team builds on a living library of reusable flows that survives UI changes.

### 1.4 Why a desktop app

A native Electron app (rather than a browser extension or cloud-only tool) is deliberate: it gives us a fully controlled, instrumented Chromium instance, deep access to the page (DOM, network, console, storage) without extension permission limits, local-first recording that works offline, and a single workbench where browser, recorder, editor, and test library live side by side.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Let a non-technical QA record a browser session and produce a working, reusable test with zero code.
- Generate **resilient** selectors that survive minor UI changes, with a visible fallback strategy.
- Export to standard formats (Playwright, YAML, JSON) so tests aren't locked into the tool.
- Provide a test-management home: organize, version, parameterize, schedule, replay, and report.
- Make tests a team asset through sharing, a reusable-step library, and collaborative editing.

### 2.2 Non-Goals (v1)

- Mobile/native app testing (web only at launch).
- Load/performance testing.
- Full CI/CD orchestration platform (we integrate with CI; we don't replace it).
- AI-authored tests from natural-language prompts (a later bet, not MVP).
- Cross-browser grid at scale (we start with the bundled Chromium; broaden later).

### 2.3 Success Metrics

| Metric | Target |
|---|---|
| Time to create a first working test | < 10 minutes for a new user |
| Test authoring without engineering help | > 80% of tests authored by QA, not devs |
| Selector stability | < 5% of steps need manual repair per release cycle |
| Replay reliability | > 95% pass rate on unchanged flows (no flaky failures) |
| Reuse | > 40% of new tests built partly from shared library steps |
| Weekly active QAs creating/editing tests | (set after pilot) |

---

## 3. Target Users & Personas

**Maya — Manual QA Analyst (primary).** Knows the product deeply, runs regression passes by hand, not a coder. Wants to stop repeating herself and to automate without learning Playwright. Success = she records once and reuses forever.

**Raj — QA Lead / SDET (secondary).** Owns test strategy, comfortable with code, reviews and maintains the suite. Wants a clean library, version history, the ability to edit generated scripts, and CI integration. Success = a maintainable suite the whole team contributes to.

**Priya — Product Manager (tertiary).** Doesn't write tests but wants visibility into coverage and pass/fail trends before a release. Success = a readable dashboard.

---

## 4. Core Concepts & Terminology

- **Session / Recording** — a captured sequence of interactions in the built-in browser.
- **Step** — a single action or assertion (click, type, navigate, expect-visible, etc.).
- **Test** — an ordered, editable set of steps generated from a recording. The primary unit of work.
- **Selector** — how a step finds its target element; each step carries a ranked selector strategy with fallbacks.
- **Reusable Block** — a saved group of steps (e.g., "Log in", "Add to cart") that can be inserted into any test.
- **Suite** — a named collection of tests, runnable together.
- **Run** — one execution of a test or suite, with results, logs, screenshots, and artifacts.
- **Environment** — a named target (base URL, credentials, variables) a test runs against.
- **Project** — top-level workspace grouping tests, suites, environments, and members.

---

## 5. MVP Scope — The Four Pillars

The MVP is defined by four capability pillars, all in scope for v1.

### Pillar 1 — Recording & Script Generation

**The core differentiator.** The QA uses the app; the app writes the test.

**Built-in browser**
- Embedded Chromium with a normal navigation bar (URL, back/forward, reload), viewport/device presets, and a clear **Recording ON/OFF** state.
- Per-test environment context (base URL, logged-in state, cookies/storage seeding).

**Capture engine** — records, as discrete steps:
- Navigation, clicks, typing, key presses, hovers, drag/drop, file uploads, select/checkbox/radio changes, scrolling, and waits.
- Network activity and console errors as context attached to steps (for debugging and smart waits).
- Implicit waits inferred from network-idle / element-visible rather than hard-coded sleeps.

**Assertions while recording**
- A lightweight overlay lets the QA click an element and add an assertion mid-recording: element visible, text equals/contains, value equals, attribute equals, URL matches, count equals.
- One-click "snapshot/visual checkpoint" step.

**Step editor (no-code)**
- After recording, steps appear as a readable, editable list (drag to reorder, delete, duplicate, disable, add comment).
- Edit any step's target, action, value, wait condition, and selector strategy through forms — no code required.
- Insert manual steps and Reusable Blocks anywhere.

**Parameterization**
- Replace literal values with variables (`{{username}}`), pull from environment or a data table for data-driven runs (one test, many input rows).

**Export / generation**
- Generate clean, idiomatic **Playwright (TypeScript)** scripts.
- Export the same test as **YAML** and **JSON** (declarative, human-readable, re-importable).
- Round-trip principle: a test is stored in a canonical internal model; Playwright/YAML/JSON are *views* generated from it. Re-import of YAML/JSON restores the editable test.

> **Acceptance:** A QA records a login + search + add-to-cart flow, adds two assertions, parameterizes the username, and exports a Playwright script that runs green from the CLI — without writing code.

### Pillar 2 — Selector Intelligence

**Tests that don't break on every UI tweak.**

**Resilient selector generation** — for each captured element, compute a *ranked* set of candidate selectors and store them all, preferring in order:
1. Stable test attributes (`data-testid`, `data-qa`, `aria-*`, `role` + accessible name).
2. Semantic anchors (label text, button text, nearby stable text).
3. Structural/relative selectors (scoped CSS, "the button inside the row containing X").
4. XPath / position as a last resort (flagged as fragile).

**Fallback at replay time**
- If the top selector fails, the engine tries the next candidate before failing the step, and logs which selector actually matched.
- Steps whose match degraded to a fragile fallback are flagged for review.

**Selector transparency & control**
- Each step shows its active selector, the full candidate list, and a stability rating (strong / moderate / fragile).
- A picker lets the QA hover the page, highlight an element, and pick/override the selector; the tool shows match count and warns on ambiguity (multiple matches).

**Self-healing (assisted)**
- On replay, if an element moved or attributes changed, the engine attempts to re-locate via the candidate ladder and semantic similarity, then proposes a selector update for the QA to approve (one-click accept). No silent rewrites.

**Component & session selectors**
- **Component selectors:** recognize repeated UI patterns (a card, a row, a modal) so a step can target "the *N*th product card" or "the row where SKU = X" robustly.
- **Session selectors:** capture and reuse session state — logged-in cookies/tokens/storage — so tests can start from an authenticated state without re-recording login every time.

> **Acceptance:** A test authored against build A still passes against build B where a button's class names changed but its text/role stayed the same — and any step that fell back to a weaker selector is flagged.

### Pillar 3 — Test Management & Replay

**A home for tests, not just a recorder.**

**Organization**
- Projects → Suites → Tests hierarchy, with tags, search, and filters.
- Reusable Block library (create from selected steps; insert anywhere; update propagates with versioning).

**Versioning**
- Every save creates a version; view history, diff two versions step-by-step, and roll back.

**Environments & data**
- Named environments (base URL, variables, credentials/secrets, seeded session state).
- Data tables for data-driven runs; run a test once per row.

**Replay**
- Run a single test, a suite, or a tagged selection — headed (watch it) or headless.
- Live run view: current step, pass/fail, console/network panel, and the page.
- Step-through / pause / resume / re-run-from-step for debugging.

**Results & reporting**
- Per-run report: step results, duration, screenshots at each step (and on failure), console/network logs, and a video/trace where available.
- Suite dashboard: pass/fail trends over time, flaky-test detection, slowest steps, and a per-test history.
- Export results (JSON/HTML) and shareable run links.

**Scheduling & integration**
- Schedule runs (e.g., nightly regression) from within the app.
- CLI runner and CI integration (GitHub Actions / GitLab CI) so the same tests run in pipelines; results post back to the platform.

> **Acceptance:** A QA groups 12 tests into a "Checkout Regression" suite, schedules it nightly against staging, and reviews a dashboard the next morning showing which steps failed, with screenshots.

### Pillar 4 — Collaboration

**Tests are a team asset.**

- **Shared workspace:** projects, suites, tests, and the Reusable Block library are shared across team members with role-based access (Admin / Editor / Viewer).
- **Sync:** local-first authoring with sync to the central Postgres-backed server so the team sees the same library; offline edits reconcile on reconnect.
- **Review workflow:** changes to a test can be reviewed/approved before merge into the shared suite (lightweight, optional per project).
- **Comments & assignments:** comment on a test or a failing run; assign a flaky test to a teammate to fix.
- **Reusable Blocks as the collaboration unit:** "Login", "Apply coupon", etc. authored once, owned by the team, versioned, and reused — the main lever for reducing duplicated work.
- **Audit trail:** who changed what, and when.

> **Acceptance:** Raj publishes a "Login" Reusable Block; Maya inserts it into three tests; when the login UI changes, Raj updates the block once and all dependent tests pick up the fix (with a visible version bump).

---

## 6. Key User Flows

**Flow A — Record a new test (Maya)**
1. New Test → pick environment → built-in browser opens at base URL.
2. Toggle Recording ON → perform the flow → add assertions via the overlay → toggle OFF.
3. Review the generated step list; tidy, reorder, parameterize.
4. Save (creates v1) → optionally export Playwright/YAML/JSON.

**Flow B — Replay & debug**
1. Open a test → Run (headed) → watch live; on failure, the failed step is highlighted with screenshot + logs.
2. Inspect the selector; if degraded, accept the proposed self-heal or repick → re-run from the failed step → save.

**Flow C — Build a suite & schedule (Raj)**
1. Create suite → add tests by tag → assign environment.
2. Schedule nightly → configure CI to also run on PR.
3. Review dashboard; triage flaky tests; assign fixes.

**Flow D — Reuse (team)**
1. Select recurring steps → Save as Reusable Block.
2. Insert block into other tests; update once, propagate everywhere.

---

## 7. Functional Requirements (summary)

| ID | Requirement | Pillar | Priority |
|---|---|---|---|
| FR-1 | Embedded Chromium with nav controls and a clear recording state | 1 | P0 |
| FR-2 | Capture clicks, typing, navigation, selects, uploads, drag/drop, scroll, waits as discrete steps | 1 | P0 |
| FR-3 | Add assertions during recording via element-picker overlay | 1 | P0 |
| FR-4 | No-code step editor (reorder, edit, disable, comment, insert) | 1 | P0 |
| FR-5 | Parameterize values with variables and data tables | 1 | P1 |
| FR-6 | Export to Playwright (TS), YAML, JSON; re-import YAML/JSON | 1 | P0 |
| FR-7 | Ranked, resilient selector generation per element | 2 | P0 |
| FR-8 | Selector fallback ladder at replay with logging | 2 | P0 |
| FR-9 | Selector transparency UI with stability rating + manual picker | 2 | P0 |
| FR-10 | Assisted self-healing with user-approved updates | 2 | P1 |
| FR-11 | Component selectors (nth / by-content) and session-state reuse | 2 | P1 |
| FR-12 | Projects/Suites/Tests hierarchy with tags & search | 3 | P0 |
| FR-13 | Versioning with diff and rollback | 3 | P0 |
| FR-14 | Named environments with variables/secrets/seeded session | 3 | P0 |
| FR-15 | Replay single/suite/tagged, headed & headless, step-through | 3 | P0 |
| FR-16 | Run reports: steps, screenshots, logs, trace/video; suite dashboard | 3 | P0 |
| FR-17 | Scheduling and CLI/CI integration | 3 | P1 |
| FR-18 | Shared workspace with role-based access and sync | 4 | P0 |
| FR-19 | Reusable Block library with versioning & propagation | 4 | P0 |
| FR-20 | Comments, assignments, audit trail, optional review/approval | 4 | P1 |

---

## 8. Non-Functional Requirements

- **Reliability:** replay must minimize flakiness — smart waits over fixed sleeps; deterministic step ordering.
- **Performance:** recorder overhead should not visibly lag the browsed page; suites of 100+ tests run without UI stalls.
- **Local-first:** recording and authoring work offline; sync resumes on reconnect.
- **Security:** credentials/secrets encrypted at rest; secrets never written into exported scripts in plaintext (referenced via env/variables).
- **Portability:** exported Playwright/YAML/JSON run outside the app with no proprietary runtime lock-in.
- **Privacy:** captured network/DOM data stays local unless the user opts into team sync; sensitive field masking during recording.
- **Cross-platform desktop:** macOS and Windows at launch; Linux best-effort.

---

## 9. High-Level Architecture (product view)

- **Electron shell** hosts the app window and the embedded Chromium webview/`BrowserView` used for recording and replay.
- **React UI** (renderer): browser chrome, recorder controls, step editor, selector picker, test library, run dashboards.
- **Capture/replay layer:** instrumentation injected into the embedded browser to record interactions and to drive replay; Playwright as the replay/execution engine.
- **Node.js backend:** canonical test model, selector engine, script generators (Playwright/YAML/JSON), run orchestration, scheduling, CLI/CI runner, sync API.
- **PostgreSQL:** projects, tests (canonical model + versions), reusable blocks, environments, runs/results, users/roles, audit log.
- **CLI runner:** headless executor sharing the same canonical model, used in CI.

*(Detailed schema, IPC design, and the canonical step model are out of scope for this product-focused PRD and belong in a technical design doc — flagged in §11.)*

---

## 10. Phased Roadmap

**Phase 0 — Spike (proof of concept).** Embedded Chromium that records clicks/typing/navigation and replays them. Validates the riskiest piece: reliable capture + replay.

**Phase 1 — MVP (the four pillars, thin slice).**
- Recording with assertions + no-code step editor (Pillar 1).
- Ranked selectors with fallback + transparency UI (Pillar 2).
- Local test library, versioning, replay with reports (Pillar 3).
- Playwright + YAML + JSON export (Pillar 1).
- Single-user, local Postgres.

**Phase 2 — Team & scale.**
- Shared workspace, sync, roles, Reusable Block library (Pillar 4).
- Environments, data-driven runs, suites, dashboards (Pillar 3 depth).
- Assisted self-healing + component/session selectors (Pillar 2 depth).

**Phase 3 — Automation & integration.**
- Scheduling, CLI runner, CI integrations, shareable reports.
- Review/approval workflow, comments, assignments, audit (Pillar 4 depth).

**Later bets (post-roadmap):** cross-browser, natural-language test authoring, visual-regression as a first-class step, mobile web.

---

## 11. Open Questions & Risks

- **Replay flakiness is the existential risk.** If recorded tests don't replay reliably, nothing else matters. Phase 0 must prove this.
- **Selector stability vs. app instrumentation.** Resilience is dramatically easier when the app under test has `data-testid` attributes. Decide how much we lean on teams adopting test attributes vs. pure heuristic resilience.
- **Canonical model design** — the internal representation that round-trips to Playwright/YAML/JSON is the technical crux; needs its own design doc.
- **Sync & conflict resolution** for local-first multi-user editing — define the merge model before Phase 2.
- **Secrets handling** in exported scripts and CI — finalize before export ships.
- **Scope creep into a full CI platform** — hold the line on §2.2 non-goals.

---

## 12. Appendix — Example Generated Test (illustrative)

A recorded login + search flow, shown in the three export formats the same canonical test produces.

**YAML**
```yaml
test: Login and search
environment: staging
steps:
  - action: navigate
    url: "{{baseUrl}}/login"
  - action: fill
    target: { role: textbox, name: "Email" }
    value: "{{username}}"
  - action: fill
    target: { testid: "password-input" }
    value: "{{password}}"
  - action: click
    target: { role: button, name: "Sign in" }
  - action: expect
    assert: url-matches
    value: "/dashboard"
  - action: fill
    target: { role: searchbox }
    value: "wireless headphones"
  - action: press
    key: Enter
  - action: expect
    assert: visible
    target: { component: product-card, index: 0 }
```

**Playwright (TypeScript)**
```ts
import { test, expect } from '@playwright/test';

test('Login and search', async ({ page }) => {
  await page.goto(`${process.env.BASE_URL}/login`);
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.USERNAME!);
  await page.getByTestId('password-input').fill(process.env.PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.getByRole('searchbox').fill('wireless headphones');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('product-card').first()).toBeVisible();
});
```

**JSON** — the same steps as the canonical, re-importable object model (structure mirrors the YAML above).
