import { test } from '@playwright/test'

test.use({ testIdAttribute: "data-test" })

test("Checkout", async ({ page }) => {
  // Go to https://shop.test/
  await page.goto("https://shop.test/")

  // Type "4111" into Card number
  await page.frameLocator("iframe[name=\"checkout\"]").getByTestId('card').fill("4111")

  // Click Pay
  await page.frameLocator("iframe[src$=\"/widget\"]").getByRole('button', { name: 'Pay' }).click()
})
