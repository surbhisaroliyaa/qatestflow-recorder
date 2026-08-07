import { type Page, type Locator } from '@playwright/test'

export class ShopPopup1Page {
  readonly page: Page
  readonly helpCentre: Locator
  readonly contactUsButton: Locator

  constructor(page: Page) {
    this.page = page
    this.helpCentre = page.locator("[data-test=\"help-heading\"], [data-testid=\"help-heading\"]")
    this.contactUsButton = page.locator("[data-test=\"contact-us\"], [data-testid=\"contact-us\"]")
  }

  async contactUs(): Promise<void> {
    await this.contactUsButton.click()
  }
}
