import { test, expect } from '@playwright/test'
import { ShopPage } from './pages/ShopPage'

// Base URL — override per environment in CI with the BASE_URL env var.
test.use({ baseURL: process.env.BASE_URL || "https://shop.test" })

test("Shop", async ({ page }) => {
  const app = new ShopPage(page)
  await app.goto()
  const tab1 = await app.openHelp()
  await expect(tab1.helpCentre).toHaveText("Help centre")
  await tab1.contactUs()
  await tab1.page.close()
  await app.pay()
})
