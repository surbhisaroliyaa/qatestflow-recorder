import { test, expect } from '@playwright/test'

test("Banner", async ({ page }) => {
  // Go to https://shop.test/
  await page.goto("https://shop.test/")

  // 🔁 Repeat 3 times
  for (let i0 = 0; i0 < 3; i0++) {

    // 🔀 If "element" is visible
    if ((await page.getByText('Cookie banner').isVisible().catch(() => false))) {

      // Click Accept
      await page.getByRole('button', { name: 'Accept' }).click()

    } else {

      // Click Skip
      await page.getByRole('button', { name: 'Skip' }).click()

    }

  }

  // Check Done is visible
  await expect(page.getByText('Done')).toBeVisible()
})
