import { type Page, type Locator, type FrameLocator } from '@playwright/test'

export class ShopPage {
  readonly page: Page
  readonly checkoutFrame: FrameLocator
  readonly openHelpButton: Locator
  readonly cardNumberInput: Locator
  readonly payButton: Locator

  constructor(page: Page) {
    this.page = page
    this.checkoutFrame = page.frameLocator("iframe[name=\"checkout\"]")
    this.openHelpButton = page.locator("[data-test=\"open-help\"], [data-testid=\"open-help\"]")
    this.cardNumberInput = this.checkoutFrame.locator("[data-test=\"card\"], [data-testid=\"card\"]")
    this.payButton = this.checkoutFrame.locator("[data-test=\"pay\"], [data-testid=\"pay\"]")
  }

  async goto(): Promise<void> {
    await this.page.goto("/")
  }

  async openHelp(): Promise<ShopTab1Page> {
    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page'),
      this.openHelpButton.click()
    ])
    return new ShopTab1Page(popup)
  }

  async pay(): Promise<void> {
    await this.cardNumberInput.fill("4111")
    await this.payButton.click()
  }
}

export class ShopTab1Page {
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
