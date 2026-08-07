import { test, expect } from '@playwright/test'
import { ShopPage } from './pages/ShopPage'

// Base URL — override per environment in CI with the BASE_URL env var.
test.use({ baseURL: process.env.BASE_URL || "https://shop.test" })

test("Shop", async ({ page }) => {
  const app = new ShopPage(page)
  await app.goto()
  const popup1 = await app.openHelp()
  await expect(popup1.helpCentre).toHaveText("Help centre")
  await popup1.contactUs()
  await popup1.page.close()
  await app.pay()
})
