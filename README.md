# QATestFlow Recorder

> A desktop QA workbench with a built-in, instrumented browser. Record a test by simply **using** a website — every click, type, and check becomes an editable, replayable, exportable test. Resilient selectors, self-healing, visual regression, run traces, and AI-assisted failure triage.

**Built with Electron + React + TypeScript, with Playwright as the export target.**

---

## What it is

Most test automation starts with writing code. QATestFlow flips that: you drive a real Chrome browser embedded in the app, and it captures what you do as a clean, human-readable list of steps. Those steps become a test you can **replay**, **edit without code**, **save to a library**, and **export to runnable Playwright**. It checks both *behavior* and *looks* (visual regression), records a scrubbable **trace** of every run, and **self-heals** broken selectors. When a replay fails, the app explains *why* — and even tells you whether it looks like an app bug or a test bug.

It's built to handle **real websites**, not just toy demo pages: iframes, Shadow DOM, native dialogs, file upload/download, popups/multiple tabs, login sessions, and responsive layouts.

## Highlights

**Record → Replay → Export, across four pillars:**

- 🎥 **Record by doing** — clicks, typing, dropdowns, keyboard (Enter-to-submit), hovers, Back navigation, and native dialogs are captured automatically, with clean labels.
- 🎯 **Resilient selectors** — every element gets a ranked ladder of locators (test-id → id → role+name → text → CSS) with a stability score; the recorder shows you the candidates and lets you hand-pick.
- ▶️ **Replay** — steps play back in the embedded browser with smart waits; each step lights up pass/fail.
- 🧰 **No-code step editor** — reorder, delete, disable, duplicate, and edit step values.
- ✅ **Assertions while recording** — point at an element and add a check (17 kinds: visible/text/value/enabled/attribute/class/count/URL/title…).
- 👁️ **Visual regression** — capture how a page *looks* as a baseline; every replay pixel-diffs against it and flags visual changes the behavioral checks are blind to (a shifted or recolored button, a broken layout). Failures show a red diff image; accept an intended new look with one click; exports `expect(page).toHaveScreenshot()`.
- 📚 **Test library** — save tests as JSON, organize into suites, run a whole suite, and inspect any past failure (error + screenshot/diff) right from the welcome screen.
- 💾 **Never lose a recording** — in-progress recordings auto-save as drafts; recover unsaved work (and browse a "Recent recordings" list) on the welcome screen.

**Built for real websites:**

- 🪟 **iframes & Shadow DOM** — records and replays *inside* embedded frames and open shadow roots (Stripe-style checkouts, web-component UIs).
- 💬 **Native dialogs** — alert / confirm / prompt are captured and auto-answered on replay.
- 📎 **File upload & download** — uploads re-upload the same file; downloads are verified (arrived, non-empty, right name).
- 🗂️ **Multiple windows / tabs** — popups open as real tabs; closing a tab is recorded too; replay opens, switches between, and closes them; export emits proper multi-page Playwright.
- 🔐 **Session reuse** — capture a logged-in session once and start other tests already authenticated (skip the login steps).
- 📱 **Viewport emulation** — run a test at Desktop / Tablet / Mobile sizes.

**Debugging, resilience & AI:**

- 🩺 **Failure recovery** — when a replay fails it *pauses* instead of dying; retry, **continue** (bypass to check later steps), skip the step, or stop.
- 🔧 **Self-heal selectors** — when a selector breaks, the app **auto-suggests a fix** by re-finding the element from its recorded label — one click to accept — or you point at it manually. (Only offered when the selector actually broke, not for assertion/timing failures.)
- ⏺ **Run trace recorder** — like Playwright's trace: every step's screenshot, DOM snapshot, and console/network is captured into a scrubbable timeline (kept always, or only on failure). Save a run as a single self-contained HTML report.
- 🤖 **AI failure translator** — explains a failure in plain English with a verdict (app-bug / test-bug / timing / environment), using captured console + network evidence. Falls back to a built-in rules engine when no AI is available.
- 🐞 **Auto bug report** — one click turns a failure into a pre-filled, copyable bug ticket.

**Export:**

- 📤 **Playwright (TypeScript)** — two styles: **Inline** (straight-line locators) or a full **Page Object Model** (a page class with locators + action methods, plus a spec that drives it). Exports `test.use({ baseURL, storageState, viewport })`, copies upload fixtures + session files, and emits multi-page code for tab flows.

## Tech stack

- **Electron** — desktop shell (native window + Node.js + an embedded Chromium browser via `WebContentsView`)
- **React + TypeScript** — the recorder UI, step editor, and library
- **electron-vite / Vite** — fast dev server + hot reload
- **Playwright** — the export target (generated tests run with `@playwright/test`)
- **Chrome DevTools Protocol (CDP)** — for true hovers, file inputs, and network/console capture during replay

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org) 20+ (includes npm) and [Git](https://git-scm.com).

```bash
git clone https://github.com/surbhisaroliyaa/qatestflow-recorder.git
cd qatestflow-recorder
npm install        # downloads deps + the Electron binary (first run takes a minute)
npm run dev        # launches the app
```

Close the window or press `Ctrl + C` in the terminal to stop.

### Quick start (using the app)

1. Type a URL (e.g. `https://www.saucedemo.com`) and hit **Go**.
2. Click **● Record** and just use the site — log in, click around.
3. Add a **✓ Check** by pointing at any element, and/or a **📸 Snapshot** to lock how the page looks.
4. Click **■ Stop**, then **▶ Replay** to watch it run — behavior *and* visuals checked together.
5. If a step fails, the run **pauses**: accept a **self-heal** suggestion, view the **⏺ recording** (trace), or read the **💡 AI explanation**.
6. Click **</> Export** to get runnable Playwright code (Inline or Page Object), and save the test to your **library** to replay it any time.

## Build a standalone app

```bash
npm run build:win     # Windows installer  → dist/
npm run build:mac     # macOS
npm run build:linux   # Linux
```

## Notes

- **Where tests are saved:** the library lives in `Documents/QATestFlow Tests` (visible, shareable JSON files — not inside this repo). A fresh clone starts with an empty library. Supporting artifacts sit beside it in hidden subfolders: visual baselines (`_baselines`), run traces (`_traces`), auto-saved drafts (`_drafts`), saved sessions (`_sessions`), and failure screenshots (`_failures`).
- **AI "Explain":** uses the [Claude CLI](https://docs.claude.com/en/docs/claude-code) headlessly via your Claude subscription. Without it, failure explanations fall back to a built-in rules engine (no API key needed either way).
- **Test site:** examples use [saucedemo.com](https://www.saucedemo.com) (`standard_user` / `secret_sauce`) and [the-internet.herokuapp.com](https://the-internet.herokuapp.com).

## Project structure

```
src/
├── main/         # Electron main process — embedded browser, recording, replay, selectors,
│                 #   library, drafts, run traces, visual diff, AI translator
├── preload/      # Safe bridge exposing window.api.* to the renderer (+ the in-page observer relay)
└── renderer/     # React UI: browser chrome, step list, editor, library, trace viewer, export
```

See [`QA-Platform-PRD.md`](./QA-Platform-PRD.md) for the original product spec.
