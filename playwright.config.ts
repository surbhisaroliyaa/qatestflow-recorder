import { defineConfig, devices } from '@playwright/test'

// =====================================================================
// Playwright config for THIS REPO's own DOM tests (`npm run test:dom`).
//
// Not to be confused with the playwright.config.ts the app GENERATES for a
// user's exported spec (see generatePlaywrightConfig in playwrightExport.ts) —
// that one is written next to their test, never here.
//
// Why it exists at all: without a testDir, Playwright treats the whole repo as
// its test root, and `test/__snapshots__/` is full of .spec.ts golden files. A
// bare `npx playwright test` would have tried to RUN them — against real
// websites — instead of treating them as the fixture text they are.
//
// What lives in test-dom/: the replay engine builds JavaScript that gets
// injected into a page, so unlike the rest of the codebase its output can only
// be judged by executing it in a real DOM. These tests do exactly that — build
// the script for a step, run it against a hand-written page, and check what
// happened. That is how the shadow-DOM count bug surfaced.
//
// They are NOT in `npm test` (nor the pre-commit hook) because they need a real
// browser and take ~2 minutes; `npm test` has to stay at one second to be run
// constantly. Run these before pushing anything that touches replay.ts.
// =====================================================================
export default defineConfig({
  testDir: './test-dom',
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'] },
  // Several tests deliberately wait out the engine's full 30s find timeout to
  // prove the three distinct failure messages, so the default 30s is too tight.
  timeout: 60_000
})
