import { test, expect } from '@playwright/test'

test("Two tabs", async ({ page }) => {
  const page0 = page
  const context = page.context()

  // Go to https://shop.test/
  await page0.goto("https://shop.test/")

  // Click Open help
  const [page1] = await Promise.all([
    context.waitForEvent('page'),
    page0.getByRole('link', { name: 'Open help' }).click()
  ])

  // Check Help is visible
  await expect(page1.getByText('Help')).toBeVisible()

  // Close tab 1
  await page1.close()

  // Click Cart
  await page0.locator("[data-test=\"cart\"], [data-testid=\"cart\"]").click()
})
