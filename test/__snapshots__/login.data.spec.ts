import { test } from '@playwright/test'

const dataset = [
  { username: "standard_user" },
  { username: "locked_out_user" }
]

// One test per row. Titles are pre-computed so no two can collide — Playwright
// aborts the whole run on a duplicate test title, not just the offending file.
const titles = [
  "Login — standard_user",
  "Login — locked_out_user"
]

for (const [i, data] of dataset.entries()) {
  test(titles[i], async ({ page }) => {
    // Go to https://www.saucedemo.com/
    await page.goto("https://www.saucedemo.com/")

    // Type "{{username}}" into Username
    await page.locator("[data-test=\"username\"], [data-testid=\"username\"]").fill(data.username)

    // Type "{{env:PASSWORD}}" into Password
    await page.locator("[data-test=\"password\"], [data-testid=\"password\"]").fill(process.env.PASSWORD ?? '')

    // Click Login
    await page.locator("[data-test=\"login-button\"], [data-testid=\"login-button\"]").click()
  })
}
