import { test, expect } from '@playwright/test'
import { LoginPage } from './pages/LoginPage'

// Base URL — override per environment in CI with the BASE_URL env var.
test.use({ baseURL: process.env.BASE_URL || "https://www.saucedemo.com", testIdAttribute: "data-test" })

test("Login", async ({ page }) => {
  const app = new LoginPage(page)
  await app.goto()
  await app.login()
  await expect(app.products).toBeVisible()
})
