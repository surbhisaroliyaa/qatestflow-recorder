import { type Page, type Locator, type FrameLocator } from '@playwright/test'
import { ShopPopup1Page } from './ShopPopup1Page'

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

  async openHelp(): Promise<ShopPopup1Page> {
    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page'),
      this.openHelpButton.click()
    ])
    return new ShopPopup1Page(popup)
  }

  async pay(): Promise<void> {
    await this.cardNumberInput.fill("4111")
    await this.payButton.click()
  }
}
