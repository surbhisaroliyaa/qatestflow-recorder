import { type Page, type Locator } from '@playwright/test'

export class LoginPage {
  readonly page: Page
  readonly usernameInput: Locator
  readonly passwordInput: Locator
  readonly loginButton: Locator
  readonly products: Locator

  constructor(page: Page) {
    this.page = page
    this.usernameInput = page.getByTestId('username')
    this.passwordInput = page.getByTestId('password')
    this.loginButton = page.getByTestId('login-button')
    this.products = page.getByText('Products')
  }

  async goto(): Promise<void> {
    await this.page.goto("/")
  }

  async login(): Promise<void> {
    await this.usernameInput.fill("standard_user")
    await this.passwordInput.fill(process.env.PASSWORD ?? '') // password field — set the PASSWORD env var
    await this.loginButton.click()
  }
}
