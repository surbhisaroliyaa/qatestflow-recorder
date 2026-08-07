import { test, expect } from '@playwright/test'

// Base URL — override per environment in CI with the BASE_URL env var.
test.use({ baseURL: process.env.BASE_URL || "https://www.saucedemo.com", testIdAttribute: "data-test" })

test("Login", async ({ page }) => {
  // Go to https://www.saucedemo.com/
  await page.goto("/")

  // Type "standard_user" into Username
  await page.getByTestId('username').fill("standard_user")

  // Type "••••••••" into Password
  await page.getByTestId('password').fill(process.env.PASSWORD ?? '') // password field — set the PASSWORD env var

  // Click Login
  await page.getByTestId('login-button').click()

  // Check Products is visible
  await expect(page.getByText('Products')).toBeVisible()
})
