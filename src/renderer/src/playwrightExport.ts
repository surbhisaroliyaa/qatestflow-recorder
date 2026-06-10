// =====================================================================
// PLAYWRIGHT EXPORT
// Turns the recorded steps into a real, runnable Playwright test file.
// This is pure translation: each canonical step already carries a
// Playwright-style locator (its primary `selector`, built on Day 4), so
// we mostly wrap it with the right action (click / fill / selectOption).
// =====================================================================

// Safely wrap a value in quotes (handles quotes/newlines inside it).
function quote(value: string): string {
  return JSON.stringify(value)
}

// One readable line describing a step — used both in the live panel and as a
// comment above each generated line of code. Secret (password) values are
// shown masked so they never appear on screen or in code comments.
export function stepText(step: RecorderStep): string {
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url}`
    case 'click':
      return `Click ${step.label}`
    case 'type':
      return `Type "${step.secret ? '••••••••' : step.value}" into ${step.label}`
    case 'select':
      return `Select "${step.value}" in ${step.label}`
    case 'press':
      return `Press ${step.key ?? 'Enter'} in ${step.label}`
    default:
      return JSON.stringify(step)
  }
}

// The actual Playwright action for one step (without the leading comment).
function actionFor(step: RecorderStep): string | null {
  if (step.type === 'navigate') {
    return `await page.goto(${quote(step.url ?? '')})`
  }

  if (!step.selector) return null
  const locator = `page.${step.selector}`

  switch (step.type) {
    case 'click':
      return `await ${locator}.click()`
    case 'type':
      if (step.secret) {
        // Don't leak secrets — read the password from an environment variable.
        return `await ${locator}.fill(process.env.PASSWORD ?? '') // password field — set the PASSWORD env var`
      }
      return `await ${locator}.fill(${quote(step.value ?? '')})`
    case 'select':
      // We stored the option's VISIBLE text, so select by label.
      return `await ${locator}.selectOption({ label: ${quote(step.value ?? '')} })`
    case 'press':
      // Playwright's .press() is a real key press — it triggers form submit.
      return `await ${locator}.press(${quote(step.key ?? 'Enter')})`
    default:
      return null
  }
}

// Build the whole test file from the recorded steps.
export function generatePlaywrightTest(steps: RecorderStep[]): string {
  const body = steps
    // Steps turned off in the editor are left out of the exported test entirely.
    .filter((step) => !step.disabled)
    .map((step) => {
      const action = actionFor(step)
      if (!action) return null
      return `  // ${stepText(step)}\n  ${action}`
    })
    .filter((line): line is string => line !== null)
    .join('\n\n')

  return `import { test } from '@playwright/test'

test('recorded flow', async ({ page }) => {
${body}
})
`
}
