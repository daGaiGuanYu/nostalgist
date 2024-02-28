import { expect, test } from '@playwright/test'

test.describe('static methods with retroarch esm', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/test-page/esm.html')
  })

  test('launch nes', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('nes', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await expect(canvas).toHaveScreenshot('launch-nes.png')
  })

  test('launch megadrive', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('megadrive', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await expect(canvas).toHaveScreenshot('launch-megadrive.png')
  })

  test('launch gbc', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('gbc', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await expect(canvas).toHaveScreenshot('launch-gbc.png')
  })

  test('launch size', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('launchSize', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    await expect(canvas).toHaveScreenshot('launch-size.png')
  })

  test('launch with a crt shader', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('launchShader', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await canvas.click()
    await page.waitForTimeout(2000)
    await expect(canvas).toHaveScreenshot('launch-shader.png')
  })

  test('launch and cancel', async ({ page }) => {
    const canvas = page.locator('#canvas')
    await expect(canvas).not.toBeAttached()

    await page.getByText('launchAndCancel', { exact: true }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await expect(canvas).not.toBeAttached()
  })
})
