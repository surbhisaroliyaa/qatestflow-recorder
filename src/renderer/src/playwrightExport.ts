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
    case 'hover':
      return `Hover over ${step.label}`
    case 'assert':
      switch (step.assertKind) {
        case 'text-equals':
          return `Check ${step.label} text is "${step.value}"`
        case 'text-contains':
          return `Check ${step.label} contains "${step.value}"`
        case 'value':
          return `Check ${step.label} value is "${step.value}"`
        case 'enabled':
          return `Check ${step.label} is enabled`
        case 'disabled':
          return `Check ${step.label} is disabled`
        default:
          return `Check ${step.label} is visible`
      }
    case 'wait':
      return `Wait ${step.value ?? '1'}s`
    default:
      return JSON.stringify(step)
  }
}

// The actual Playwright action for one step (without the leading comment).
function actionFor(step: RecorderStep): string | null {
  if (step.type === 'navigate') {
    return `await page.goto(${quote(step.url ?? '')})`
  }

  if (step.type === 'wait') {
    const ms = Math.max(0, (parseFloat(step.value ?? '0') || 0) * 1000)
    return `await page.waitForTimeout(${ms})`
  }

  if (!step.selector) return null
  const locator = `page.${step.selector}`

  // Assertions translate 1:1 to Playwright's expect() matchers.
  if (step.type === 'assert') {
    switch (step.assertKind) {
      case 'text-equals':
        return `await expect(${locator}).toHaveText(${quote(step.value ?? '')})`
      case 'text-contains':
        return `await expect(${locator}).toContainText(${quote(step.value ?? '')})`
      case 'value':
        return `await expect(${locator}).toHaveValue(${quote(step.value ?? '')})`
      case 'enabled':
        return `await expect(${locator}).toBeEnabled()`
      case 'disabled':
        return `await expect(${locator}).toBeDisabled()`
      default:
        return `await expect(${locator}).toBeVisible()`
    }
  }

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
    case 'hover':
      // Playwright's .hover() moves the real mouse — CSS :hover reveals work.
      return `await ${locator}.hover()`
    default:
      return null
  }
}

// Build the whole test file from the recorded steps.
export function generatePlaywrightTest(steps: RecorderStep[]): string {
  const enabled = steps.filter((step) => !step.disabled)
  const body = enabled
    .map((step) => {
      const action = actionFor(step)
      if (!action) return null
      return `  // ${stepText(step)}\n  ${action}`
    })
    .filter((line): line is string => line !== null)
    .join('\n\n')

  // Only import expect when an assertion actually uses it.
  const hasAssert = enabled.some((step) => step.type === 'assert')
  const imports = hasAssert ? '{ test, expect }' : '{ test }'

  return `import ${imports} from '@playwright/test'

test('recorded flow', async ({ page }) => {
${body}
})
`
}
