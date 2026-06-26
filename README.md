# QATestFlow Recorder

> A desktop QA workbench with a built-in, instrumented browser. Record a test by simply **using** a website — every click, type, and check becomes an editable, replayable, exportable test. Resilient selectors, self-healing, and AI-assisted failure triage.

**Built with Electron + React + TypeScript, with Playwright as the export target.**

---

## What it is

Most test automation starts with writing code. QATestFlow flips that: you drive a real Chrome browser embedded in the app, and it captures what you do as a clean, human-readable list of steps. Those steps become a test you can **replay**, **edit without code**, **save to a library**, and **export to runnable Playwright**. When a replay fails, the app explains *why* — and even tells you whether it looks like an app bug or a test bug.

It's built to handle **real websites**, not just toy demo pages: iframes, Shadow DOM, native dialogs, file upload/download, popups/multiple tabs, login sessions, and responsive layouts.

## Highlights

**Record → Replay → Export, across four pillars:**

- 🎥 **Record by doing** — clicks, typing, dropdowns, keyboard (Enter-to-submit), hovers, and native dialogs are captured automatically, with clean labels.
- 🎯 **Resilient selectors** — every element gets a ranked ladder of locators (test-id → id → role+name → text → CSS) with a stability score; the recorder shows you the candidates and lets you hand-pick.
- ▶️ **Replay** — steps play back in the embedded browser with smart waits; each step lights up pass/fail.
- 🧰 **No-code step editor** — reorder, delete, disable, duplicate, and edit step values.
- ✅ **Assertions while recording** — point at an element and add a check (17 kinds: visible/text/value/enabled/attribute/class/count/URL/title…).
- 📚 **Test library** — save tests as JSON, organize into suites, run a whole suite, see pass/fail history.

**Built for real websites:**

- 🪟 **iframes & Shadow DOM** — records and replays *inside* embedded frames and open shadow roots (Stripe-style checkouts, web-component UIs).
- 💬 **Native dialogs** — alert / confirm / prompt are captured and auto-answered on replay.
- 📎 **File upload & download** — uploads re-upload the same file; downloads are verified (arrived, non-empty, right name).
- 🗂️ **Multiple windows / tabs** — popups open as real tabs; replay opens and switches between them; export emits proper multi-page Playwright.
- 🔐 **Session reuse** — capture a logged-in session once and start other tests already authenticated (skip the login steps).
- 📱 **Viewport emulation** — run a test at Desktop / Tablet / Mobile sizes.

**AI & resilience:**

- 🩺 **Failure recovery** — when a replay fails it *pauses*; retry, re-pick a broken selector (self-heal), skip, or stop.
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
3. Add a **✓ Check** by pointing at any element.
4. Click **■ Stop**, then **▶ Replay** to watch it run.
5. Click **</> Export** to get runnable Playwright code (Inline or Page Object).
6. Save the test to your **library** to replay it any time.

## Build a standalone app

```bash
npm run build:win     # Windows installer  → dist/
npm run build:mac     # macOS
npm run build:linux   # Linux
```

## Notes

- **Where tests are saved:** the library lives in `Documents/QATestFlow Tests` (visible, shareable JSON files — not inside this repo). A fresh clone starts with an empty library.
- **AI "Explain":** uses the [Claude CLI](https://docs.claude.com/en/docs/claude-code) headlessly via your Claude subscription. Without it, failure explanations fall back to a built-in rules engine (no API key needed either way).
- **Test site:** examples use [saucedemo.com](https://www.saucedemo.com) (`standard_user` / `secret_sauce`) and [the-internet.herokuapp.com](https://the-internet.herokuapp.com).

## Project structure

```
src/
├── main/         # Electron main process — embedded browser, recording, replay, library, AI translator
├── preload/      # Safe bridge exposing window.api.* to the renderer (+ the in-page observer relay)
└── renderer/     # React UI: browser chrome, step list, editor, library, export
```

See [`QA-Platform-PRD.md`](./QA-Platform-PRD.md) for the original product spec.
